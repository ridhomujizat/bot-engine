import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FlowSaver, type SaveStatus } from './autosave'
import type { FlowDoc } from './model'

function doc(tag: string): FlowDoc {
  return { name: 'main.flow.json', meta: { startNode: tag }, nodes: [], positions: {}, links: [] }
}

/** A store with one draft per flow, plus a write that resolves when the test says so. */
function harness() {
  const drafts: Record<string, FlowDoc | undefined> = {}
  const writes: { name: string; doc: FlowDoc; done: () => void; fail: (m: string) => void }[] = []
  const statuses: SaveStatus[] = []
  const settled: FlowDoc[] = []
  const saver = new FlowSaver({
    read: (name) => drafts[name],
    write: (name, d) =>
      new Promise<void>((resolve, reject) => {
        writes.push({ name, doc: d, done: resolve, fail: (m) => reject(new Error(m)) })
      }),
    settle: (name, saved) => {
      settled.push(saved)
      if (drafts[name] === saved) delete drafts[name]
    },
    onStatus: (s) => statuses.push(s),
  })
  return { drafts, writes, statuses, settled, saver }
}

/** Lets pending promise callbacks run (fake timers do not advance on their own). */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('FlowSaver (legacy debounce 1000ms, leading)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('saves the first change at once, then one trailing save with the latest draft', async () => {
    const h = harness()
    h.drafts['main.flow.json'] = doc('a')
    h.saver.changed('main.flow.json')
    expect(h.writes).toHaveLength(1)
    h.drafts['main.flow.json'] = doc('b')
    h.saver.changed('main.flow.json')
    h.drafts['main.flow.json'] = doc('c')
    h.saver.changed('main.flow.json')
    expect(h.writes).toHaveLength(1)
    h.writes[0].done()
    await flush()
 // Edits made during the first write are not dropped: they wait for the window to close.
    expect(h.writes).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(h.writes).toHaveLength(2)
    expect(h.writes[1].doc.meta.startNode).toBe('c')
    h.writes[1].done()
    await flush()
    expect(h.drafts['main.flow.json']).toBeUndefined()
    expect(h.statuses.at(-1)).toEqual({ kind: 'saved' })
  })

  it('keeps an edit made during a write: the draft is not dropped by a stale settle', async () => {
    const h = harness()
    h.drafts['main.flow.json'] = doc('a')
    h.saver.changed('main.flow.json')
    h.drafts['main.flow.json'] = doc('b')
    h.writes[0].done()
    await flush()
    expect(h.drafts['main.flow.json']?.meta.startNode).toBe('b')
    vi.advanceTimersByTime(1000)
    expect(h.writes.at(-1)?.doc.meta.startNode).toBe('b')
  })

  it('keeps the draft on failure, reports the error, and retries on the next change', async () => {
    const h = harness()
    h.drafts['main.flow.json'] = doc('a')
    h.saver.changed('main.flow.json')
    h.writes[0].fail('network down')
    await flush()
    expect(h.drafts['main.flow.json']?.meta.startNode).toBe('a')
    expect(h.statuses.at(-1)).toEqual({ kind: 'error', message: 'network down' })
 // No automatic retry loop: the next change retries with the latest draft.
    expect(h.writes).toHaveLength(1)
    h.drafts['main.flow.json'] = doc('b')
    h.saver.changed('main.flow.json')
 // The window of the failed write is still open, so the retry goes out when it closes.
    expect(h.writes).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(h.writes).toHaveLength(2)
    expect(h.writes[1].doc.meta.startNode).toBe('b')
    h.writes[1].done()
    await flush()
    expect(h.drafts['main.flow.json']).toBeUndefined()
    expect(h.statuses.at(-1)).toEqual({ kind: 'saved' })
  })

  it('flush writes the dirty flows now and waits for in-flight writes', async () => {
    const h = harness()
    h.drafts['main.flow.json'] = doc('a')
    h.saver.changed('main.flow.json')
    h.drafts['main.flow.json'] = doc('b')
    h.saver.changed('main.flow.json')
    const p = h.saver.flush(['main.flow.json'])
    h.writes[0].done()
    await flush()
 // The waiting edit is written by the flush, not by the window.
    expect(h.writes).toHaveLength(2)
    h.writes[1].done()
    await p
    expect(h.drafts['main.flow.json']).toBeUndefined()
  })
})
