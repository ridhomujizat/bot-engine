import { test, expect, type Locator, type Page } from '@playwright/test'
import { BOT, api, botApi, signIn } from './support'

// A new node is selected and its properties panel opens, whichever way it was created (legacy sets
// currentFlowNode on every creation). Each test also checks the node reached the saved flow.
// Writes to the bot's main flow: run it only against the disposable e2e bot.

async function openMain(page: Page) {
  await signIn(page)
  await page.goto(`/studio/bots/${BOT}/flows?flow=main.flow.json`)
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
}

/** The canvas node whose title is `name`. */
function nodeByName(page: Page, name: string): Locator {
  return page.locator('.react-flow__node').filter({ has: page.getByText(name, { exact: true }) }).first()
}

async function dropFromPalette(page: Page, label: 'Node' | 'Choice', at: { x: number; y: number }) {
  const pane = page.locator('.react-flow__pane')
  const box = await pane.boundingBox()
  if (!box) throw new Error('no pane')
  await page.getByText(label, { exact: true }).first().dragTo(pane, { targetPosition: { x: at.x - box.x, y: at.y - box.y } })
}

/** Asserts the node is selected, its properties panel is open on it, and the saved flow has it. */
async function expectPanelOpenOn(page: Page, nameRe: RegExp): Promise<string> {
  const panel = page.getByLabel('Node name')
  await expect(page.getByText('Node properties')).toBeVisible()
  await expect(panel).toHaveValue(nameRe)
  const name = await panel.inputValue()
  await expect(page.locator('.react-flow__node.selected').filter({ hasText: name })).toHaveCount(1)
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await expect
    .poll(async () => {
      const flows = await api<{ name: string; nodes: { name: string }[] }[]>('GET', botApi('/flows'))
      return flows.find((f) => f.name === 'main.flow.json')?.nodes.some((n) => n.name === name) ?? false
    })
    .toBe(true)
  return name
}

test('panel: a standard node dropped from the palette is selected and its properties open', async ({ page }) => {
  await openMain(page)
  const before = await page.locator('.react-flow__node').count()
  await dropFromPalette(page, 'Node', { x: 760, y: 720 })
  await expect(page.locator('.react-flow__node')).toHaveCount(before + 1)
  await expectPanelOpenOn(page, /^node-[0-9a-f]{4}$/)
})

test('panel: a choice node dropped from the palette is selected and its properties open', async ({ page }) => {
  await api('POST', botApi('/cms/builtin_single-choice/element'), {
    formData: { 'text$en': 'Pilih layanan panel', 'choices$en': [{ title: 'Tagihan', value: 'bill' }, { title: 'Paket', value: 'pkg' }] },
  })
  await openMain(page)
  await dropFromPalette(page, 'Choice', { x: 640, y: 760 })
  const dialog = page.getByRole('dialog', { name: 'Choice skill' })
  await expect(dialog).toBeVisible()
  const value = await page.locator('#choice-question option', { hasText: 'Pilih layanan panel' }).first().getAttribute('value')
  await page.locator('#choice-question').selectOption(value ?? '')
  await page.getByRole('button', { name: 'Insert', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expectPanelOpenOn(page, /^choice-[0-9a-f]{6}$/)
})

test('panel: a standard node created from a dragged port opens its properties', async ({ page }) => {
  await openMain(page)
 // Start from a fresh, unlinked standard node so the port has no transition to reuse.
  await dropFromPalette(page, 'Node', { x: 900, y: 560 })
  const source = nodeByName(page, await expectPanelOpenOn(page, /^node-[0-9a-f]{4}$/))
  await page.getByRole('button', { name: 'Close properties' }).click()
  await expect(page.getByText('Node properties')).toHaveCount(0)

  const handle = source.locator('.react-flow__handle[data-handleid="t0"]')
  const hb = await handle.boundingBox()
  if (!hb) throw new Error('no port handle')
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x - 220, hb.y + 220, { steps: 6 })
  await page.mouse.move(hb.x - 200, hb.y + 260, { steps: 4 })
  await page.mouse.up()
  await page.getByRole('menu', { name: 'Add node' }).getByRole('menuitem', { name: 'Standard node' }).click()
  await expectPanelOpenOn(page, /^node-[0-9a-f]{4}$/)
})

test('panel: a choice skill created from a dragged port opens its properties', async ({ page }) => {
  await openMain(page)
  await dropFromPalette(page, 'Node', { x: 1000, y: 620 })
  const source = nodeByName(page, await expectPanelOpenOn(page, /^node-[0-9a-f]{4}$/))
  await page.getByRole('button', { name: 'Close properties' }).click()

  const handle = source.locator('.react-flow__handle[data-handleid="t0"]')
  const hb = await handle.boundingBox()
  if (!hb) throw new Error('no port handle')
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x - 240, hb.y + 240, { steps: 6 })
  await page.mouse.move(hb.x - 220, hb.y + 280, { steps: 4 })
  await page.mouse.up()
  await page.getByRole('menu', { name: 'Add node' }).getByRole('menuitem', { name: 'Choice skill' }).click()
  const dialog = page.getByRole('dialog', { name: 'Choice skill' })
  await expect(dialog).toBeVisible()
  await page.getByRole('button', { name: 'Insert', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expectPanelOpenOn(page, /^choice-[0-9a-f]{6}$/)
})

test('panel: a pasted node is selected and its properties open', async ({ page }) => {
  await openMain(page)
 // Copy a node dropped in view: an existing node may sit off the visible canvas.
  await dropFromPalette(page, 'Node', { x: 1100, y: 640 })
  const original = await expectPanelOpenOn(page, /^node-[0-9a-f]{4}$/)
  await nodeByName(page, original).locator('span.truncate').first().click()
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  const copy = await expectPanelOpenOn(page, new RegExp(`^${original}-copy(-\\d+)?$`))
  expect(copy).not.toBe(original)
})
