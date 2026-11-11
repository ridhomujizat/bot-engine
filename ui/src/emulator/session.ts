import { useSyncExternalStore } from 'react'
import { converse, converseBody, type ConverseInput } from '@/api/converse'
import type { ConverseResponse, ResponsePayload } from '@/api/types'
import { defaultMetadataText, metadataForSend, parseMetadata, readStoredMetadata, writeStoredMetadata } from './metadata'
import type { StackEntry } from '../flow/runPath'

export interface EmulatorMessage {
  id: number
  from: 'user' | 'bot'
  /** When it was sent or received (epoch ms), for the timestamp. */
  at: number
  /** Set for bot messages: the payload to render. */
  payload?: ResponsePayload
  text?: string
}

export type EmulatorState = NonNullable<ConverseResponse['state']>

/** The last request sent and what came back (or the error), for the Raw tab. */
export interface EmulatorExchange {
  request: unknown
  response?: unknown
  error?: string
}

/**
 * One emulator conversation per bot. It lives outside React, so it survives the flow editor
 * unmounting (a route change) and a flow switch. Only Reset starts a new conversation.
 */
export interface EmulatorSession {
  userId: string
  messages: EmulatorMessage[]
  state: EmulatorState | null
  exchange: EmulatorExchange | null
  metadataText: string
  busy: boolean
  error: string | null
  /** Bumps on reset: a reply that arrives after a reset is dropped. */
  epoch: number
  /** Next message id. */
  nextId: number
  /** False until the first message of a session was sent (`new_session`). */
  fresh: boolean
}

function newUserId(): string {
  return `emulator-${Math.random().toString(36).slice(2, 8)}`
}

function startSession(botId: string): EmulatorSession {
  const userId = newUserId()
  return {
    userId,
    messages: [],
    state: null,
    exchange: null,
    metadataText: readStoredMetadata(botId) ?? defaultMetadataText(userId),
    busy: false,
    error: null,
    epoch: 0,
    nextId: 1,
    fresh: true,
  }
}

const sessions = new Map<string, EmulatorSession>()
const listeners = new Set<() => void>()

function sessionOf(botId: string): EmulatorSession {
  let s = sessions.get(botId)
  if (!s) {
    s = startSession(botId)
    sessions.set(botId, s)
  }
  return s
}

function patch(botId: string, change: Partial<EmulatorSession> | ((s: EmulatorSession) => Partial<EmulatorSession>)) {
  const current = sessionOf(botId)
  const next = typeof change === 'function' ? change(current) : change
  sessions.set(botId, { ...current, ...next })
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Stack from `state.__stacktrace`. Accepts an array of node names/objects or a `a > b` string. */
export function parseStackEntries(raw: unknown): StackEntry[] {
  if (typeof raw === 'string') {
    return raw
      .split('>')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((value) => entryOf(value, null))
      .filter((e) => e.node !== '')
  }
  if (!Array.isArray(raw)) return []
  return raw
    .map((item): StackEntry => {
      if (typeof item === 'string') return entryOf(item, null)
      if (item && typeof item === 'object') {
        const o = item as { flow?: unknown; node?: unknown; name?: unknown }
        const node = typeof o.node === 'string' ? o.node : typeof o.name === 'string' ? o.name : ''
        const flow = typeof o.flow === 'string' && o.flow !== '' ? o.flow : null
        return entryOf(node, flow)
      }
      return { flow: null, node: '' }
    })
    .filter((e) => e.node !== '')
}

/** `flow.json#node` names its flow; a bare name belongs to the flow on screen. */
function entryOf(value: string, flow: string | null): StackEntry {
  const hash = value.indexOf('#')
  if (hash === -1) return { flow, node: value }
  return { flow: flow ?? value.slice(0, hash), node: value.slice(hash + 1) }
}

/** Node names of a stack, in order (the names the Raw view shows). */
export function parseStacktrace(raw: unknown): string[] {
  return parseStackEntries(raw).map((e) => e.node)
}

export function useEmulatorSession(botId: string): EmulatorSession {
  return useSyncExternalStore(subscribe, () => sessionOf(botId), () => sessionOf(botId))
}

/** Sends one message in the bot's conversation. Blocked while a reply is pending or the metadata is invalid. */
export async function sendEmulatorMessage(botId: string, input: ConverseInput, label: string): Promise<void> {
  const session = sessionOf(botId)
  const current = parseMetadata(session.metadataText)
  if (!current.ok || session.busy) return
  const sent = metadataForSend(current.value, session.fresh)
  const epoch = session.epoch
  const userId = session.userId
  patch(botId, (s) => ({
    fresh: false,
    busy: true,
    error: null,
    messages: [...s.messages, { id: s.nextId, from: 'user', text: label, at: Date.now() }],
    nextId: s.nextId + 1,
  }))
  try {
    const res = await converse(botId, userId, input, sent)
    if (sessionOf(botId).epoch !== epoch) return
    patch(botId, (s) => ({
      busy: false,
      state: res.state ?? null,
      exchange: { request: converseBody(input, sent), response: res },
      messages: [
        ...s.messages,
        ...res.responses.map((payload, i) => ({ id: s.nextId + i, from: 'bot' as const, payload, at: Date.now() })),
      ],
      nextId: s.nextId + res.responses.length,
    }))
  } catch (err) {
    if (sessionOf(botId).epoch !== epoch) return
    const message = err instanceof Error ? err.message : 'Request failed'
    patch(botId, {
      busy: false,
      error: message,
      exchange: { request: converseBody(input, sent), error: message },
    })
  }
}

/** Saves the editor text for this bot; the conversation is kept. */
export function setEmulatorMetadata(botId: string, text: string): void {
  writeStoredMetadata(botId, text)
  patch(botId, { metadataText: text })
}

/** A fresh user id and an empty conversation. A saved metadata text stays; the default follows the new user. */
export function resetEmulatorSession(botId: string): void {
  const s = sessionOf(botId)
  const userId = newUserId()
  const keepSaved = readStoredMetadata(botId) !== null
  patch(botId, {
    userId,
    messages: [],
    state: null,
    exchange: null,
    busy: false,
    error: null,
    epoch: s.epoch + 1,
    fresh: true,
    nextId: 1,
    metadataText: keepSaved ? s.metadataText : defaultMetadataText(userId),
  })
}
