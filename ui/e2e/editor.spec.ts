import { test, expect, type Page, type Locator } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, BOT, EMAIL, PASSWORD, SHOTS, api, botApi, botFile, botFileHashes, botFileList, chooseOption, flowJson, shot, signIn } from './support'

// One serial journey through the real backend. Later steps depend on earlier ones.
test.describe.configure({ mode: 'serial' })

/** Every test but the login one starts signed in. */
test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title.startsWith('login:')) return
  await signIn(page)
})

const flowUrl = `/studio/bots/${BOT}/flows`
const NEW_TEXT = 'Promo baru dari editor e2e'
const JSON_NAME = 'promo-json'
let beforeHashes: Record<string, string> = {}
let userIdBefore = ''

async function openFlow(page: Page, query = '') {
  await page.goto(`${flowUrl}${query}`)
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
 // The JSON view replaces the canvas; wait for whichever view is shown.
  await expect(query.includes('view=json') ? page.getByLabel('Flow JSON') : page.locator('.react-flow__node').first()).toBeVisible()
}

/** Node on the canvas by its visible name. */
function nodeNamed(page: Page, name: string): Locator {
 // The node title is a span with the node name; the React Flow wrapper holds it.
  return page.locator('.react-flow__node').filter({ has: page.getByText(name, { exact: true }) }).first()
}

async function waitSaved(page: Page) {
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
}

test('login: bad credentials are rejected, good ones reach the bot list', async ({ page }) => {
  await page.goto('/studio/')
  await expect(page).toHaveURL(/\/studio\/login/)
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password').fill('wrong-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText(/Invalid credentials/i)
  await shot(page, 'login-bad')

  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Bots' })).toBeVisible()
  await shot(page, 'bots-list')
})

test('bot list opens the flow editor with the fixture flow tree', async ({ page }) => {
  await page.goto('/studio/')
  const row = page.locator('tr', { hasText: BOT })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Open editor' }).click()
  await expect(page).toHaveURL(new RegExp(`/bots/${BOT}/flows`))
  await expect(page.getByRole('complementary').or(page.locator('aside')).first()).toBeVisible()
  await expect(page.getByText('main', { exact: true }).first()).toBeVisible()
  await expect(nodeNamed(page, 'entry')).toBeVisible()
  await shot(page, 'flow-editor-loaded')
  beforeHashes = botFileHashes()
})

test('unchanged open and save leaves every file byte-identical', async ({ page }) => {
  await openFlow(page)
 // The first save of a hand-written fixture normalises it: JSON is re-serialised and the
 // missing main.flow.json is created. That is expected, so normalise once, then take the baseline.
  const views = await api<Array<Record<string, unknown>>>('GET', botApi('/flows'))
  const main = views.find((v) => v.name === 'main.flow.json')
  expect(main).toBeTruthy()
  await api('POST', botApi('/flows/main.flow.json'), { flow: main })
  beforeHashes = botFileHashes()
  expect(beforeHashes['flows/main.ui.json']).toBeTruthy()

 // Now the contract: open, save with nothing dirty, and a GET->POST round trip leave bytes unchanged.
  await page.reload()
  await openFlow(page)
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await api('POST', botApi('/flows/main.flow.json'), { flow: main })
  expect(botFileHashes()).toEqual(beforeHashes)
  await shot(page, 'unchanged-save')
})

test('add a standard node by drag, rename it, save', async ({ page }) => {
  await openFlow(page)
  const canvas = page.locator('.react-flow')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('no canvas')
  await page.getByText('Drag to add').waitFor()
  const palette = page.getByText('Node', { exact: true }).first()
  await palette.dragTo(canvas, { targetPosition: { x: box.width * 0.7, y: box.height * 0.55 } })
  await page.getByLabel('Node name').waitFor()
  await page.getByLabel('Node name').fill('promo')
  await page.getByLabel('Node name').press('Enter')
  await expect(nodeNamed(page, 'promo')).toBeVisible()
  await shot(page, 'node-added-renamed')
  await waitSaved(page)

  const flow = flowJson('main.flow.json')
  const node = (flow.nodes as Array<{ name: string }>).find((n) => n.name === 'promo')
  expect(node, 'promo node in main.flow.json').toBeTruthy()
  const ui = JSON.parse(botFile('flows/main.ui.json')) as { nodes: Array<{ id: string; position?: unknown }> }
  expect(ui.nodes.some((n) => n.position && n.id === (node as unknown as { id: string }).id)).toBe(true)
})

