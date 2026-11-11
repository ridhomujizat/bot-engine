import type { Transition } from '@/api/types'

/** A node action string is either `say #!<contentId>` or `<action name> <JSON args>`. */
export type NodeAction =
  | { kind: 'say'; contentId: string }
  | { kind: 'code'; name: string; args: string }

const SAY_PREFIX = 'say #!'

export function parseNodeAction(raw: string): NodeAction {
  if (raw.startsWith(SAY_PREFIX)) {
    return { kind: 'say', contentId: raw.slice(SAY_PREFIX.length).trim() }
  }
  const space = raw.indexOf(' ')
  if (space === -1) return { kind: 'code', name: raw, args: '' }
  return { kind: 'code', name: raw.slice(0, space), args: raw.slice(space + 1) }
}

export function formatNodeAction(action: NodeAction): string {
  if (action.kind === 'say') return `${SAY_PREFIX}${action.contentId}`
  return action.args ? `${action.name} ${action.args}` : action.name
}

export function isAlwaysCondition(condition: string): boolean {
  return condition === 'true'
}

/**
 * Pill label for a transition. legacy shows a transition's `caption` when it has one (choice skill
 * transitions: "User picked [..]", "On failure"); otherwise "Always", "Otherwise", or the raw condition.
 */
export function transitionLabel(transition: Transition & { caption?: string }): string {
  if (transition.caption) return transition.caption
  if (transition.condition === 'true') return 'Always'
  if (transition.condition === 'otherwise') return 'Otherwise'
  return transition.condition
}

export type Destination =
  | { kind: 'node'; nodeId: string }
  | { kind: 'return' }
  | { kind: 'end' }
  | { kind: 'flow'; flow: string; node?: string }

/**
 * Interprets a transition target. Transitions name nodes by `name` (not id). A jump into
 * another flow is ` on#node`, a flow file on its own is a subflow, `#` returns and
 * `END` ends the flow.
 */
export function parseDestination(target: string, idByName: ReadonlyMap<string, string>): Destination {
  const nodeId = idByName.get(target)
  if (nodeId !== undefined) return { kind: 'node', nodeId }
  if (target === '#') return { kind: 'return' }
  if (target === 'END') return { kind: 'end' }
  const hash = target.indexOf('#')
  if (hash === -1) return { kind: 'flow', flow: target }
  return { kind: 'flow', flow: target.slice(0, hash), node: target.slice(hash + 1) }
}

/** Text shown on a terminal chip for a non-node destination. */
export function destinationLabel(dest: Exclude<Destination, { kind: 'node' }>): string {
  switch (dest.kind) {
    case 'return':
      return 'Return'
    case 'end':
      return 'End flow'
    case 'flow':
      return dest.node ? `${dest.flow}#${dest.node}` : dest.flow
  }
}

/**
 * Short labels for a code action. The node card shows the name plus the variable it sets
 * ("builtin/setVariable sid"); the inspector shows the assignment ("session.sid =...").
 */
export function codeSummary(name: string, args: string): { pill: string; detail: string | null } {
  if (!args) return { pill: name, detail: null }
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
      const scope = typeof parsed.type === 'string' ? `${parsed.type}.` : ''
      const value = typeof parsed.value === 'string' ? parsed.value : ''
      return { pill: `${name} ${parsed.name}`, detail: `${scope}${parsed.name} = ${value}` }
    }
  } catch {
    /* not JSON: show the raw arguments */
  }
  return { pill: name, detail: args }
}
