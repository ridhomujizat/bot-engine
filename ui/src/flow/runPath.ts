import type { FlowDoc } from './model'

/** One visited node from `state.__stacktrace`. `flow` is null when the entry does not name one. */
export interface StackEntry {
  flow: string | null
  node: string
}

/** Edge state on the emulator's run path: `recent` is the last step taken, `past` any earlier one. */
export type RunEdgeState = 'past' | 'recent'

/**
 * Transitions taken on the run path, keyed by edge id (`<sourceId>:<index>`, as the canvas draws them).
 * A step counts when two consecutive stack entries are both in `flowName` and the first node has a
 * transition to the second. The newest such step is `recent`.
 */
export function runEdgeStates(doc: FlowDoc | undefined, stack: readonly StackEntry[], flowName: string): Map<string, RunEdgeState> {
  const states = new Map<string, RunEdgeState>()
  if (!doc || stack.length < 2) return states
  const idOf = new Map(doc.nodes.map((n) => [n.name, n]))
  const here = (e: StackEntry) => e.flow === null || e.flow === flowName
  const steps: string[] = []
  for (let i = 1; i < stack.length; i++) {
    const from = stack[i - 1]
    const to = stack[i]
    if (!here(from) || !here(to)) continue
    const node = idOf.get(from.node)
    if (!node) continue
    const index = node.next.findIndex((t) => t.node === to.node)
    if (index !== -1) steps.push(`${node.id}:${index}`)
  }
  steps.forEach((edge, i) => states.set(edge, i === steps.length - 1 ? 'recent' : 'past'))
  return states
}

/** Node ids on the run path of `flowName` (for the green node cards). */
export function runNodeIds(doc: FlowDoc | undefined, stack: readonly StackEntry[], flowName: string): Set<string> {
  if (!doc) return new Set()
  const byName = new Map(doc.nodes.map((n) => [n.name, n.id]))
  const ids = new Set<string>()
  for (const e of stack) {
    if (e.flow !== null && e.flow !== flowName) continue
    const id = byName.get(e.node)
    if (id) ids.add(id)
  }
  return ids
}
