import { test, expect, type Locator, type Page } from '@playwright/test'
import { BOT, api, botApi, signIn } from './support'

// Owner decision (2026-11-11): a paste owns the content it copies. The copy's say action names a new
// element with the same formData, so editing the copy leaves the original untouched. Writes to the main
// flow of the disposable e2e bot only.

type Node = { id: string; name: string; onEnter?: string[] | null }
type Element = { id: string; formData: Record<string, unknown> }

async function openMain(page: Page) {
  await signIn(page)
  await page.goto(`/studio/bots/${BOT}/flows?flow=main.flow.json`)
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
}

function nodeByName(page: Page, name: string): Locator {
  return page.locator('.react-flow__node').filter({ has: page.getByText(name, { exact: true }) }).first()
}

async function waitSaved(page: Page) {
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
}

async function mainNodes(): Promise<Node[]> {
  const flows = await api<{ name: string; nodes: Node[] }[]>('GET', botApi('/flows'))
  return flows.find((f) => f.name === 'main.flow.json')?.nodes ?? []
}

async function elements(): Promise<Element[]> {
  const res = await api<Element[] | { elements: Element[] }>('POST', botApi('/cms/elements'), { count: 1000, from: 0 })
  return Array.isArray(res) ? res : res.elements
}

/** The say action's element id of a node's first on-enter action. */
function sayId(node: Node | undefined): string {
  const action = node?.onEnter?.[0] ?? ''
  return action.replace(/^say #!/, '').split(' ')[0]
}

test('paste copies the content: editing the copy leaves the original element unchanged', async ({ page }) => {
  await openMain(page)
  const pane = page.locator('.react-flow__pane')
  const box = await pane.boundingBox()
  if (!box) throw new Error('no pane')
  await page.getByText('Node', { exact: true }).first().dragTo(pane, { targetPosition: { x: 760 - box.x, y: 720 - box.y } })
  await expect(page.getByLabel('Node name')).toBeVisible()
  const name = await page.getByLabel('Node name').inputValue()
  await page.getByRole('button', { name: 'Close properties' }).click()

 // The original: one text action with the text "asli".
  await nodeByName(page, name).locator('span.truncate').first().click()
  await page.getByRole('button', { name: 'Add action' }).first().click()
  let dialog = page.getByRole('dialog')
  await dialog.locator('textarea').first().fill('teks asli')
  await dialog.getByRole('button', { name: /Add action/ }).click()
  await expect(dialog).toBeHidden()
  await waitSaved(page)
  const originalSay = sayId((await mainNodes()).find((n) => n.name === name))
  expect(originalSay).toMatch(/^builtin_text-/)

 // Copy and paste; the properties panel opens on the copy.
  await nodeByName(page, name).locator('span.truncate').first().click()
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  const copyName = new RegExp(`^${name}-copy(-\\d+)?$`)
  await expect(page.getByLabel('Node name')).toHaveValue(copyName)
  await waitSaved(page)
  const copy = (await mainNodes()).find((n) => copyName.test(n.name))
  expect(copy).toBeDefined()
  const copySay = sayId(copy)
  expect(copySay).not.toBe(originalSay)

 // Edit the copy's text through the inspector.
  await page.getByRole('button', { name: 'Edit action' }).first().click()
  dialog = page.getByRole('dialog')
 // An existing say action opens on "Pick existing"; the text is edited on "Create new", which saves the element it names.
  await dialog.getByRole('tab', { name: 'Create new' }).click()
  await dialog.locator('textarea').first().fill('teks copy')
  await dialog.getByRole('button', { name: 'Save action' }).click()
  await expect(dialog).toBeHidden()
  await waitSaved(page)

  const all = await elements()
  const text = (id: string) => String((all.find((e) => e.id === id)?.formData ?? {})['text$en'] ?? '')
  expect(text(originalSay)).toBe('teks asli')
  expect(text(copySay)).toBe('teks copy')
})
