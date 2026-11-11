import { test, expect, type Page } from '@playwright/test'
import { BOT, SHOTS, botFileHashes, signIn } from './support'
import { join } from 'node:path'

// Edge style is a per-browser view setting. Nothing here may change a saved file, and nothing here
// may send an emulator or converse message .


async function openCanvas(page: Page, bot: string, flow: string) {
  await page.goto(`/studio/bots/${bot}/flows?flow=${encodeURIComponent(flow)}`)
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
  await page.getByRole('button', { name: 'Fit view' }).click()
}

function edgeStyleGroup(page: Page) {
  return page.getByRole('group', { name: 'Edges: Straight / Orthogonal' })
}

test('edge style: toggle applies at once, persists per browser, changes no saved file', async ({ page }) => {
  await signIn(page)
  const before = botFileHashes()
  await openCanvas(page, BOT, 'main.flow.json')

  const straight = edgeStyleGroup(page).getByRole('button', { name: 'Straight', exact: true })
  const orthogonal = edgeStyleGroup(page).getByRole('button', { name: 'Orthogonal', exact: true })
  await expect(orthogonal).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-edge-style="orthogonal"]').first()).toBeVisible()

  await straight.click()
  await expect(straight).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-edge-style="straight"]').first()).toBeVisible()
  await expect(page.locator('[data-edge-style="orthogonal"]')).toHaveCount(0)
 // Straight edges are single segments: no quadratic corners in any edge path.
  const curves = await page.locator('[data-edge-style="straight"] path').evaluateAll((ps) =>
    ps.filter((p) => (p.getAttribute('d') ?? '').includes('Q')).length,
  )
  expect(curves).toBe(0)
  await page.screenshot({ path: join(SHOTS, 'edges-straight-e2e-core.png') })

 // Stored per browser: survives a reload.
  await page.reload()
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
  await expect(edgeStyleGroup(page).getByRole('button', { name: 'Straight', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => window.localStorage.getItem('bot-engine.edgeStyle'))).toBe('straight')

  await edgeStyleGroup(page).getByRole('button', { name: 'Orthogonal', exact: true }).click()
  await expect(page.locator('[data-edge-style="orthogonal"]').first()).toBeVisible()

 // No flow became dirty and no file changed.
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  expect(botFileHashes()).toEqual(before)
})
