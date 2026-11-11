import { describe, expect, it } from 'vitest'
import type { FlowView } from '@/api/types'
import { converseBody } from '@/api/converse'
import {
  defaultMetadata,
  metadataForSend,
  metadataKey,
  parseMetadata,
  readStoredMetadata,
  quickStartTriggers,
  writeStoredMetadata,
} from './metadata'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
  } as Storage
}

const brokenStorage = {
  getItem: () => {
    throw new Error('denied')
  },
  setItem: () => {
    throw new Error('quota')
  },
} as unknown as Storage

describe('default metadata', () => {
  it('follows the client worker MetaData field names and derives ids from the userId', () => {
    const m = defaultMetadata('emulator-abc123', new Date('2026-11-11T10:00:00Z'))
    for (const key of ['accountId', 'unique_id', 'channel_id', 'channel_platform', 'channel_sources', 'date_timestamp', 'sid', 'new_session', 'profile', 'raw']) {
      expect(m).toHaveProperty(key)
    }
    expect(m.accountId).toBe('emulator-abc123')
    expect(m.unique_id).toBe('emulator-abc123')
    expect(m.channel_sources).toBe('whatsapp')
    expect(m.channel_platform).toBe('example-platform')
    expect(m.sid).toBe('sid-emulator-abc123')
    expect(m.date_timestamp).toBe('2026-11-11T10:00:00.000Z')
  })
})

describe('metadata validation and sending', () => {
  it('accepts one JSON object and rejects anything else with a message', () => {
    expect(parseMetadata('{"sid":"s1"}')).toEqual({ ok: true, value: { sid: 's1' } })
    expect(parseMetadata('{"sid":').ok).toBe(false)
    expect(parseMetadata('[1,2]')).toEqual({ ok: false, error: 'Metadata must be a JSON object' })
    expect(parseMetadata('null').ok).toBe(false)
  })

  it('sets new_session per message and does not change the editor object', () => {
    const edited = { sid: 's1', new_session: false }
    expect(metadataForSend(edited, true)).toEqual({ sid: 's1', new_session: true })
    expect(metadataForSend(edited, false).new_session).toBe(false)
    expect(edited.new_session).toBe(false)
  })

  it('sends metadata as the body key client worker uses', () => {
    const body = converseBody({ type: 'text', text: 'start', payload: { text: 'start' } }, { sid: 's1', new_session: true })
    expect(body).toEqual({ type: 'text', text: 'start', payload: { text: 'start' }, metadata: { sid: 's1', new_session: true } })
  })
})

describe('per-bot persistence', () => {
  it('stores the text per bot and reads it back', () => {
    const storage = memoryStorage()
    writeStoredMetadata('example-bot', '{"sid":"a"}', storage)
    writeStoredMetadata('e2e-core', '{"sid":"b"}', storage)
    expect(storage.getItem(metadataKey('example-bot'))).toBe('{"sid":"a"}')
    expect(readStoredMetadata('example-bot', storage)).toBe('{"sid":"a"}')
    expect(readStoredMetadata('e2e-core', storage)).toBe('{"sid":"b"}')
    expect(readStoredMetadata('other', storage)).toBeNull()
  })

  it('never throws when storage is unavailable or refuses writes', () => {
    expect(readStoredMetadata('example-bot', brokenStorage)).toBeNull()
    expect(() => writeStoredMetadata('example-bot', '{}', brokenStorage)).not.toThrow()
    expect(readStoredMetadata('example-bot', null)).toBeNull()
    expect(() => writeStoredMetadata('example-bot', '{}', null)).not.toThrow()
  })
})

it('finds the start node by name, as legacy files do', () => {
  const f = flow('main.flow.json', 'entry', ["event.preview == 'go'"])
  f.nodes[0].name = 'entry'
  f.nodes[0].id = 'n-entry'
  expect(quickStartTriggers([f], undefined)).toEqual(['go'])
})

function flow(name: string, startNode: string, conditions: string[]): FlowView {
  return {
    name,
    location: name,
    version: '0.0.1',
    catchAll: {},
    startNode,
    nodes: [
      { id: startNode, name: startNode, x: 0, y: 0, next: conditions.map((c, i) => ({ condition: c, node: `n${i}` })) },
    ],
  } as unknown as FlowView
}

describe('quickStartTriggers', () => {
  it('lists literal start-node triggers of the main flow first, without duplicates', () => {
    const triggers = quickStartTriggers(
      [
        flow('RCP.flow.json', 'init', ["event.preview == 'rcp-trigger'", "event.preview == 'start'"]),
        flow('main.flow.json', 'init', [
          "event.preview == 'start'",
          "event.preview == 'start-rcp'",
          'event.payload.text === "#dev-langganan"',
          'session.x === 1',
          'true',
        ]),
      ],
      undefined,
    )
    expect(triggers).toEqual(['start', 'start-rcp', '#dev-langganan'])
  })

  it('adds the start node of the open flow after the main flow, and ignores other flows', () => {
    const flows = [
      flow('main.flow.json', 'init', ["event.preview == 'start'"]),
      flow('skills/choice-1.flow.json', 'init', ["event.preview == 'choice-open'"]),
      flow('other.flow.json', 'init', ["event.preview == 'elsewhere'"]),
    ]
    expect(quickStartTriggers(flows, 'skills/choice-1.flow.json')).toEqual(['start', 'choice-open'])
    expect(quickStartTriggers(flows, 'main.flow.json')).toEqual(['start'])
  })

  it('caps the chips at the limit', () => {
    const many = Array.from({ length: 9 }, (_, i) => `event.preview == 't${i}'`)
    const triggers = quickStartTriggers([flow('main.flow.json', 'init', many)], undefined)
    expect(triggers).toEqual(['t0', 't1', 't2', 't3', 't4', 't5'])
    expect(quickStartTriggers([flow('main.flow.json', 'init', many)], undefined, 2)).toEqual(['t0', 't1'])
  })

  it('returns nothing when no start-node transition compares text', () => {
    expect(quickStartTriggers([flow('main.flow.json', 'init', ['true'])], undefined)).toEqual([])
  })
})
