import { readStorage, writeStorage } from '@/lib/utils'

export const TOKEN_KEY = 'bot-engine.jwt'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Set by the app shell so a 401 anywhere sends the user back to the login page. */
let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler
}

export function getToken(): string | null {
  return readStorage(TOKEN_KEY)
}

export function setToken(token: string | null): void {
  writeStorage(TOKEN_KEY, token)
}

async function parseError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => '')
  let message = text || res.statusText
  try {
    const json = JSON.parse(text) as { message?: string }
    if (json.message) message = json.message
  } catch {
    /* plain-text error body */
  }
  return new ApiError(res.status, message || `HTTP ${res.status}`)
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  /** Raw body (for example a.tgz upload); sent as-is with `contentType`. */
  raw?: Blob | ArrayBuffer
  /** Multipart body; the browser sets the boundary header. */
  form?: FormData
  /** 'text' for endpoints that answer with a plain string (for example a new element id). */
  responseType?: 'json' | 'text'
  contentType?: string
  query?: Record<string, string | number | boolean | undefined>
  signal?: AbortSignal
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

/** Typed JSON request helper. Adds the Bearer token and turns 401 into a login redirect. */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  let body: BodyInit | undefined
  if (opts.form !== undefined) {
    body = opts.form
  } else if (opts.raw !== undefined) {
    body = opts.raw as BodyInit
    headers['Content-Type'] = opts.contentType ?? 'application/octet-stream'
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body)
    headers['Content-Type'] = 'application/json'
  }

  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body,
    signal: opts.signal,
  })

  if (res.status === 401 && !path.startsWith('/api/v1/auth/')) {
    setToken(null)
    onUnauthorized?.()
  }
  if (!res.ok) throw await parseError(res)

  const text = await res.text()
  if (opts.responseType === 'text') return text as T
  return (text ? JSON.parse(text) : undefined) as T
}

/** Binary request for downloads (the.tgz export). */
export async function requestBlob(path: string): Promise<{ blob: Blob; filename: string | null }> {
  const token = getToken()
  const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (res.status === 401) {
    setToken(null)
    onUnauthorized?.()
  }
  if (!res.ok) throw await parseError(res)
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const match = /filename=([^;]+)/.exec(disposition)
  return { blob: await res.blob(), filename: match ? match[1].trim() : null }
}
