import { test, expect, type Page } from '@playwright/test'
import { BOT, api, botApi, ensureChoiceQuestion, signIn } from './support'

// Editing behaviour against legacy (docs/editor-parity.md). Writes to the bot, so it runs only with
// E2E_EDITOR_WRITE=1, and each test works in its own throwaway flow that it deletes afterwards.
const WRITE = process.env.E2E_EDITOR_WRITE === '1'
test.skip(!WRITE, 'writes flows: set E2E_EDITOR_WRITE=1 on a disposable bot')

type View = {
  name: string
  version?: string
  location?: string
  startNode: string
  nodes: { id: string; name: string; type?: string; flow?: string; onEnter?: unknown; onReceive?: unknown; next: { condition: string; node: string }[]; x: number; y: number }[]
  catchAll?: { onReceive: string[] | null; next: { condition: string; node: string }[] }
  /** The saved flow carries more keys (links, currentMutex, skillData): not all are typed here. */
  [key: string]: unknown
}

let seq = 0
const flowName = () => `parity-beh-${Date.now().toString(36)}-${seq++}.flow.json`
const created: string[] = []
/** Skill flow files a test created: deleted in afterAll if still there. */
const cleanup: string[] = []

/** A flow with entry -> other, `entry` the start node. Positions are fixed so the test can point at them. */
function viewOf(name: string): View {
  return {
    version: '0.0.1',
    catchAll: { onReceive: [], next: [] },
    startNode: 'entry',
    name,
    location: name,
    nodes: [
      { id: 'entry', name: 'entry', onEnter: [], onReceive: null, next: [{ condition: 'true', node: 'other' }], x: 200, y: 200 },
      { id: 'other', name: 'other', onEnter: [], onReceive: null, next: [{ condition: 'true', node: '' }], x: 620, y: 200 },
    ],
    links: [],
  }
}

async function makeFlow(): Promise<string> {
  const name = flowName()
  await api('POST', botApi('/flows'), { flow: viewOf(name) })
  created.push(name)
  return name
}

async function readFlow(name: string): Promise<View> {
  const flows = await api<View[]>('GET', botApi('/flows'))
  const found = flows.find((f) => f.name === name)
  if (!found) throw new Error(`no flow ${name}`)
  return found
}

/** Polls until `check` holds (autosave runs within about a second of an edit). */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, timeout = 8000): Promise<T> {
  const until = Date.now() + timeout
  let value = await read()
  while (!check(value) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 300))
    value = await read()
  }
  expect(check(value)).toBe(true)
  return value
}

async function openFlow(page: Page, name: string) {
  await signIn(page)
  await page.goto(`/studio/bots/${BOT}/flows?flow=${encodeURIComponent(name)}`)
  await expect(page.locator('.react-flow__node[data-id="entry"]')).toBeVisible()
}

