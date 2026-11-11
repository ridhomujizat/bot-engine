import { useCallback, useMemo } from 'react'
import type { ConverseInput } from '@/api/converse'
import { parseMetadata } from './metadata'
import { parseStackEntries, resetEmulatorSession, sendEmulatorMessage, setEmulatorMetadata, useEmulatorSession } from './session'

export type { EmulatorExchange, EmulatorMessage, EmulatorState } from './session'
export { parseStackEntries }

/**
 * Emulator session of one bot. The conversation is held by the session store (see session.ts), so
 * it survives the editor's route changes; one userId per session, reset makes a fresh one.
 */
export function useEmulator(botId: string) {
  const session = useEmulatorSession(botId)
  const metadata = parseMetadata(session.metadataText)
  const metadataError = metadata.ok ? null : metadata.error
  const stackEntries = useMemo(() => parseStackEntries(session.state?.__stacktrace), [session.state])
  const stacktrace = useMemo(() => stackEntries.map((e) => e.node), [stackEntries])

  const send = useCallback((input: ConverseInput, label: string) => void sendEmulatorMessage(botId, input, label), [botId])
  const changeMetadata = useCallback((text: string) => setEmulatorMetadata(botId, text), [botId])
  const reset = useCallback(() => resetEmulatorSession(botId), [botId])

  return {
    userId: session.userId,
    messages: session.messages,
    state: session.state,
    exchange: session.exchange,
    metadataText: session.metadataText,
    metadataError,
    changeMetadata,
    busy: session.busy,
    error: session.error,
    stacktrace,
    stackEntries,
    send,
    reset,
  }
}

export type EmulatorApi = ReturnType<typeof useEmulator>
