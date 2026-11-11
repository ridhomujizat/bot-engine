import { test, expect, type Page } from '@playwright/test'
import { BOT, signIn } from './support'

// Rows inside a node card are buttons: a click opens the node's properties on the right tab and the
// row's dialog. A press that drags the node opens nothing. Writes to the bot's main flow: run it only
// against the disposable e2e bot (like editor-panel.spec.ts).

async function openMain(page: Page) {
  await signIn(page)
  await page.goto(`/studio/bots/${BOT}/flows?flow=main.flow.json`)
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
}

async function dropFromPalette(page: Page, label: 'Node', at: { x: number; y: number }) {
  const pane = page.locator('.react-flow__pane')
  const box = await pane.boundingBox()
  if (!box) throw new Error('no pane')
  await page.getByText(label, { exact: true }).first().dragTo(pane, { targetPosition: { x: at.x - box.x, y: at.y - box.y } })
}

const panel = (page: Page) => page.getByText('Node properties')
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })

test('node card rows: a click opens the panel on the right tab and the row dialog', async ({ page }) => {
  await openMain(page)
  await dropFromPalette(page, 'Node', { x: 1180, y: 300 })
  await expect(panel(page)).toBeVisible()

  // Add a say action with a new text element, so the card has a row to click.
  await page.getByRole('button', { name: 'Add action' }).click()
  await page.getByLabel('Message', { exact: true }).fill('Halo baris klik')
  await page.getByRole('button', { name: 'Add action (Alt+Enter)' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()

  await page.getByRole('button', { name: 'Close properties' }).click()
  await expect(panel(page)).toHaveCount(0)
  const card = page.locator('.react-flow__node').filter({ hasText: 'Halo baris klik' }).first()

  // A row click selects the node, opens its properties on On enter and the row's edit dialog.
  const row = card.getByRole('button', { name: /Open action Text · Halo baris klik/ })
  await row.hover()
  await row.click()
  await expect(panel(page)).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Edit action' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  // The panel's tabs are checked once the dialog is closed: an open modal hides the page from roles.
  await expect(tab(page, 'On enter')).toHaveAttribute('aria-selected', 'true')

  // The empty On receive row opens that tab, without a dialog.
  await card.getByRole('button', { name: /Not waiting for user input/ }).click()
  await expect(tab(page, 'On receive')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // A transition pill opens the Transitions tab and that transition's dialog.
  await card.getByRole('button', { name: /Open transition Always/ }).click()
  await expect(page.getByRole('dialog', { name: 'Edit transition' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(tab(page, 'Transitions')).toHaveAttribute('aria-selected', 'true')
})

test('node card rows: dragging the node by one of its rows opens nothing', async ({ page }) => {
  await openMain(page)
  await dropFromPalette(page, 'Node', { x: 1240, y: 420 })
  await expect(panel(page)).toBeVisible()
  const name = await page.getByLabel('Node name').inputValue()
  await page.getByRole('button', { name: 'Close properties' }).click()
  await expect(panel(page)).toHaveCount(0)

  const card = page.locator('.react-flow__node').filter({ has: page.getByText(name, { exact: true }) }).first()
  const row = card.getByRole('button', { name: /Not waiting for user input/ })
  const box = await row.boundingBox()
  if (!box) throw new Error('no row')
  const sx = box.x + box.width / 2
  const sy = box.y + box.height / 2
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(sx + i * 9, sy + i * 6)
  await page.mouse.up()
  await expect(panel(page)).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(card).toBeVisible()
})
