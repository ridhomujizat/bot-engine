import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

export const BASE = process.env.E2E_BASE ?? 'http://localhost:3917'
export const EMAIL = process.env.E2E_EMAIL ?? 'e2e@example.com'
export const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e-pass-123'
export const BOT = process.env.E2E_BOT_ID ?? 'e2e-core'
export const DSN = process.env.E2E_DSN ?? ''
export const SHOTS = process.env.E2E_SHOTS ?? join(process.cwd(), 'e2e-shots')
const BOT_PREFIX = `data/bots/${BOT}/`

let shotNo = 0
mkdirSync(SHOTS, { recursive: true })
/** Full-page screenshot to SHOTS/NN-name.png. */
export async function shot(page: Page, name: string): Promise<void> {
  shotNo += 1
  await page.screenshot({ path: join(SHOTS, `${String(shotNo).padStart(2, '0')}-${name}.png`) })
}

/** Bearer token from the same login endpoint the UI uses. */
export async function token(email = EMAIL, password = PASSWORD): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/auth/login/basic/default`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`login ${res.status}`)
  const body = (await res.json()) as { payload: { jwt: string } }
  return body.payload.jwt
}

/** Editor API call with the Bearer token. Returns parsed JSON, or text for plain-text replies. */
export async function api<T = unknown>(method: string, path: string, body?: unknown, auth?: string): Promise<T> {
  const jwt = auth ?? (await token())
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`)
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

export const botApi = (suffix: string) => `/api/v1/studio/${BOT}${suffix}`

function sql(query: string): string {
  if (!DSN) throw new Error('E2E_DSN not set')
  return execFileSync('psql', [DSN, '-X', '-tA', '-c', query], { encoding: 'utf8' }).replace(/\n$/, '')
}

/** Current text of a bot file from srv_ghost_files (the real stored bytes). */
export function botFile(relPath: string): string {
  return sql(`SELECT convert_from(content, 'UTF8') FROM srv_ghost_files WHERE file_path = '${BOT_PREFIX}${relPath}' AND deleted = false`)
}

/** md5 of the stored bytes of one file, to prove byte-identical rewrites. */
export function botFileMd5(relPath: string): string {
  return sql(`SELECT md5(content) FROM srv_ghost_files WHERE file_path = '${BOT_PREFIX}${relPath}' AND deleted = false`)
}

/** md5 for every live file under this bot, keyed by path. */
export function botFileHashes(): Record<string, string> {
  const out = sql(`SELECT file_path || ' ' || md5(content) FROM srv_ghost_files WHERE file_path LIKE '${BOT_PREFIX}%' AND deleted = false ORDER BY file_path`)
  return Object.fromEntries(out.split('\n').filter(Boolean).map((line) => {
    const [path, hash] = line.split(' ')
    return [path.slice(BOT_PREFIX.length), hash]
  }))
}

/** Names of live bot files under a folder (relative to the bot root). */
export function botFileList(folder: string): string[] {
  const out = sql(`SELECT file_path FROM srv_ghost_files WHERE file_path LIKE '${BOT_PREFIX}${folder}%' AND deleted = false ORDER BY file_path`)
  return out.split('\n').filter(Boolean).map((p) => p.slice(BOT_PREFIX.length))
}

export function flowJson(name: string): { nodes: Record<string, unknown>[]; startNode: string } {
  return JSON.parse(botFile(`flows/${name}`))
}

/** Puts a session token into this browser context, as a completed login would. */
export async function signIn(page: Page): Promise<void> {
  const jwt = await token()
  await page.goto('/studio/login')
  await page.evaluate((jwtValue) => window.localStorage.setItem('bot-engine.jwt', jwtValue), jwt)
}

/** Makes sure the bot has a single-choice question for the choice-skill tests; creates one when it has none. */
export async function ensureChoiceQuestion(): Promise<void> {
  const contents = await api<{ contentType: string }[]>('POST', botApi('/cms/elements'), { count: 1000, from: 0 })
  if (contents.some((c) => c.contentType === 'builtin_single-choice')) return
  await api('POST', botApi('/cms/builtin_single-choice/element'), {
    formData: { 'text$en': 'Pilih layanan', 'choices$en': [{ title: 'Tagihan', value: 'bill' }, { title: 'Paket', value: 'pkg' }] },
  })
}
