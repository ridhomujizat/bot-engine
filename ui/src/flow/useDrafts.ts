import { useCallback, useMemo, useState } from 'react'
import type { FlowDoc } from './model'

interface DraftState {
  /** Edited documents, keyed by flow name. A name in here is unsaved. */
  docs: Record<string, FlowDoc>
  past: Record<string, FlowDoc[]>
  future: Record<string, FlowDoc[]>
}

const HISTORY_LIMIT = 100
const EMPTY: DraftState = { docs: {}, past: {}, future: {} }

/**
 * Unsaved flow edits with per-flow undo/redo. `server` is the last saved state of every flow;
 * a draft replaces it until the flow is saved.
 */
export function useDrafts(server: Record<string, FlowDoc>) {
  const [state, setState] = useState<DraftState>(EMPTY)

  const docOf = useCallback((name: string) => state.docs[name] ?? server[name], [state.docs, server])

  const edit = useCallback(
    (name: string, change: (doc: FlowDoc) => FlowDoc) => {
      setState((prev) => {
        const current = prev.docs[name] ?? server[name]
        if (!current) return prev
        const next = change(current)
        if (next === current) return prev
        const past = [...(prev.past[name] ?? []), current].slice(-HISTORY_LIMIT)
        return { docs: { ...prev.docs, [name]: next }, past: { ...prev.past, [name]: past }, future: { ...prev.future, [name]: [] } }
      })
    },
    [server],
  )

  // The current state is the draft, or the saved document once autosave has settled the draft.
  // Undo and redo must work in both cases: the restored state becomes a draft and saves again.
  const undo = useCallback(
    (name: string) => {
      setState((prev) => {
        const past = prev.past[name] ?? []
        const current = prev.docs[name] ?? server[name]
        if (past.length === 0 || !current) return prev
        const previous = past[past.length - 1]
        return {
          docs: { ...prev.docs, [name]: previous },
          past: { ...prev.past, [name]: past.slice(0, -1) },
          future: { ...prev.future, [name]: [current, ...(prev.future[name] ?? [])] },
        }
      })
    },
    [server],
  )

  const redo = useCallback(
    (name: string) => {
      setState((prev) => {
        const future = prev.future[name] ?? []
        const current = prev.docs[name] ?? server[name]
        if (future.length === 0 || !current) return prev
        const [next, ...rest] = future
        return {
          docs: { ...prev.docs, [name]: next },
          past: { ...prev.past, [name]: [...(prev.past[name] ?? []), current] },
          future: { ...prev.future, [name]: rest },
        }
      })
    },
    [server],
  )

  /** Drops the drafts once they are saved (or thrown away). */
  const discard = useCallback((names: string[]) => {
    setState((prev) => {
      const docs = { ...prev.docs }
      const past = { ...prev.past }
      const future = { ...prev.future }
      for (const n of names) {
        delete docs[n]
        delete past[n]
        delete future[n]
      }
      return { docs, past, future }
    })
  }, [])

  /**
 * Drops the draft of `name` only if it is still exactly `saved`. Edits made while `saved` was
 * being written replaced the draft, so they stay dirty and are saved next.
 */
  const settle = useCallback((name: string, saved: FlowDoc) => {
    setState((prev) => {
      if (prev.docs[name] !== saved) return prev
      const docs = { ...prev.docs }
      delete docs[name]
      return { ...prev, docs }
    })
  }, [])

  const dirtyNames = useMemo(() => Object.keys(state.docs), [state.docs])

  return {
    docOf,
    edit,
    undo,
    redo,
    discard,
    settle,
    /** Unsaved documents by flow name. A draft's identity changes with every edit. */
    drafts: state.docs,
    dirtyNames,
    canUndo: (name: string) => (state.past[name]?.length ?? 0) > 0,
    canRedo: (name: string) => (state.future[name]?.length ?? 0) > 0,
  }
}
