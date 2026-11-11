import { request } from './http'
import type { ConverseResponse } from './types'

/** `payload.text` and `payload.payload` (the choice value) are what the skill parser reads. */
export interface ConverseInput {
  type: 'text' | 'single-choice' | 'postback'
  text: string
  payload?: { text?: string; payload?: string }
}

/** The body the emulator sends. `metadata` is what the client worker sends: flows read it as event.payload.metadata. */
export interface ConverseBody {
  type: ConverseInput['type']
  text: string
  payload: NonNullable<ConverseInput['payload']>
  metadata: Record<string, unknown>
}

export function converseBody(input: ConverseInput, metadata: Record<string, unknown>): ConverseBody {
  return { type: input.type, text: input.text, payload: input.payload ?? {}, metadata }
}

/** Emulator turn: the emulator uses its own userId so it never touches real sessions. */
export function converse(
  botId: string,
  userId: string,
  input: ConverseInput,
  metadata: Record<string, unknown> = {},
): Promise<ConverseResponse> {
  return request<ConverseResponse>(
    `/api/v1/bots/${encodeURIComponent(botId)}/converse/${encodeURIComponent(userId)}/secured`,
    {
      body: converseBody(input, metadata),
      query: { include: 'state,suggestions,decision,nlu' },
    },
  )
}
