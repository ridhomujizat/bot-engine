/**
 * Emulator request metadata, shaped like the client worker payload (the worker's MetaData type).
 * The worker sends it as `metadata` on every converse
 * call; flows read it as `event.payload.metadata`. Stored per bot in this browser only.
 */
import type { FlowView } from '@/api/types'

export const METADATA_KEY_PREFIX = 'bot-engine.emulatorMetadata.'

export function metadataKey(botId: string): string {
  return `${METADATA_KEY_PREFIX}${botId}`
}

/** The default metadata for an emulator user. Session and unique ids follow the userId. */
export function defaultMetadata(userId: string, now: Date = new Date()): Record<string, unknown> {
  return {
    bot_endpoint: '',
    bot_account: '',
    bot_alias: '',
    accountId: userId,
    unique_id: userId,
    cust_name: 'Emulator',
    tenant_id: '',
    channel_id: 12,
    channel_platform: 'example-platform',
    channel_sources: 'whatsapp',
    sources: 'whatsapp',
    date_timestamp: now.toISOString(),
    sid: `sid-${userId}`,
    new_session: true,
    cust_message: '',
    isLocation: false,
    locationPayload: { latitude: 0, longitude: 0 },
    raw: { session_id: `sid-${userId}` },
    profile: { name: '', username: '', email: '', mobilePhone: '' },
  }
}

export function defaultMetadataText(userId: string, now?: Date): string {
  return JSON.stringify(defaultMetadata(userId, now), null, 2)
}

export type ParsedMetadata =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string }

/** Validates the editor text: it must be one JSON object. */
export function parseMetadata(text: string): ParsedMetadata {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}` }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Metadata must be a JSON object' }
  }
  return { ok: true, value: value as Record<string, unknown> }
}

/** The metadata sent with one message: the editor's object, with `new_session` set by the emulator. */
export function metadataForSend(meta: Record<string, unknown>, newSession: boolean): Record<string, unknown> {
  return { ...meta, new_session: newSession }
}

/** Saved text for a bot, or null when the user has not saved one. Storage failures read as null. */
export function readStoredMetadata(botId: string, storage: Storage | null = browserStorage()): string | null {
  try {
    return storage?.getItem(metadataKey(botId)) ?? null
  } catch {
    return null
  }
}

/** Saves the editor text for a bot. A refusing storage just means it is not remembered. */
export function writeStoredMetadata(botId: string, text: string, storage: Storage | null = browserStorage()): void {
  try {
    storage?.setItem(metadataKey(botId), text)
  } catch {
    /* not remembered */
  }
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const TRIGGER_RE = /event\.(?:preview|payload\.text)\s*===?\s*(['"])(.+?)\1/g

/**
 * Literal trigger texts from the start node's transitions, in order (for example
 * `event.preview == 'start'`). Other flows' start nodes follow, so the main flow's triggers lead.
 */
export function triggerTexts(flows: FlowView[]): string[] {
  const ordered = [...flows].sort((a, b) => Number(b.name === 'main.flow.json') - Number(a.name === 'main.flow.json'))
  const out: string[] = []
  for (const flow of ordered) {
 // legacy files name the start node; the canvas may key it by id. Accept either.
    const start = flow.nodes.find((n) => n.name === flow.startNode || n.id === flow.startNode)
    for (const t of start?.next ?? []) {
      for (const m of t.condition.matchAll(TRIGGER_RE)) {
        if (!out.includes(m[2])) out.push(m[2])
      }
    }
  }
  return out
}
