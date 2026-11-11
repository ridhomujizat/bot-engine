import { http, HttpResponse } from 'msw'
import type { ConverseInput } from '@/api/converse'
import type { CodeFile, ContentElement, ConverseResponse, FlowView, ResponsePayload } from '@/api/types'
import { actions, bots, codeContents, codeFiles, contentElements, initialFlows } from './fixtures'

/** In-memory copy of the bot the mock serves. Edits last until the page reloads. */
const flows = new Map<string, FlowView>(initialFlows().map((f) => [f.name, f]))
const content = new Map<string, ContentElement>(contentElements.map((e) => [e.id, e]))
const code = new Map<string, string>(Object.entries(codeContents))
const sessions = new Map<string, { node: string; stack: string[] }>()

const API = '/api/v1'

/** Error body shape of the backend (docs/studioapi.md). */
function apiError(status: number, errorCode: string, type: string, message: string) {
  return HttpResponse.json({ statusCode: status, errorCode, type, message, details: null, docs: null }, { status })
}

function requireToken(request: Request) {
  if (!request.headers.get('Authorization')) {
    return apiError(401, 'BP_0041', 'UnauthorizedError', 'Unauthorized: Authorization header is missing')
  }
  return null
}

/** Flow names contain `/`, so the path after `/flows/` is used verbatim. */
function flowNameFrom(url: string, botId: string): string {
  const prefix = `/api/v1/studio/${botId}/flows/`
  const pathname = decodeURIComponent(new URL(url).pathname)
  return pathname.slice(pathname.indexOf(prefix) + prefix.length)
}

function codeKey(file: Pick<CodeFile, 'location' | 'hookType'>): string {
  return file.hookType ? `${file.hookType}/${file.location}` : file.location
}

export const handlers = [
  http.post(`${API}/auth/login/basic/default`, async ({ request }) => {
    const body = (await request.json()) as { email?: string; password?: string }
    if (!body.email || !body.password) {
      return apiError(400, 'BP_0009', 'InvalidCredentialsError', 'Invalid credentials')
    }
    return HttpResponse.json({
      status: 'success',
      message: 'Login successful',
      payload: { jwt: `mock.${btoa(body.email)}.token`, exp: 3600000 },
    })
  }),

  http.get(`${API}/admin/workspace/bots`, ({ request }) => {
    const denied = requireToken(request)
    if (denied) return denied
    return HttpResponse.json({ status: 'success', message: 'Retrieved bots', payload: { bots } })
  }),

  http.get(`${API}/admin/workspace/bots/:botId/export`, ({ params }) => {
    const archive = new Blob([`mock archive for ${String(params.botId)}`], { type: 'application/tar+gzip' })
    return new HttpResponse(archive, {
      headers: {
        'Content-Type': 'application/tar+gzip',
        'Content-Disposition': `attachment; filename=bot_${String(params.botId)}.tgz`,
      },
    })
  }),

  http.post(`${API}/admin/workspace/bots/:botId/import`, async ({ request, params }) => {
    if (request.headers.get('Content-Type') !== 'application/tar+gzip') {
      return HttpResponse.text('Bot should be imported from archive', { status: 400 })
    }
    const size = (await request.arrayBuffer()).byteLength
    if (size === 0) return HttpResponse.text('Empty archive', { status: 400 })
    return HttpResponse.json({ status: 'success', message: `Imported ${String(params.botId)}`, payload: {} })
  }),

  http.get(`${API}/studio/:botId/flows`, () => HttpResponse.json([...flows.values()])),

  http.post(`${API}/studio/:botId/flows`, async ({ request }) => {
    const { flow } = (await request.json()) as { flow: FlowView }
    if (flows.has(flow.name)) return HttpResponse.text('Can not create an already existent flow', { status: 400 })
    flows.set(flow.name, flow)
    return new HttpResponse(null, { status: 200 })
  }),

  http.post(`${API}/studio/:botId/flows/*`, async ({ request, params }) => {
    const botId = String(params.botId)
    const url = request.url
    if (url.endsWith('/delete')) {
      const name = flowNameFrom(url, botId).replace(/\/delete$/, '')
      flows.delete(name)
      return new HttpResponse(null, { status: 200 })
    }
    const previous = flowNameFrom(url, botId)
    const { flow } = (await request.json()) as { flow: FlowView }
    if (flow.name !== previous) flows.delete(previous)
    flows.set(flow.name, { ...flow, location: flow.name })
    return new HttpResponse(null, { status: 200 })
  }),

  http.get(`${API}/studio/:botId/actions`, () => HttpResponse.json(actions)),

  http.post(`${API}/studio/:botId/cms/elements`, () => HttpResponse.json([...content.values()])),

  http.post(`${API}/studio/:botId/cms/:contentType/element`, async ({ request, params }) => {
    const { formData } = (await request.json()) as { formData: Record<string, unknown> }
    const id = `${String(params.contentType)}-${Math.random().toString(36).slice(2, 8)}`
    content.set(id, { id, contentType: String(params.contentType), formData })
    return HttpResponse.text(id)
  }),

  http.post(`${API}/studio/:botId/cms/:contentType/element/:elementId`, async ({ request, params }) => {
    const { formData } = (await request.json()) as { formData: Record<string, unknown> }
    const id = String(params.elementId)
    content.set(id, { id, contentType: String(params.contentType), formData })
    return HttpResponse.text(id)
  }),

  http.post(`${API}/studio/:botId/media`, async ({ request, params }) => {
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return HttpResponse.text('Missing file', { status: 400 })
    return HttpResponse.json({ url: `/api/v1/bots/${String(params.botId)}/media/${encodeURIComponent(file.name)}` })
  }),

  http.post(`${API}/studio/:botId/modules/basic-skills/skill/choice/generateFlow`, async ({ request }) => {
    const data = (await request.json()) as { randomId: string; contentId: string }
    const suffix = data.randomId
    const flow = {
      startNode: 'choice-entry',
      name: `skills/choice-${suffix}.flow.json`,
      location: `skills/choice-${suffix}.flow.json`,
      nodes: [
        {
          id: 'choice-entry',
          name: 'choice-entry',
          onEnter: [`say #!${data.contentId}`],
          onReceive: ['basic-skills/choice_parse_answer'],
          next: [
            { condition: `temp['skill-choice-valid-${suffix}'] === true`, node: '#' },
            { condition: 'otherwise', node: 'choice-invalid' },
          ],
        },
        {
          id: 'choice-invalid',
          name: 'choice-invalid',
          onEnter: ['basic-skills/choice_invalid_answer'],
          onReceive: null,
          next: [{ condition: 'true', node: 'choice-entry' }],
        },
      ],
      catchAll: { onReceive: [], next: [] },
      version: '0.0.1',
    }
    const transitions = [
      { condition: `temp['skill-choice-ret-${suffix}'] == 'info'`, node: '' },
      { condition: `temp['skill-choice-ret-${suffix}'] == 'cs'`, node: '' },
      { condition: 'otherwise', node: '' },
    ]
    return HttpResponse.json({ flow, transitions })
  }),

  http.get(`${API}/bots/:botId/mod/code-editor/files`, () => HttpResponse.json(codeFiles)),

  http.post(`${API}/bots/:botId/mod/code-editor/readFile`, async ({ request }) => {
    const file = (await request.json()) as CodeFile
    return HttpResponse.json({ fileContent: code.get(codeKey(file)) ?? '' })
  }),

  http.post(`${API}/bots/:botId/mod/code-editor/save`, async ({ request }) => {
    const file = (await request.json()) as CodeFile & { content: string }
    code.set(codeKey(file), file.content)
    return new HttpResponse(null, { status: 200 })
  }),

  http.post(`${API}/bots/:botId/converse/:userId/secured`, async ({ request, params }) => {
    const body = (await request.json()) as ConverseInput
    return HttpResponse.json(converse(String(params.userId), body))
  }),
]

