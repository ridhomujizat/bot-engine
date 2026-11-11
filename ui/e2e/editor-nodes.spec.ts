import { test, expect, type Page } from '@playwright/test'
import { BOT, api, ensureChoiceQuestion, signIn } from './support'

// Node creation and rendering against legacy (see docs/editor-parity.md). Drops and edits stay in the
// browser unless E2E_EDITOR_WRITE=1, which also saves: only run that against a disposable bot.
const WRITE = process.env.E2E_EDITOR_WRITE === '1'

async function openFlow(page: Page, flow: string) {
  await signIn(page)
  await page.goto(`/studio/bots/${BOT}/flows?flow=${encodeURIComponent(flow)}`)
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
}

/** Drag a palette item ("Node" or "Choice") onto the canvas at a point inside the pane. */
async function dropFromPalette(page: Page, label: 'Node' | 'Choice', at: { x: number; y: number }) {
  const pane = page.locator('.react-flow__pane')
  const box = await pane.boundingBox()
  if (!box) throw new Error('no pane')
  await page.getByText(label, { exact: true }).first().dragTo(pane, { targetPosition: { x: at.x - box.x, y: at.y - box.y } })
}

function nodeWith(page: Page, text: string) {
  return page.locator('.react-flow__node').filter({ hasText: text })
}

test('a new standard node is a full node: named node-xxxx, all three sections, one open transition', async ({ page }) => {
  await openFlow(page, 'main.flow.json')
  const before = await page.locator('.react-flow__node').count()
  await dropFromPalette(page, 'Node', { x: 700, y: 700 })

  await expect(page.locator('.react-flow__node')).toHaveCount(before + 1)
  const node = nodeWith(page, 'Standard node').filter({ hasText: /node-[0-9a-f]{4}/ }).first()
  await expect(node).toBeVisible()
  const name = (await node.locator('span.truncate').first().innerText()).trim()
  expect(name).toMatch(/^node-[0-9a-f]{4}$/)

 // Every section is drawn, even the empty ones.
  for (const section of ['On enter', 'On receive', 'Transitions']) {
    await expect(node.getByText(section, { exact: true })).toBeVisible()
  }
 // legacy default: one transition, condition "true", target empty. It is an open port, not an End pill.
  await expect(node.getByText('Always', { exact: true })).toBeVisible()
  await expect(node.getByText('not connected')).toBeVisible()
  await expect(node.getByText('End flow')).toHaveCount(0)
})

test('a choice node is named choice-xxxxxx and its transitions show legacy captions, not raw conditions', async ({ page }) => {
  test.skip(!WRITE, 'creates a skill flow: set E2E_EDITOR_WRITE=1 on a disposable bot')
  await ensureChoiceQuestion()

  await openFlow(page, 'main.flow.json')
  await dropFromPalette(page, 'Choice', { x: 700, y: 600 })
  await page.getByRole('button', { name: 'Insert' }).click()

  const node = nodeWith(page, 'Skill').filter({ hasText: /choice-[0-9a-f]{6}/ }).first()
  await expect(node).toBeVisible()
 // The title renders after the node (the header is filled in a moment later): wait for the text itself.
  const title = node.getByText(/^choice-[0-9a-f]{6}$/).first()
  await expect(title).toBeVisible()
  const name = (await title.innerText()).trim()
  expect(name).toMatch(/^choice-[0-9a-f]{6}$/)
  await expect(node.getByText('User picked', { exact: false }).first()).toBeVisible()
  await expect(node.getByText('On failure', { exact: true })).toBeVisible()
  await expect(node.getByText(/^temp\[/)).toHaveCount(0)
  await expect(node.getByText('End flow')).toHaveCount(0)
})

test('dragged nodes land on the 5-unit grid and save as integers (standard and choice alike)', async ({ page }) => {
  test.skip(!WRITE, 'saves the flow: set E2E_EDITOR_WRITE=1 on a disposable bot')
  await openFlow(page, 'main.flow.json')
  const targets = ['skill-186113', 'eebdc6f382']
  for (const id of targets) {
    const el = page.locator(`.react-flow__node[data-id="${id}"]`)
    if ((await el.count()) === 0) continue
    const box = await el.boundingBox()
    if (!box) continue
    const sx = box.x + box.width / 2
    const sy = box.y + 12
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) await page.mouse.move(sx + i * 11, sy + i * 7)
    await page.mouse.up()
  }
 // Autosave: the flow saves by itself; wait for the saved state.
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()

  const flow = (await api<{ name: string; nodes: { id: string; x: number; y: number }[] }[]>('GET', `/api/v1/studio/${BOT}/flows`)).find((f) => f.name === 'main.flow.json')
  for (const id of targets) {
    const n = flow?.nodes.find((x) => x.id === id)
    if (!n) continue
    expect(Number.isInteger(n.x)).toBe(true)
    expect(Number.isInteger(n.y)).toBe(true)
    expect(Math.abs(n.x % 5)).toBe(0)
    expect(Math.abs(n.y % 5)).toBe(0)
  }
})
