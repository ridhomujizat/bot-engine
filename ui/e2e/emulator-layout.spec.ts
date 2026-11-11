import { test, expect, type Page } from '@playwright/test'
import { BOT, signIn } from './support'

// Emulator layout: the conversation is the main area, details are a collapsed bottom drawer, quick
// start is collapsible, and no horizontal scroll appears in the panel.

async function openEmulator(page: Page) {
  await signIn(page)
  await page.goto(`/studio/bots/${BOT}/flows?flow=main.flow.json&emulator=1`)
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
  const panel = page.locator('aside').filter({ has: page.getByRole('button', { name: 'Reset emulator session' }) })
  await expect(panel).toBeVisible()
  return panel
}

test('emulator layout: drawer is collapsed by default and a tab opens it', async ({ page }) => {
  const panel = await openEmulator(page)
  const toggle = panel.getByRole('button', { name: 'Show details' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(panel.getByRole('tab', { name: 'Raw' })).toBeVisible()
  await expect(panel.locator('pre')).toHaveCount(0)

  await panel.getByRole('tab', { name: 'Raw' }).click()
  await expect(panel.locator('pre')).toContainText('"state"')
  await expect(panel.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true')

  // Hiding it again keeps the tabs and drops the content.
  await panel.getByRole('button', { name: 'Hide details' }).click()
  await expect(panel.locator('pre')).toHaveCount(0)
  await expect(panel.getByRole('tab', { name: 'Raw' })).toBeVisible()
})

test('emulator layout: quick start toggles, bubbles stay narrow, no horizontal scroll', async ({ page }) => {
  const panel = await openEmulator(page)
  const group = panel.getByRole('group', { name: 'Quick start' })
  await expect(group.getByRole('button', { name: 'sub', exact: true })).toBeVisible()

  await panel.getByRole('button', { name: 'Quick start' }).click()
  await expect(group).toHaveCount(0)
  await panel.getByRole('button', { name: 'Quick start' }).click()
  await expect(group).toBeVisible()

  await group.getByRole('button', { name: 'sub', exact: true }).click()
  const reply = panel.getByText('Hello, say something', { exact: true })
  await expect(reply).toBeVisible()
  // Timestamps are shown next to messages.
  await expect(panel.locator('time').first()).toBeVisible()

  // Bot bubbles stay within about 80% of the panel width, and the panel never scrolls sideways.
  const box = await panel.boundingBox()
  const bubble = await reply.boundingBox()
  if (!box || !bubble) throw new Error('no layout box')
  expect(bubble.width).toBeLessThanOrEqual(box.width * 0.82)
  const overflow = await panel.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})
