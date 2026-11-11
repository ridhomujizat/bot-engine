import { test, expect, type Page } from '@playwright/test'
import { BOT, api, botApi, signIn } from './support'

// Editor feedback round 2: terminal pills open their flow, the emulator stays open across flows
// (with a follow switch), transitions reorder by drag or keyboard and the order is saved, and the
// run path of the emulator is drawn animated. Writes flows: runs only with E2E_EDITOR_WRITE=1, and
// each test works in its own flows, which it deletes afterwards.
const WRITE = process.env.E2E_EDITOR_WRITE === '1'
test.skip(!WRITE, 'writes flows: set E2E_EDITOR_WRITE=1 on a disposable bot')

type Next = { condition: string; node: string }
type View = {
  name: string
  startNode: string
  nodes: { id: string; name: string; onEnter?: unknown; onReceive?: unknown; next: Next[]; x: number; y: number }[]
  [key: string]: unknown
}

let seq = 0
const uniq = () => `fb2-${Date.now().toString(36)}-${seq++}`
const created: string[] = []

function flowOf(name: string, nodes: { name: string; next?: Next[] }[]): View {
  return {
    version: '0.0.1',
    catchAll: { onReceive: [], next: [] },
    startNode: nodes[0].name,
    name,
    location: name,
    nodes: nodes.map((n, i) => ({ id: `id-${n.name}`, name: n.name, onEnter: [], onReceive: null, next: n.next ?? [], x: 120 + i * 320, y: 160 })),
    links: [],
  }
}

async function makeFlow(name: string, nodes: { name: string; next?: Next[] }[]): Promise<string> {
  const file = `${name}.flow.json`
  await api('POST', botApi('/flows'), { flow: flowOf(file, nodes) })
  created.push(file)
  return file
}

async function readFlow(file: string): Promise<View> {
  const flows = await api<View[]>('GET', botApi('/flows'))
  const found = flows.find((f) => f.name === file)
  if (!found) throw new Error(`no flow ${file}`)
  return found
}

/** Sends one text in the emulator and waits for the converse reply. */
async function say(page: Page, text: string) {
  const reply = page.waitForResponse((r) => r.url().includes('/converse/') && r.request().method() === 'POST')
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text)
  await page.getByRole('button', { name: 'Send message' }).click()
  await reply
}

/** The flow tree shows a flow without its `.flow.json` suffix. */
const treeLabel = (file: string) => file.replace(/\.flow\.json$/, '')

async function openEditor(page: Page, query: string) {
  await signIn(page)
  await page.goto(`/studio/bots/${BOT}/flows?${query}`)
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
}

test.afterAll(async () => {
  for (const file of created) await api('POST', botApi(`/flows/${encodeURIComponent(file)}/delete`), {}).catch(() => undefined)
})

test('a terminal pill opens its flow and selects its node; END and return do not navigate', async ({ page }) => {
  const target = await makeFlow(uniq(), [{ name: 'target' }])
  const from = await makeFlow(uniq(), [
    { name: 'entry', next: [{ condition: 'to-target', node: `${target}#target` }, { condition: 'stop', node: 'END' }, { condition: 'back', node: '#' }] },
  ])
  await openEditor(page, `flow=${encodeURIComponent(from)}`)

  const pill = page.getByRole('button', { name: `Open flow ${target}#target` })
  await expect(pill).toBeVisible()
  await expect(page.getByRole('button', { name: /Open flow (END|#)/ })).toHaveCount(0)
  await pill.click()
  await expect(page).toHaveURL(new RegExp(`flow=${target.replace('.', '\\.')}`))
  await expect(page.getByLabel('Node name')).toHaveValue('target')
  await expect(page.locator('.react-flow__node[data-id="id-target"]')).toHaveClass(/selected/)

  // Keyboard: Enter on the focused pill navigates back.
  await page.goto(`/studio/bots/${BOT}/flows?flow=${encodeURIComponent(from)}`)
  const back = page.getByRole('button', { name: `Open flow ${target}#target` })
  await back.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`flow=${target.replace('.', '\\.')}`))
})

test('the emulator stays open across flows, and the follow switch decides whether the editor follows a reply', async ({ page }) => {
  const other = await makeFlow(uniq(), [{ name: 'entry' }])
  await openEditor(page, 'flow=main.flow.json&emulator=1')
  const panel = page.locator('aside').filter({ has: page.getByRole('button', { name: 'Reset emulator session' }) })
  await expect(panel).toBeVisible()
  await say(page, 'halo')
  await expect(panel.getByText('halo', { exact: true })).toBeVisible()

  // Switching flow keeps the emulator and its conversation.
  await page.getByText(treeLabel(other), { exact: true }).first().click()
  await expect(page).toHaveURL(new RegExp(`flow=${other.replace('.', '\\.')}`))
  await expect(panel).toBeVisible()
  await expect(panel.getByText('halo', { exact: true })).toBeVisible()

  // Follow on (default): the next reply opens the flow the conversation is on (main).
  const follow = panel.getByLabel('Follow conversation')
  await expect(follow).toBeChecked()
  await say(page, 'x')
  await expect(page).toHaveURL(/flow=main\.flow\.json/)
  await expect(panel).toBeVisible()

  // Follow off: the editor stays on the flow the user opened.
  await follow.click()
  await expect(follow).not.toBeChecked()
  await page.getByText(treeLabel(other), { exact: true }).first().click()
  await expect(page).toHaveURL(new RegExp(`flow=${other.replace('.', '\\.')}`))
  await say(page, 'x')
  await expect(panel.getByText('x', { exact: true }).first()).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`flow=${other.replace('.', '\\.')}`))
  await follow.click()
})

