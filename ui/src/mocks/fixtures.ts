import type { ActionDef, Bot, CodeFile, ContentElement, FlowJson, FlowView } from '@/api/types'

/** Sample bot used when VITE_MOCK=1. Same shape as the design's `main.flow.json`. */
export const BOT_ID = 'example-bot'

export const bots: Bot[] = [
  { id: 'example-bot', name: 'example-bot', category: 'Customer service', defaultLanguage: 'en' },
  { id: 'example-bot-dev', name: 'example-bot (dev)', category: 'Customer service', defaultLanguage: 'en' },
  { id: 'tes-bot', name: 'Tes Bot', category: 'Sandbox', defaultLanguage: 'en' },
]

const mainFlow: FlowJson = {
  version: '0.0.1',
  catchAll: { onReceive: [], next: [] },
  startNode: 'entry',
  nodes: [
    {
      id: 'entry',
      name: 'entry',
      onEnter: [
        'builtin/setVariable {"type":"session","name":"sid","value":"{{event.payload.metadata.sid}}"}',
        'builtin/setVariable {"type":"session","name":"name","value":"{{event.payload.metadata.cust_name}}"}',
        'say #!builtin_text-Xk29aQ',
      ],
      onReceive: null,
      next: [{ condition: 'true', node: 'menu-utama' }],
    },
    {
      id: 'skill-4cd383',
      type: 'skill-call',
      skill: 'choice',
      name: 'menu-utama',
      flow: 'skills/choice-4cd383.flow.json',
      onEnter: ['say #!builtin_single-choice-P9d2'],
      onReceive: ['basic-skills/choice_parse_answer'],
      next: [
        { condition: "temp['skill-choice-ret-4cd383'] == 'info'", node: 'informasi' },
        { condition: "temp['skill-choice-ret-4cd383'] == 'cs'", node: 'handover' },
        { condition: 'true', node: 'tidak-valid' },
      ],
    },
    {
      id: 'informasi',
      name: 'informasi',
      onEnter: ['jam_kerja', 'say #!builtin_text-Jk72aP'],
      onReceive: null,
      next: [
        { condition: "session.jamkerja === 'buka'", node: 'jam-kerja.flow.json' },
        { condition: 'true', node: '#' },
      ],
    },
    {
      id: 'handover',
      name: 'handover',
      onEnter: ['say #!builtin_text-Mq18Kd', 'handover'],
      onReceive: null,
      next: [{ condition: 'true', node: 'END' }],
    },
    {
      id: 'tidak-valid',
      name: 'tidak-valid',
      onEnter: ['basic-skills/choice_invalid_answer', 'say #!builtin_text-Pv55Rz'],
      onReceive: null,
      next: [
        { condition: 'Number(temp[\'count\']) > Number(3)', node: 'handover' },
        { condition: 'true', node: 'menu-utama' },
      ],
    },
  ],
}

const layout: Record<string, { x: number; y: number }> = {
  entry: { x: 100, y: 186 },
  'skill-4cd383': { x: 400, y: 150 },
  informasi: { x: 760, y: 20 },
  handover: { x: 760, y: 294 },
  'tidak-valid': { x: 760, y: 536 },
}

function viewOf(name: string, flow: FlowJson, positions: Record<string, { x: number; y: number }>): FlowView {
  return {
    ...flow,
    name,
    location: name,
    nodes: flow.nodes.map((node, i) => ({
      ...node,
      ...(positions[node.id] ?? { x: 100 + i * 260, y: 120 }),
    })),
    links: [],
  }
}

const simpleFlow = (startNode: string, nodes: FlowJson['nodes']): FlowJson => ({
  version: '0.0.1',
  catchAll: { onReceive: [], next: [] },
  startNode,
  nodes,
})

