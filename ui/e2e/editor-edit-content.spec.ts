import { test, expect, type Locator, type Page } from '@playwright/test'
import { BOT, api, botApi, chooseOption, signIn } from './support'

// Editing a say action's content in the action dialog. Writes to the main flow of the disposable
// e2e bot: the entry node names a single-choice question for this file, and the main flow is restored
// to its snapshot afterwards so the other specs see the fixture they expect.

type FlowNode = { id: string; name: string; onEnter?: string[] | null; onReceive?: string[] | null; next?: unknown[] }
type FlowView = { name: string; nodes: FlowNode[]; [extra: string]: unknown }
type Element = { id: string; contentType: string; formData: Record<string, unknown>; modifiedOn?: string }

const ORIGINAL_Q = 'Ada yang bisa kami bantu?'
const EDITED_Q = 'Ada yang bisa kami bantu, Kak?'
const CHOICE_TITLE = 'Tagihan & pembayaran'
const COPY_Q = 'Hanya di sini'

let snapshot: FlowView | null = null
let questionId = ''

async function mainFlow(): Promise<FlowView> {
  const flows = await api<FlowView[]>('GET', botApi('/flows'))
  const main = flows.find((f) => f.name === 'main.flow.json')
  if (!main) throw new Error('main.flow.json missing')
  return main
}

async function saveMain(flow: FlowView): Promise<void> {
  await api('POST', botApi('/flows/main.flow.json'), { flow })
}

async function elements(): Promise<Element[]> {
  const res = await api<Element[] | { elements: Element[] }>('POST', botApi('/cms/elements'), { count: 1000, from: 0 })
  return Array.isArray(res) ? res : res.elements
}

function sayIds(node: FlowNode | undefined): string[] {
  return (node?.onEnter ?? []).filter((a) => a.startsWith('say #!')).map((a) => a.replace(/^say #!/, '').split(' ')[0])
}

function nodeOf(flow: FlowView, name: string): FlowNode | undefined {
  return flow.nodes.find((n) => n.name === name)
}

async function openMain(page: Page, query = '') {
  await signIn(page)
  await page.goto(`/studio/bots/${BOT}/flows?flow=main.flow.json${query ? `&${query}` : ''}`)
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
}

function nodeNamed(page: Page, name: string): Locator {
  return page.locator('.react-flow__node').filter({ has: page.getByText(name, { exact: true }) }).first()
}

/** Opens a node's properties and the Edit action dialog of its first say action. */
async function openEditAction(page: Page, node: string) {
  await nodeNamed(page, node).locator('span.truncate').first().click()
  await page.getByRole('button', { name: 'Edit action' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Edit action' })
  await expect(dialog).toBeVisible()
  return dialog
}

async function waitSaved(page: Page) {
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
}

test.beforeAll(async () => {
  snapshot = await mainFlow()
  // A single-choice question with two choices, named by the entry node's say action.
  questionId = await api<string>('POST', botApi('/cms/builtin_single-choice/element'), {
    formData: {
      'text$en': ORIGINAL_Q,
      'choices$en': [
        { title: 'Tagihan', value: 'bill' },
        { title: 'Paket', value: 'pkg' },
      ],
      'isDropdown$en': false,
      'variations$en': ['Ada yang bisa?'],
    },
  })
  const flow = structuredClone(snapshot)
  const entry = nodeOf(flow, 'entry')
  if (!entry) throw new Error('entry node missing')
  entry.onEnter = [`say #!${questionId}`]
  await saveMain(flow)
})

test.afterAll(async () => {
  if (snapshot) await saveMain(snapshot)
})

test('edit a single-choice question and a choice title through the action dialog', async ({ page }) => {
  await openMain(page)
  const dialog = await openEditAction(page, 'entry')

  // The form is visible and prefilled with the stored element.
  await expect(dialog.getByRole('combobox', { name: 'Content element', exact: true })).toContainText(ORIGINAL_Q)
  await expect(dialog.locator('#content-text')).toHaveValue(ORIGINAL_Q)
  await expect(dialog.getByLabel('Choice title').first()).toHaveValue('Tagihan')

  await dialog.locator('#content-text').fill(EDITED_Q)
  await dialog.getByLabel('Choice title').first().fill(CHOICE_TITLE)
  await dialog.getByRole('button', { name: 'Save action', exact: true }).click()
  await expect(dialog).toBeHidden()
  await waitSaved(page)

  // Stored: same id, edited keys changed, keys the form does not render kept.
  const before = await elements()
  const stored = before.find((e) => e.id === questionId)
  expect(stored?.formData['text$en']).toBe(EDITED_Q)
  expect((stored?.formData['choices$en'] as { title: string }[])[0].title).toBe(CHOICE_TITLE)
  expect((stored?.formData['choices$en'] as { title: string }[])[1].title).toBe('Paket')
  expect(stored?.formData['variations$en']).toEqual(['Ada yang bisa?'])
  expect(stored?.formData['isDropdown$en']).toBe(false)

  // The node card shows the new question at once.
  await expect(nodeNamed(page, 'entry')).toContainText('Ada yang bisa kami bantu, Kak?')
  // The action still names the same element.
  expect(sayIds(nodeOf(await mainFlow(), 'entry'))).toEqual([questionId])
})

test('the emulator answers with the edited question and choice', async ({ page }) => {
  await openMain(page, 'emulator=1')
  const panel = page.locator('aside').filter({ has: page.getByRole('button', { name: 'Reset emulator session' }) })
  await expect(panel).toBeVisible()
  await panel.getByRole('textbox', { name: 'Message', exact: true }).fill('hello')
  await panel.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(panel.getByText(EDITED_Q, { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: CHOICE_TITLE, exact: true })).toBeVisible()
})

test('a shared element shows the usage notice; duplicate-and-edit changes only this action', async ({ page }) => {
  // Second usage: the after-sub node also says the question.
  await openMain(page)
  await nodeNamed(page, 'after-sub').locator('span.truncate').first().click()
  await page.getByRole('button', { name: 'Add action', exact: true }).first().click()
  const adder = page.getByRole('dialog', { name: 'Add action' })
  await expect(adder).toBeVisible()
  await chooseOption(page, adder.getByRole('combobox', { name: 'Content element', exact: true }), EDITED_Q)
  await adder.getByRole('button', { name: 'Save action', exact: true }).click()
  await expect(adder).toBeHidden()
  await waitSaved(page)
  const afterSub = nodeOf(await mainFlow(), 'after-sub')
  expect(sayIds(afterSub)).toContain(questionId)

  // The entry node's dialog now shows the notice, and the duplicate path.
  const dialog = await openEditAction(page, 'entry')
  await expect(dialog.getByRole('status').filter({ hasText: 'Used in 2 places — changes apply everywhere' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Duplicate and edit only here', exact: true }).click()
  await dialog.locator('#content-text').fill(COPY_Q)
  await dialog.getByRole('button', { name: 'Save action', exact: true }).click()
  await expect(dialog).toBeHidden()
  await waitSaved(page)

  const flow = await mainFlow()
  const entryId = sayIds(nodeOf(flow, 'entry'))[0]
  expect(entryId).not.toBe(questionId)
  // The other usage still names the original, and the original text is unchanged.
  expect(sayIds(nodeOf(flow, 'after-sub'))).toContain(questionId)
  const all = await elements()
  expect(all.find((e) => e.id === questionId)?.formData['text$en']).toBe(EDITED_Q)
  expect(all.find((e) => e.id === entryId)?.formData['text$en']).toBe(COPY_Q)
  expect(all.find((e) => e.id === entryId)?.contentType).toBe('builtin_single-choice')
})