test('transitions reorder by mouse drag and by keyboard, and the new order is saved', async ({ page }) => {
  const file = await makeFlow(uniq(), [
    {
      name: 'entry',
      next: [
        { condition: 'c1', node: 'END' },
        { condition: 'c2', node: '#' },
        { condition: 'c3', node: 'END' },
      ],
    },
  ])
  await openEditor(page, `flow=${encodeURIComponent(file)}`)
  await page.locator('.react-flow__node[data-id="id-entry"]').locator('span.truncate').first().click()
  await page.getByRole('tab', { name: 'Transitions' }).click()
  const rows = page.getByRole('list', { name: 'Transitions' }).getByRole('listitem')
  await expect(rows).toHaveCount(3)

  // Mouse: drag row 1 down past row 3.
  const grip = page.getByRole('button', { name: 'Drag to reorder row 1' })
  const from = await grip.boundingBox()
  const to = await rows.nth(2).boundingBox()
  if (!from || !to) throw new Error('no boxes')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 10, { steps: 4 })
  await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2 + 6, { steps: 12 })
  await page.mouse.up()
  await expect(rows.nth(0)).toContainText('c2')
  await expect(rows.nth(2)).toContainText('c1')
  await eventuallySaved(page, file, ['c2', 'c3', 'c1'])

  // Keyboard: focus row 1 (c2), Space picks it up, ArrowDown twice, Space drops it.
  await page.getByRole('button', { name: 'Drag to reorder row 1' }).focus()
  await page.keyboard.press('Space')
  await page.waitForTimeout(150)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(150)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(150)
  await page.keyboard.press('Space')
  await expect(rows.nth(2)).toContainText('c2')
  await eventuallySaved(page, file, ['c3', 'c1', 'c2'])

  // The output ports follow the order: the node's pills are drawn in transition order.
  const ports = await page.locator('.react-flow__node[data-id="id-entry"] .react-flow__handle[data-handleid^="t"]').evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).dataset.handleid),
  )
  expect(ports).toEqual(['t0', 't1', 't2'])
  // Port 0 (drawn highest) is now the transition that was moved first: c2 sits at the top.
  await expect(page.locator('.react-flow__node[data-id="id-entry"]')).toContainText('c3')
})

async function eventuallySaved(page: Page, file: string, order: string[]) {
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect
    .poll(async () => (await readFlow(file)).nodes.find((n) => n.name === 'entry')?.next.map((t) => t.condition), { timeout: 10_000 })
    .toEqual(order)
}

/**
 * The emulator's stack holds the nodes of one reply. A reply that walks several nodes (entry, echo,
 * entry) needs `echo` not to wait for the user: set its onReceive to null for the test, then back to [].
 */
async function echoWaits(wait: boolean) {
  const flows = await api<View[]>('GET', botApi('/flows'))
  const main = flows.find((f) => f.name === 'main.flow.json')
  const echo = main?.nodes.find((n) => n.name === 'echo')
  if (!main || !echo) throw new Error('synthetic bot has no main/echo')
  echo.onReceive = wait ? [] : null
  await api('POST', botApi('/flows/main.flow.json'), { flow: main })
}

test('the run path of the emulator is drawn green and animated', async ({ page }) => {
  await echoWaits(false)
  try {
    await openEditor(page, 'flow=main.flow.json&emulator=1')
    await say(page, 'x')
    await say(page, 'x')
    const recent = page.locator('.react-flow__edge path.run-edge-recent')
    await expect(recent).toHaveCount(1)
    await expect(page.locator('.react-flow__edge path.run-edge').first()).toBeVisible()
    expect(await recent.evaluate((el) => getComputedStyle(el).animationName)).toBe('run-edge-flow')
  } finally {
    await echoWaits(true)
  }
})

test('reduced motion: the run path keeps its colour and does not animate', async ({ page }) => {
  await echoWaits(false)
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openEditor(page, 'flow=main.flow.json&emulator=1')
    await say(page, 'x')
    await say(page, 'x')
    const recent = page.locator('.react-flow__edge path.run-edge-recent')
    await expect(recent).toHaveCount(1)
    expect(await recent.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    expect(await recent.evaluate((el) => getComputedStyle(el).stroke)).toBe('rgb(22, 163, 74)')
  } finally {
    await echoWaits(true)
  }
})