test('add a Say action that creates a new text content element', async ({ page }) => {
  await openFlow(page)
  await nodeNamed(page, 'promo').click()
  await page.getByRole('button', { name: 'Add action', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('radio', { name: 'Say something' }).click()
  await page.getByLabel('Message').fill(NEW_TEXT)
  await shot(page, 'say-action-form')
  await page.getByRole('button', { name: /Add action/ }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await waitSaved(page)

  const node = (flowJson('main.flow.json').nodes as Array<{ name: string; onEnter?: string[] }>).find((n) => n.name === 'promo')
  const say = node?.onEnter?.find((a) => a.startsWith('say #!builtin_text-'))
  expect(say, 'say action in onEnter').toBeTruthy()
  const promoContentId = (say as string).replace('say #!', '')
  const elements = await api<Array<{ id: string; formData: Record<string, string> }>>('POST', botApi('/cms/elements'), {})
  const el = elements.find((e) => e.id === promoContentId)
  expect(el?.formData['text$en']).toBe(NEW_TEXT)
})

test('add an Execute code action and pick an action with parameters', async ({ page }) => {
  await openFlow(page)
  await nodeNamed(page, 'promo').click()
  await page.getByRole('button', { name: 'Add action', exact: true }).click()
  await page.getByRole('radio', { name: 'Execute code' }).click()
  // Native builtins are offered alongside the bot's own actions.
  await chooseOption(page, page.locator('#action-name'), 'builtin/setVariable')
  // Declared parameters come pre-filled as rows: type, name, value.
  await expect(page.getByLabel('Parameter name')).toHaveCount(3)
  await page.getByLabel('Parameter value').nth(0).fill('temp')
  await page.getByLabel('Parameter value').nth(1).fill('e2e_flag')
  await page.getByLabel('Parameter value').nth(2).fill('from-e2e')
  await shot(page, 'code-action-form')
  await page.getByRole('button', { name: /Add action/ }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await waitSaved(page)

  const node = (flowJson('main.flow.json').nodes as Array<{ name: string; onEnter?: string[] }>).find((n) => n.name === 'promo')
  expect(node?.onEnter).toContain('builtin/setVariable {"type":"temp","name":"e2e_flag","value":"from-e2e"}')
})

test('add a transition (always) from an existing node to the new node', async ({ page }) => {
  await openFlow(page)
  await nodeNamed(page, 'after-sub').click()
  await page.getByRole('tab', { name: 'Transitions' }).click()
  await page.getByRole('button', { name: 'Add transition' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('radio', { name: 'Always' }).click()
  await page.getByRole('radio', { name: 'Transition to node' }).click()
  await chooseOption(page, page.getByRole('combobox', { name: 'Target node', exact: true }), 'promo', { exact: true })
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await waitSaved(page)

  const after = (flowJson('main.flow.json').nodes as Array<{ name: string; next: Array<{ node: string }> }>).find((n) => n.name === 'after-sub')
  expect(after?.next.some((t) => t.node === 'promo')).toBe(true)
  await shot(page, 'transition-added')
})

test('drag-connect an edge, then delete it via the hover button', async ({ page }) => {
  await openFlow(page)
 // promo gets a transition to END (end flow), so it has an output handle to drag.
  await nodeNamed(page, 'promo').click()
  await page.getByRole('tab', { name: 'Transitions' }).click()
  await page.getByRole('button', { name: 'Add transition' }).click()
  await page.getByRole('radio', { name: 'Always' }).click()
  await page.getByRole('radio', { name: 'End flow' }).click()
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()

 // Drag the new transition's handle onto echo: rewires transition 0 to echo.
 // The properties panel narrows the canvas; fit the view so both nodes are on screen.
  await page.getByRole('button', { name: 'Fit view' }).click()
 // Output handles are t<index> (transition index); the target handle is 'in'.
  const handle = nodeNamed(page, 'promo').locator('[data-handleid="t0"]')
  await handle.dragTo(nodeNamed(page, 'echo'))
  await shot(page, 'edge-connected')

 // Hover the promo -> echo edge and click its delete button.
  const edge = page.locator('.react-flow__edge').filter({ has: page.locator('path') })
  const edgeCount = await edge.count()
  let deleted = false
  for (let i = 0; i < edgeCount && !deleted; i++) {
    const path = edge.nth(i).locator('path').first()
    await path.hover({ force: true })
    const btn = page.getByRole('button', { name: 'Delete transition' })
    if (await btn.count()) {
      await btn.first().click({ force: true })
      deleted = true
    }
  }
  expect(deleted, 'delete transition button shown on hover').toBe(true)
  await waitSaved(page)

  const promo = (flowJson('main.flow.json').nodes as Array<{ name: string; next: Array<{ node: string }> }>).find((n) => n.name === 'promo')
  expect(promo?.next.some((t) => t.node === 'echo')).toBe(false)
  await shot(page, 'edge-deleted-saved')
})

test('JSON view: edit the flow text, apply, save', async ({ page }) => {
  await openFlow(page, '?view=json')
  const textarea = page.getByLabel('Flow JSON')
  const text = await textarea.inputValue()
  const edited = text.split('"promo"').join(`"${JSON_NAME}"`)
  expect(edited).not.toBe(text)
  await textarea.fill(edited)
  await page.getByRole('button', { name: 'Apply' }).click()
  await waitSaved(page)
  const names = (flowJson('main.flow.json').nodes as Array<{ name: string }>).map((n) => n.name)
  expect(names).toContain(JSON_NAME)
  await shot(page, 'json-applied')
})

test('emulator: reply after the edit is the new content, state and reset work', async ({ page }) => {
  await openFlow(page, '?emulator=1')
  const panel = page.locator('aside').filter({ has: page.getByRole('button', { name: 'Reset emulator session' }) })
  await expect(panel).toBeVisible()
  // Follow conversation (on by default) would open skills/sub.flow.json after the subflow reply; this test checks main's canvas.
  await panel.getByLabel('Follow conversation').click()
  // The details drawer is collapsed by default: open it on State before reading values.
  await panel.getByRole('tab', { name: 'State' }).click()
  userIdBefore = (await panel.locator('span').filter({ hasText: /^userId$/ }).locator('xpath=following-sibling::span[2]').textContent()) ?? ''
  const message = panel.getByRole('textbox', { name: 'Message', exact: true })
  const send = panel.getByRole('button', { name: 'Send message', exact: true })
 // The first message only starts the flow: the start node's onEnter answers it, transitions wait.
  await message.fill('hello')
  await send.click()
  await expect(panel.getByText('Hello, say something', { exact: true })).toBeVisible()
  await message.fill('sub')
  await send.click()
  await expect(panel.getByText('In subflow', { exact: true })).toBeVisible()
 // The subflow node waits for input (onReceive is set), so one more message returns to main.
  await message.fill('next')
  await send.click()
  await expect(panel.getByText('Back in main', { exact: true })).toBeVisible()
  await expect(panel.getByText(NEW_TEXT, { exact: true })).toBeVisible()
  await expect(panel.getByText(/currentNode/)).toBeVisible()
  await shot(page, 'emulator-reply')

 // Run path: the stacktrace ends at the node that answered, and the canvas marks it.
  await expect(panel.getByText('call > after-sub > promo-json')).toBeVisible()
  await expect(nodeNamed(page, JSON_NAME).locator('[class*="border-green"]').first()).toBeVisible()
  await panel.getByRole('tab', { name: 'Session' }).click()
  await expect(panel.getByText('session.lastMessages')).toBeVisible()
  await panel.getByRole('tab', { name: 'Raw' }).click()
  await expect(panel.locator('pre')).toContainText('__stacktrace')
  await panel.getByRole('tab', { name: 'State' }).click()

  await panel.getByRole('button', { name: 'Reset emulator session' }).click()
  await expect(panel.getByText(NEW_TEXT, { exact: true })).toHaveCount(0)
  await expect(panel.getByText('Send a message to start a conversation')).toBeVisible()
  const userIdAfter = (await panel.locator('span').filter({ hasText: /^userId$/ }).locator('xpath=following-sibling::span[2]').textContent()) ?? ''
  expect(userIdAfter).not.toBe(userIdBefore)
  await shot(page, 'emulator-reset')
})

test('code editor: edit an action, save, reload shows the content', async ({ page }) => {
  await page.goto(`/studio/bots/${BOT}/code`)
  await page.getByText('fail.js', { exact: false }).first().click()
  const editor = page.locator('.monaco-editor').first()
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n// e2e edit marker')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await shot(page, 'code-saved')
  await expect.poll(() => botFile('actions/fail.js')).toContain('// e2e edit marker')

  await page.reload()
  await page.getByText('fail.js', { exact: false }).first().click()
  await expect(page.locator('.monaco-editor').first()).toContainText('e2e edit marker')
  await shot(page, 'code-reloaded')
})

test('export the bot as .tgz then import it under a new id', async ({ page }) => {
  await page.goto('/studio/')
  const row = page.locator('tr', { hasText: BOT })
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    row.getByRole('button', { name: 'Export' }).click(),
  ])
  const exported = join(SHOTS, 'export-e2e-core.tgz')
  await download.saveAs(exported)
  expect(readFileSync(exported).length).toBeGreaterThan(100)

  await page.getByRole('button', { name: 'Import .tgz' }).click()
  await page.locator('input[type=file]').setInputFiles(exported)
  await page.getByLabel('Bot ID').fill('e2e-copy')
  await page.getByRole('button', { name: 'Import' }).last().click()
  await expect(page.locator('tr', { hasText: 'e2e-copy' })).toBeVisible()
  await shot(page, 'imported-copy')

 // The copy carries the edited flow, not the fixture original.
  const copy = await api<Array<{ name: string; nodes: Array<{ name: string }> }>>('GET', '/api/v1/studio/e2e-copy/flows', undefined)
  const main = copy.find((f) => f.name === 'main.flow.json')
  expect(main?.nodes.map((n) => n.name)).toContain(JSON_NAME)
})

// 1x1 transparent PNG, enough for the media endpoint's type check.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

test('media upload in an image content form stores the file and the URL', async ({ page }) => {
  await openFlow(page)
  await nodeNamed(page, JSON_NAME).click()
  await page.getByRole('button', { name: 'Add action', exact: true }).click()
  await page.getByRole('radio', { name: 'Say something' }).click()
  await chooseOption(page, page.locator('#content-type'), 'Image', { exact: true })
  const uploadResponse = page.waitForResponse((r) => r.url().includes('/media') && r.request().method() === 'POST')
  await page.locator('input[type=file]').setInputFiles({ name: 'e2e.png', mimeType: 'image/png', buffer: PNG })
  const res = await uploadResponse
  expect(res.status()).toBe(200)
  const url = (await res.json() as { url: string }).url
  await expect(page.getByLabel('Image', { exact: true })).toHaveValue(url)
  await page.getByLabel('Label', { exact: true }).fill('Gambar uji e2e')
  await shot(page, 'image-upload-form')
  await page.getByRole('button', { name: /Add action/ }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await waitSaved(page)

 // The stored media is served publicly, with the uploaded bytes.
  const served = await fetch(`${BASE}${url}`)
  expect(served.status).toBe(200)
  expect(served.headers.get('content-type')).toContain('image/png')
  expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true)
  const node = (flowJson('main.flow.json').nodes as Array<{ name: string; onEnter?: string[] }>).find((n) => n.name === JSON_NAME)
  expect(node?.onEnter?.length).toBeGreaterThanOrEqual(3)
})

test('choice skill: insert a choice node, wire it, pick an option in the emulator', async ({ page }) => {
 // A question with choices, created the way the content API does it.
  await api('POST', botApi('/cms/builtin_single-choice/element'), {
    formData: {
      'text$en': 'Pilih layanan',
      'choices$en': [
        { title: 'Tagihan', value: 'bill' },
        { title: 'Paket', value: 'pkg' },
      ],
    },
  })
 // Skill files from earlier tests stay in the bot: identify the one this insert creates.
  const skillsBefore = new Set(botFileList('flows/skills/'))
  await openFlow(page)
  const canvas = page.locator('.react-flow')
  const box = (await canvas.boundingBox())!
  await page.getByText('Choice', { exact: true }).first().dragTo(canvas, { targetPosition: { x: box.width * 0.3, y: box.height * 0.8 } })
  await expect(page.getByRole('dialog', { name: 'Choice skill' })).toBeVisible()
  await chooseOption(page, page.locator('#choice-question'), 'Pilih layanan')
  await shot(page, 'choice-dialog')
  await page.getByRole('button', { name: 'Insert', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Choice skill' })).toBeHidden()
  await expect(page.getByLabel('Node name')).toBeVisible()

 // Wire the renamed promo node -> the new choice node.
  const skillNode = await page.getByLabel('Node name').inputValue()
  // Click the header: the card body is made of action rows, and a row click opens that action's dialog.
  await nodeNamed(page, JSON_NAME).locator('span.truncate').first().click()
  await page.getByRole('tab', { name: 'Transitions' }).click()
 // Earlier tests may have added transitions here, and the emulator takes the first match: clear them first.
  while ((await page.locator('aside').getByRole('button', { name: 'Delete transition' }).count()) > 0) {
    await page.locator('aside').getByRole('button', { name: 'Delete transition' }).first().click()
  }
  await page.getByRole('button', { name: 'Add transition' }).click()
  await page.getByRole('radio', { name: 'Always' }).click()
  await page.getByRole('radio', { name: 'Transition to node' }).click()
  await chooseOption(page, page.getByRole('combobox', { name: 'Target node', exact: true }), skillNode, { exact: true })
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await waitSaved(page)

  const skillFiles = botFileList('flows/skills/').filter((f) => f.startsWith('flows/skills/choice-') && f.endsWith('.flow.json') && !skillsBefore.has(f))
  expect(skillFiles.length).toBe(1)
  const flow = flowJson('main.flow.json') as unknown as { nodes: Array<{ name: string; type?: string; skill?: string; flow?: string }> }
  const skill = flow.nodes.find((n) => n.name === skillNode)
  expect(skill?.type).toBe('skill-call')
  expect(skill?.flow).toBe(skillFiles[0].slice('flows/'.length))
  await shot(page, 'choice-wired')

 // Emulator: the new choice node shows its buttons; clicking one continues the conversation.
  await openFlow(page, '?emulator=1')
  const panel = page.locator('aside').filter({ has: page.getByRole('button', { name: 'Reset emulator session' }) })
  const message = panel.getByRole('textbox', { name: 'Message', exact: true })
  const send = panel.getByRole('button', { name: 'Send message', exact: true })
  await message.fill('hello')
  await send.click()
  await expect(panel.getByText('Hello, say something', { exact: true })).toBeVisible()
  await message.fill('sub')
  await send.click()
  await expect(panel.getByText('In subflow', { exact: true })).toBeVisible()
  await message.fill('next')
  await send.click()
  await expect(panel.getByText(NEW_TEXT, { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Tagihan', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Paket', exact: true })).toBeVisible()
  await shot(page, 'emulator-choice')
  await panel.getByRole('button', { name: 'Tagihan', exact: true }).click()
 // The click is sent as the user's message.
  await expect(panel.locator('.bg-primary', { hasText: 'Tagihan' })).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveCount(0)
 // The choice resolves inside the skill and ends the flow (no reply, no error route).
  await panel.getByRole('tab', { name: 'Raw' }).click()
 // The stack stays on the choice node: its name is the skill-call node the test wired.
  await expect(panel.locator('pre')).toContainText(`"node": "${skillNode}"`)
  await expect(panel.locator('pre')).not.toContainText('error.flow.json')
  await panel.getByRole('tab', { name: 'State' }).click()
  await shot(page, 'emulator-choice-picked')
})
