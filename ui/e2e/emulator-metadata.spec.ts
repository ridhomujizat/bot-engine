import { test, expect, type Page } from '@playwright/test'
import { BOT, signIn } from './support'

// Emulator metadata: client worker shaped, sent with every message. Only e2e-core is driven here.

async function openEmulator(page: Page) {
  await page.goto(`/studio/bots/${BOT}/flows?flow=main.flow.json&emulator=1`)
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
  const panel = page.locator('aside').filter({ has: page.getByRole('button', { name: 'Reset emulator session' }) })
  await expect(panel).toBeVisible()
  return panel
}

test('emulator metadata: quick start, new_session, saved editor, invalid JSON blocks sending', async ({ page }) => {
  await signIn(page)
  const panel = await openEmulator(page)

 // Quick-start chips come from the start node's literal triggers.
  const quick = panel.getByRole('group', { name: 'Quick start' })
  await expect(quick.getByRole('button', { name: 'sub', exact: true })).toBeVisible()

 // First message of a session: new_session true, sent as metadata.
  await quick.getByRole('button', { name: 'sub', exact: true }).click()
  await expect(panel.getByText('Hello, say something', { exact: true })).toBeVisible()
  await panel.getByRole('tab', { name: 'Raw' }).click()
  await expect(panel.locator('pre')).toContainText('"metadata"')
  await expect(panel.locator('pre')).toContainText('"new_session": true')
  await expect(panel.locator('pre')).toContainText('"channel_sources": "whatsapp"')

 // Second message: new_session false.
  await panel.getByRole('textbox', { name: 'Message', exact: true }).fill('sub')
  await panel.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(panel.getByText('In subflow', { exact: true })).toBeVisible()
  await expect(panel.locator('pre')).toContainText('"new_session": false')

 // Metadata editor: invalid JSON is flagged and blocks sending.
  await panel.getByRole('tab', { name: 'Metadata' }).click()
  const editor = panel.getByRole('textbox', { name: 'Emulator metadata JSON' })
  await editor.fill('{"sid": ')
  await expect(panel.getByRole('alert')).toContainText('Invalid JSON')
  await expect(panel.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await expect(quick.getByRole('button', { name: 'sub', exact: true })).toBeDisabled()

 // A valid edit is saved in this browser and survives a reload.
  await editor.fill('{"sid": "e2e-sid-1", "accountId": "e2e-acc", "unique_id": "e2e-acc", "channel_sources": "whatsapp", "new_session": false}')
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await page.reload()
  const reloaded = await openEmulator(page)
  await reloaded.getByRole('tab', { name: 'Metadata' }).click()
  await expect(reloaded.getByRole('textbox', { name: 'Emulator metadata JSON' })).toHaveValue(/e2e-sid-1/)
  expect(await page.evaluate(() => window.localStorage.getItem(`bot-engine.emulatorMetadata.${'e2e-core'}`))).toContain('e2e-sid-1')

 // The saved sid is what the bot receives; the first message after reload is a new session.
  await reloaded.getByRole('textbox', { name: 'Message', exact: true }).fill('hello')
  await reloaded.getByRole('button', { name: 'Send message', exact: true }).click()
  await reloaded.getByRole('tab', { name: 'Raw' }).click()
  await expect(reloaded.locator('pre')).toContainText('"sid": "e2e-sid-1"')
  await expect(reloaded.locator('pre')).toContainText('"new_session": true')
})