/** Small scripted dialog that mirrors the sample flow, so the emulator can be demoed without a backend. */
function converse(userId: string, input: ConverseInput): ConverseResponse {
  const choice = input.payload?.payload ?? input.text
  const session = sessions.get(userId)
  const responses: ResponsePayload[] = []
  const menu: ResponsePayload = {
    type: 'single-choice',
    text: 'Silakan pilih layanan',
    choices: [
      { title: 'Informasi layanan', value: 'info' },
      { title: 'Hubungi customer service', value: 'cs' },
    ],
  }
  let node: string
  let stack: string[]

  if (!session) {
    responses.push({ type: 'text', text: 'Halo, selamat datang di example-bot' }, menu)
    node = 'menu-utama'
    stack = ['entry', 'menu-utama']
  } else if (choice === 'info') {
    responses.push({ type: 'text', text: 'Berikut informasi layanan' })
    node = 'informasi'
    stack = [...session.stack, 'informasi']
  } else if (choice === 'cs') {
    responses.push({ type: 'text', text: 'Mohon tunggu, kami hubungkan dengan petugas' })
    node = 'handover'
    stack = [...session.stack, 'handover']
  } else if (input.text === 'katalog') {
    responses.push({
      type: 'carousel',
      items: [
        { title: 'Tabungan', subtitle: 'Bunga kompetitif' },
        { title: 'Pinjaman', subtitle: 'Proses cepat' },
      ],
    })
    node = session.node
    stack = session.stack
  } else if (input.text === 'gambar') {
    responses.push({ type: 'image', image: '/api/v1/bots/example-bot/media/banner.png', title: 'Banner' })
    node = session.node
    stack = session.stack
  } else if (input.text === 'file') {
    responses.push({ type: 'file', file: '/api/v1/bots/example-bot/media/brosur.pdf', title: 'Brosur layanan' })
    node = session.node
    stack = session.stack
  } else {
    responses.push({ type: 'text', text: 'Pilihan tidak tersedia' }, menu)
    node = 'menu-utama'
    stack = [...session.stack, 'tidak-valid', 'menu-utama']
  }
  sessions.set(userId, { node, stack })
  return {
    responses,
    state: {
      context: { currentNode: node, currentFlow: 'main.flow.json', previousNode: stack[stack.length - 2] },
      session: { sid: `emu-${userId.slice(-6)}`, menu: choice },
      temp: { 'skill-choice-ret-4cd383': choice },
      __stacktrace: stack,
    },
  }
}