function nodeEl(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`)
}

test.afterAll(async () => {
  for (const name of [...created, ...cleanup]) {
    await api('POST', botApi(`/flows/${encodeURIComponent(name)}/delete`), {}).catch(() => undefined)
  }
})

test('edits save by themselves: no Save click, status goes Saving... then Saved', async ({ page }) => {
  const name = await makeFlow()
  await openFlow(page, name)
  await nodeEl(page, 'other').locator('span.truncate').first().click()
  await page.getByText('Set as start node').click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await eventually(() => readFlow(name), (f) => f.startNode === 'other')
})

/** Clicks the middle of the visible stroke of an edge (its bounding box centre may be off the line). */
async function clickEdge(page: Page, edgeId: string) {
  const path = page.locator(`g[data-edge-id="${edgeId}"] path`).nth(1)
  const at = await path.evaluate((el) => {
    const svg = el as SVGPathElement
    const p = svg.getPointAtLength(svg.getTotalLength() / 2)
    const m = svg.getScreenCTM()
    if (!m) throw new Error('no ctm')
    return { x: p.x * m.a + m.e, y: p.y * m.d + m.f }
  })
  await page.mouse.click(at.x, at.y)
}

test('Backspace on a selected link unlinks it; the transition and its port stay', async ({ page }) => {
  const name = await makeFlow()
  await openFlow(page, name)
  await clickEdge(page, 'entry:0')
  await page.keyboard.press('Backspace')
  const after = await eventually(() => readFlow(name), (f) => f.nodes.find((n) => n.id === 'entry')?.next[0]?.node === '')
  expect(after.nodes.find((n) => n.id === 'entry')!.next).toHaveLength(1)
  expect(after.nodes.map((n) => n.id).sort()).toEqual(['entry', 'other'])
})

test('the start node cannot be deleted; legacy message shown and the node stays', async ({ page }) => {
  const name = await makeFlow()
  await openFlow(page, name)
  await nodeEl(page, 'entry').locator('span.truncate').first().click()
  await page.keyboard.press('Delete')
  // The status line (dnd-kit adds its own live region with the same role, hence the text filter).
  await expect(page.getByRole('status').filter({ hasText: "You can't delete the start node." })).toHaveText("You can't delete the start node.")
  await expect(nodeEl(page, 'entry')).toBeVisible()
})

test('a drag does not open the properties; a plain click does', async ({ page }) => {
  const name = await makeFlow()
  await openFlow(page, name)
  const header = nodeEl(page, 'other').locator('span.truncate').first()
  const box = await header.boundingBox()
  if (!box) throw new Error('no box')
  await page.mouse.move(box.x + 4, box.y + 4)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + 4 + i * 12, box.y + 4 + i * 6)
  await page.mouse.up()
  await expect(page.getByText('Node properties')).toHaveCount(0)
 // A click right after a drag is ignored for a moment (see FlowCanvas DRAG_CLICK_WINDOW_MS); a person pauses longer.
  await page.waitForTimeout(500)
  await header.click()
  await expect(page.getByText('Node properties')).toBeVisible()
})

test('Ctrl+C / Ctrl+V pastes x-copy, then x-copy-1, placed as copies', async ({ page }) => {
  const name = await makeFlow()
  await openFlow(page, name)
  await nodeEl(page, 'other').locator('span.truncate').first().click()
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  await eventually(() => readFlow(name), (f) => f.nodes.some((n) => n.name === 'other-copy'))
  await page.keyboard.press('Control+v')
  const flow = await eventually(() => readFlow(name), (f) => f.nodes.some((n) => n.name === 'other-copy-1'))
  const ids = new Set(flow.nodes.map((n) => n.id))
  expect(ids.size).toBe(flow.nodes.length)
})

test('the flow-wide bar opens the flow properties', async ({ page }) => {
  const name = await makeFlow()
  await openFlow(page, name)
  await page.getByRole('button', { name: /flow-wide transitions/ }).click()
  await expect(page.getByText('Flow-wide', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Transitions' }).click()
  await expect(page.getByRole('button', { name: 'Add transition' })).toBeVisible()
})

test('dropping a dragged port on empty canvas opens the create menu and links the new node', async ({ page }) => {
  const name = await makeFlow()
  await openFlow(page, name)
 // entry's transition 0 points at other; drag a new link from a port of other (out, unlinked) to empty canvas.
  const handle = nodeEl(page, 'other').locator('.react-flow__handle[data-handleid="t0"]')
  const hb = await handle.boundingBox()
  if (!hb) throw new Error('no handle')
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x - 200, hb.y + 200, { steps: 6 })
  await page.mouse.move(hb.x - 180, hb.y + 240, { steps: 4 })
  await page.mouse.up()
  const menu = page.getByRole('menu', { name: 'Add node' })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Standard node' }).click()
  const flow = await eventually(() => readFlow(name), (f) => f.nodes.length === 3)
  const created = flow.nodes.find((n) => n.id !== 'entry' && n.id !== 'other')!
  expect(created.name).toMatch(/^node-[0-9a-f]{4}$/)
  expect(flow.nodes.find((n) => n.id === 'other')!.next[0].node).toBe(created.name)
})

test('a flow can be duplicated from the side panel', async ({ page }) => {
  const name = await makeFlow()
  await openFlow(page, name)
  const base = name.replace(/\.flow\.json$/, '')
 // The row buttons show on hover, so hover the row first.
  await page.getByRole('button', { name: base, exact: true }).hover()
  await page.getByRole('button', { name: `Duplicate ${name}` }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click()
  const copy = `${base}-copy.flow.json`
  created.push(copy)
  await eventually(async () => (await api<View[]>('GET', botApi('/flows'))).map((f) => f.name), (names) => names.includes(copy))
})

/** Drops a palette item at a point inside the pane and returns once the node exists. */
async function dropChoice(page: Page, at: { x: number; y: number }) {
  const pane = page.locator('.react-flow__pane')
  const box = await pane.boundingBox()
  if (!box) throw new Error('no pane')
  await page.getByText('Choice', { exact: true }).first().dragTo(pane, { targetPosition: { x: at.x - box.x, y: at.y - box.y } })
  await page.getByRole('button', { name: 'Insert' }).click()
}

test('editing a choice regenerates its skill flow in the same file and keeps existing targets', async ({ page }) => {
  await ensureChoiceQuestion()
  const name = await makeFlow()
  await openFlow(page, name)
  await dropChoice(page, { x: 700, y: 600 })
  const created = await eventually(() => readFlow(name), (f) => f.nodes.some((n) => n.type === 'skill-call'))
  const skillNode = created.nodes.find((n) => n.type === 'skill-call')!
  const skillFile = skillNode.flow as string
  cleanup.push(skillFile)

 // Point the first transition of the choice at `other` (a drag would do the same; the API keeps the test short).
  await api('POST', botApi(`/flows/${encodeURIComponent(name)}`), { flow: { ...created, nodes: created.nodes.map((n) => (n.id === skillNode.id ? { ...n, next: n.next.map((t, i) => (i === 0 ? { ...t, node: 'other' } : t)) } : n)) } })
  await page.reload()
  await expect(nodeEl(page, skillNode.id)).toBeVisible()
  await nodeEl(page, skillNode.id).locator('span.truncate').first().dblclick()
  await expect(page.getByRole('dialog', { name: 'Edit choice skill' })).toBeVisible()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Edit choice skill' })).toHaveCount(0)

  const after = await eventually(() => readFlow(name), (f) => f.nodes.find((n) => n.id === skillNode.id)?.next.some((t) => t.node === 'other') === true)
  const node = after.nodes.find((n) => n.id === skillNode.id)!
  expect(node.flow).toBe(skillFile)
  expect(node.next[0].node).toBe('other')
  const names = (await api<View[]>('GET', botApi('/flows'))).map((f) => f.name)
  expect(names).toContain(skillFile)
})

test('deleting a node keeps the links that point at it: legacy saves the dangling target, no error', async ({ page }) => {
  const name = await makeFlow()
  await openFlow(page, name)
 // entry links to other. legacy keeps that link when other is deleted; the editor does too (no stripping).
  await nodeEl(page, 'other').locator('span.truncate').first().click()
  await page.keyboard.press('Delete')
  await expect(nodeEl(page, 'other')).toHaveCount(0)
 // A dangling transition target is a warning on the server (studioapi drops warnings on save), so the save goes through.
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  const saved = await readFlow(name)
  expect(saved.nodes.some((n) => n.id === 'other')).toBe(false)
  expect(saved.nodes.find((n) => n.id === 'entry')!.next.some((t) => t.node === 'other')).toBe(true)
})
