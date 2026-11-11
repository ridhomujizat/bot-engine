import { useMutation } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'
import { converse, converseBody, type ConverseInput } from '@/api/converse'
import type { ConverseResponse, ResponsePayload } from '@/api/types'
import {
  defaultMetadataText,
  metadataForSend,
  parseMetadata,
  readStoredMetadata,
  writeStoredMetadata,
} from './metadata'

export interface EmulatorMessage {
  id: number
  from: 'user' | 'bot'
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

function newUserId(): string {
  return `emulator-${Math.random().toString(36).slice(2, 8)}`
}

/** Stack from `state.__stacktrace`. Accepts an array of node names/objects or a `a > b` string. */
export function parseStacktrace(raw: unknown): string[] {
  if (typeof raw === 'string') {
    return raw.split('>').map((s) => s.trim()).filter(Boolean).map(nodeOf)
  }
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (typeof item === 'string') return nodeOf(item)
      if (item && typeof item === 'object') {
        const o = item as { node?: unknown; name?: unknown }
        const value = typeof o.node === 'string' ? o.node : typeof o.name === 'string' ? o.name : ''
        return nodeOf(value)
      }
      return ''
    })
    .filter(Boolean)
}

/** ` on#node` keeps only the node part, since the canvas shows the current flow. */
function nodeOf(value: string): string {
  const hash = value.indexOf('#')
  return hash === -1 ? value : value.slice(hash + 1)
}

/**
 * Emulator session: one userId per session, reset makes a fresh one. Every message carries the
 * metadata text of this bot (validated; invalid text blocks sending). `new_session` is true for
 * the first message of a session and false after.
 */
export function useEmulator(botId: string) {
  const [userId, setUserId] = useState(newUserId)
  const [messages, setMessages] = useState<EmulatorMessage[]>([])
  const [state, setState] = useState<EmulatorState | null>(null)
  const [exchange, setExchange] = useState<EmulatorExchange | null>(null)
  const [metadataText, setMetadataText] = useState<string>(
    () => readStoredMetadata(botId) ?? defaultMetadataText(userId),
  )
 // Message keys come from a counter, not render state, so replies never reuse a key.
  const nextId = useRef(1)
  const newSession = useRef(true)

  const metadata = parseMetadata(metadataText)
  const metadataError = metadata.ok ? null : metadata.error

  const mutation = useMutation({
    mutationFn: (args: { input: ConverseInput; metadata: Record<string, unknown> }) =>
      converse(botId, userId, args.input, args.metadata),
    onSuccess: (res, args) => {
      setState(res.state ?? null)
      setExchange({ request: converseBody(args.input, args.metadata), response: res })
      setMessages((prev) => [
        ...prev,
        ...res.responses.map((payload) => ({ id: nextId.current++, from: 'bot' as const, payload })),
      ])
    },
    onError: (err, args) => {
      setExchange({ request: converseBody(args.input, args.metadata), error: err.message })
    },
  })

  const send = useCallback(
    (input: ConverseInput, label: string) => {
      const current = parseMetadata(metadataText)
      if (!current.ok) return
      const sent = metadataForSend(current.value, newSession.current)
      newSession.current = false
      setMessages((prev) => [...prev, { id: nextId.current++, from: 'user', text: label }])
      mutation.mutate({ input, metadata: sent })
    },
    [mutation, metadataText],
  )

  /** Saves the editor text for this bot; the page is never reloaded. */
  const changeMetadata = useCallback(
    (text: string) => {
      setMetadataText(text)
      writeStoredMetadata(botId, text)
    },
    [botId],
  )

  const reset = useCallback(() => {
    const id = newUserId()
    setUserId(id)
    setMessages([])
    setState(null)
    setExchange(null)
    newSession.current = true
 // Without a saved text the default follows the new user; a saved text is the user's and stays.
    if (readStoredMetadata(botId) === null) setMetadataText(defaultMetadataText(id))
    mutation.reset()
  }, [botId, mutation])

  return {
    userId,
    messages,
    state,
    exchange,
    metadataText,
    metadataError,
    changeMetadata,
    busy: mutation.isPending,
    error: mutation.error?.message ?? null,
    stacktrace: parseStacktrace(state?.__stacktrace),
    send,
    reset,
  }
}

export type EmulatorApi = ReturnType<typeof useEmulator>