const choiceFlow = (suffix: string): FlowJson =>
  simpleFlow('choice-entry', [
    {
      id: 'choice-entry',
      name: 'choice-entry',
      onEnter: [`say #!builtin_single-choice-${suffix}`],
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
  ])

/** Flow files in the bot, keyed by their path under flows/. */
export const flowFiles: Record<string, { flow: FlowJson; positions: Record<string, { x: number; y: number }> }> = {
  'main.flow.json': { flow: mainFlow, positions: layout },
  'error.flow.json': {
    flow: simpleFlow('err-entry', [
      { id: 'err-entry', name: 'err-entry', onEnter: ['say #!builtin_text-Er01Ab'], onReceive: null, next: [{ condition: 'true', node: '#' }] },
    ]),
    positions: { 'err-entry': { x: 100, y: 120 } },
  },
  'timeout.flow.json': {
    flow: simpleFlow('timeout-entry', [
      { id: 'timeout-entry', name: 'timeout-entry', onEnter: ['time-out', 'builtin/resetSession'], onReceive: null, next: [{ condition: 'true', node: 'END' }] },
    ]),
    positions: { 'timeout-entry': { x: 100, y: 120 } },
  },
  'handover.flow.json': {
    flow: simpleFlow('handover-entry', [
      { id: 'handover-entry', name: 'entry', onEnter: ['handover'], onReceive: null, next: [{ condition: 'true', node: 'END' }] },
    ]),
    positions: { 'handover-entry': { x: 100, y: 120 } },
  },
  'jam-kerja.flow.json': {
    flow: simpleFlow('jk-entry', [
      { id: 'jk-entry', name: 'jk-entry', onEnter: ['jam_kerja', 'say #!builtin_text-Jk72aP'], onReceive: null, next: [{ condition: 'true', node: '#' }] },
    ]),
    positions: { 'jk-entry': { x: 100, y: 120 } },
  },
  'skills/choice-4cd383.flow.json': { flow: choiceFlow('P9d2'), positions: {} },
  'skills/choice-a1bdc2.flow.json': { flow: choiceFlow('Q7ka1'), positions: {} },
}

export function initialFlows(): FlowView[] {
  return Object.entries(flowFiles).map(([name, { flow, positions }]) => viewOf(name, flow, positions))
}

export const contentElements: ContentElement[] = [
  { id: 'builtin_text-Xk29aQ', contentType: 'builtin_text', formData: { 'text$en': 'Halo, selamat datang di example-bot' } },
  { id: 'builtin_text-Jk72aP', contentType: 'builtin_text', formData: { 'text$en': 'Berikut informasi layanan' } },
  { id: 'builtin_text-Mq18Kd', contentType: 'builtin_text', formData: { 'text$en': 'Mohon tunggu, kami hubungkan dengan petugas' } },
  { id: 'builtin_text-Pv55Rz', contentType: 'builtin_text', formData: { 'text$en': 'Pilihan tidak tersedia' } },
  { id: 'builtin_text-Er01Ab', contentType: 'builtin_text', formData: { 'text$en': 'Maaf, terjadi kesalahan' } },
  {
    id: 'builtin_single-choice-P9d2',
    contentType: 'builtin_single-choice',
    formData: {
      'text$en': 'Silakan pilih layanan',
      choices: [
        { title: 'Informasi layanan', value: 'info' },
        { title: 'Hubungi customer service', value: 'cs' },
      ],
    },
  },
  { id: 'builtin_image-Im11Xy', contentType: 'builtin_image', formData: { image: '/api/v1/bots/example-bot/media/banner.png', title: 'Banner' } },
  { id: 'builtin_file-Fl22Qw', contentType: 'builtin_file', formData: { file: '/api/v1/bots/example-bot/media/brosur.pdf', title: 'Brosur layanan' } },
  {
    id: 'builtin_carousel-Ca33Zt',
    contentType: 'builtin_carousel',
    formData: {
      items: [
        { title: 'Tabungan', subtitle: 'Bunga kompetitif' },
        { title: 'Pinjaman', subtitle: 'Proses cepat' },
      ],
    },
  },
]

/** Actions as `GET /actions` returns them. */
export const actions: ActionDef[] = [
  {
    name: 'builtin/setVariable',
    scope: 'global',
    title: 'Set variable',
    category: 'Built-in',
    params: [
      { name: 'type', type: 'string', required: true },
      { name: 'name', type: 'string', required: true },
      { name: 'value', type: 'string' },
    ],
  },
  { name: 'builtin/removeVariable', scope: 'global', title: 'Remove variable', category: 'Built-in', params: [{ name: 'type', type: 'string' }, { name: 'name', type: 'string' }] },
  { name: 'builtin/resetSession', scope: 'global', title: 'Reset session', category: 'Built-in', params: [] },
  { name: 'basic-skills/choice_parse_answer', scope: 'global', legacy: false, title: 'Parse choice answer', category: 'Skills', params: [] },
  { name: 'basic-skills/choice_invalid_answer', scope: 'global', legacy: false, title: 'Invalid choice answer', category: 'Skills', params: [] },
  { name: 'handover', scope: 'bot', title: 'Handover to agent', category: 'Custom', params: [] },
  { name: 'jam_kerja', scope: 'bot', title: 'Working hours', category: 'Custom', params: [] },
  { name: 'time-out', scope: 'bot', title: 'Time out', category: 'Custom', params: [] },
]

export const handoverSource = [
  '/**',
  ' * @title Handover ke agent',
  ' * @category Custom',
  ' */',
  "const axios = require('axios')",
  '',
  'const handover = async () => {',
  "  let message = 'handover'",
  '  if (session.menu !== undefined) {',
  '    message = `Menu :${session.menu} \\n`',
  '  }',
  '',
  '  const payload = {',
  '    account_id: session.accountId,',
  '    sid: session.sid,',
  '    unique_id: session.unique_id,',
  '    cust_message: message',
  '  }',
  '',
  '  const { data } = await axios.post(args.url, payload)',
  "  bp.logger.info('response handover', data)",
  '}',
  '',
  'return handover()',
].join('\n')

/** Files as `GET /mod/code-editor/files` returns them. Hooks are located relative to hooks/{hookType}/. */
export const codeFiles: { 'bot.actions': CodeFile[]; 'bot.hooks': CodeFile[] } = {
  'bot.actions': [
    { name: 'handover.js', type: 'action_legacy', location: 'handover.js', botId: BOT_ID },
    { name: 'jam_kerja.js', type: 'action_legacy', location: 'jam_kerja.js', botId: BOT_ID },
    { name: 'menu.js', type: 'action_legacy', location: 'menu.js', botId: BOT_ID },
    { name: 'time-out.js', type: 'action_legacy', location: 'time-out.js', botId: BOT_ID },
  ],
  'bot.hooks': [
    {
      name: 'create_end_message.js',
      type: 'hook',
      location: 'create_end_message.js',
      hookType: 'before_conversation_end',
      botId: BOT_ID,
    },
  ],
}

/** File contents keyed by `hookType/location` (or just the location for actions). */
export const codeContents: Record<string, string> = {
  'handover.js': handoverSource,
  'jam_kerja.js': "return bp.logger.info('jam kerja')\n",
  'menu.js': "temp['count'] = Number(temp['count'] || 0) + 1\n",
  'time-out.js': "return axios.post(args.url, { sid: session.sid })\n",
  'before_conversation_end/create_end_message.js': "event.payload.text = 'Terima kasih'\n",
}
