/**
 * Where a terminal pill of a transition leads. A `flow.json` or `flow.json#node` target opens that
 * flow (and selects the node). `#` (return) and `END` have no fixed target, so they do not navigate.
 */
export interface FlowTarget {
  flow: string
  /** Node name inside the target flow, when the target names one. */
  node?: string
}

/** Parses a transition target into a flow target. Null for return, END, empty or a target without a flow. */
export function parseFlowTarget(target: string): FlowTarget | null {
  const value = target.trim()
  if (value === '' || value === '#' || value === 'END') return null
  const hash = value.indexOf('#')
  const flow = (hash === -1 ? value : value.slice(0, hash)).trim()
  if (flow === '') return null
  const node = hash === -1 ? '' : value.slice(hash + 1).trim()
  return node === '' ? { flow } : { flow, node }
}

/**
 * The flow target when the bot has that flow loaded; null otherwise (the pill then shows but cannot
 * be opened).
 */
export function resolveFlowTarget(target: string, flowNames: readonly string[]): FlowTarget | null {
  const parsed = parseFlowTarget(target)
  if (!parsed || !flowNames.includes(parsed.flow)) return null
  return parsed
}

/** Tooltip and accessible text of a pill that opens a flow. */
export function flowTargetLabel(target: FlowTarget): string {
  return target.node ? `${target.flow}#${target.node}` : target.flow
}
