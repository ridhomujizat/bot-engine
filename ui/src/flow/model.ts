import { moveItem } from './reorder'
import type { CatchAll, FlowJson, FlowNodeJson, FlowView, Point, Transition, UiJson, UiLink } from '@/api/types'

/**
 * In-memory flow document. `flow` is the `*.json` content without layout;
 * `positions` and `links` are the `*.json` content. Keeping both parts apart
 * means a save writes exactly what was read, plus the edits.
 */
export interface FlowDoc {
  name: string
  /** Everything in the flow file except `nodes`. Unknown keys are kept. */
  meta: Omit<FlowJson, 'nodes'>
  nodes: FlowNodeJson[]
  positions: Record<string, Point>
  links: UiLink[]
}

const FLOW_META_KEYS = ['version', 'catchAll', 'startNode', 'skillData', 'label', 'description'] as const

/** Strips the layout fields Studio adds on the client (`x`, `y`, `lastModified`). */
function stripLayout(node: FlowNodeJson & Partial<Point> & { lastModified?: unknown }): FlowNodeJson {
  const { x: _x, y: _y, lastModified: _lm, ...rest } = node
  return rest
}

/** Builds a document from the `GET /flows` view of one flow. */
export function docFromView(view: FlowView): FlowDoc {
  const { name, location: _location, nodes, links, currentMutex: _mutex, ...flow } = view
  return {
    name,
    meta: flow,
    nodes: nodes.map((node) => stripLayout(node)),
    positions: Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }])),
    links: links ?? [],
  }
}

/** Builds a document from the raw file contents (used by tests and the JSON view). */
export function docFromFiles(name: string, flow: FlowJson, ui: UiJson | undefined): FlowDoc {
  const { nodes, ...meta } = flow
  return {
    name,
    meta,
    nodes,
    positions: Object.fromEntries((ui?.nodes ?? []).map((n) => [n.id, { ...n.position }])),
    links: ui?.links ?? [],
  }
}

/** The `*.json` content. Key order follows Studio's writer. */
export function toFlowJson(doc: FlowDoc): FlowJson {
  const ordered: Record<string, unknown> = {}
  for (const key of FLOW_META_KEYS) {
    if (key in doc.meta) ordered[key] = doc.meta[key]
  }
  for (const [key, value] of Object.entries(doc.meta)) {
    if (!(key in ordered)) ordered[key] = value
  }
  return { ...ordered, nodes: doc.nodes } as FlowJson
}

/**
 * The links the ui file keeps, in legacy's shape: one per transition whose target is a node of this flow
 * (a transition to another flow, to END or to nothing is not drawn). A link that still matches a
 * transition keeps its place and routing points; a new connection is appended, a removed one is dropped.
 */
export function syncLinks(doc: FlowDoc): UiLink[] {
  const idOf = new Map(doc.nodes.map((n) => [n.name, n.id]))
  const wanted: UiLink[] = []
  for (const node of doc.nodes) {
    node.next.forEach((t, i) => {
      const target = idOf.get(t.node)
      if (target !== undefined) wanted.push({ source: node.id, sourcePort: `out${i}`, target, points: [] })
    })
  }
  const key = (l: { source: string; target: string; sourcePort?: unknown }) => `${l.source}|${String(l.sourcePort)}|${l.target}`
  const wantedKeys = new Set(wanted.map(key))
  const kept = doc.links.filter((l) => wantedKeys.has(key(l)))
  const keptKeys = new Set(kept.map(key))
  return [...kept, ...wanted.filter((l) => !keptKeys.has(key(l)))]
}

/**
 * `links` as the ui file keeps them. A skill flow has no `links` key while none is stored: legacy draws
 * no links in a generated skill flow (insertNewSkill and updateSkill carry none), even though its
 * transitions point at each other. Other flows always carry the key.
 */
function uiLinks(doc: FlowDoc): { links?: UiLink[] } {
  if (doc.meta.skillData !== undefined && doc.links.length === 0) return {}
  return { links: syncLinks(doc) }
}

/** The `*.json` content: positions per node plus the stored links. */
export function toUiJson(doc: FlowDoc): UiJson {
  return {
    nodes: doc.nodes.map((node) => ({ id: node.id, position: doc.positions[node.id] ?? { x: 0, y: 0 } })),
    ...uiLinks(doc),
  } as UiJson
}

/** The body Studio's save endpoint expects: nodes carry x/y, the server splits them. */
export function toFlowView(doc: FlowDoc): FlowView {
  return {
    ...doc.meta,
    name: doc.name,
    location: doc.name,
    nodes: doc.nodes.map((node) => ({ ...node, ...(doc.positions[node.id] ?? { x: 0, y: 0 }) })),
    ...uiLinks(doc),
  } as FlowView
}

export function nodeIds(doc: FlowDoc): Set<string> {
  return new Set(doc.nodes.map((node) => node.id))
}

/** Transitions target nodes by name, so this maps a name to the node id that owns it. */
export function idByName(doc: FlowDoc): Map<string, string> {
  return new Map(doc.nodes.map((node) => [node.name, node.id]))
}

export function findNode(doc: FlowDoc, id: string): FlowNodeJson | undefined {
  return doc.nodes.find((node) => node.id === id)
}

/** Replaces one node by id. Other nodes keep their identity. */
export function updateNode(doc: FlowDoc, id: string, patch: (node: FlowNodeJson) => FlowNodeJson): FlowDoc {
  return { ...doc, nodes: doc.nodes.map((node) => (node.id === id ? patch(node) : node)) }
}

export function setTransitions(doc: FlowDoc, id: string, next: Transition[]): FlowDoc {
  return updateNode(doc, id, (node) => ({ ...node, next }))
}

export function addNode(doc: FlowDoc, node: FlowNodeJson, position: Point): FlowDoc {
  return {
    ...doc,
    nodes: [...doc.nodes, node],
    positions: { ...doc.positions, [node.id]: position },
  }
}

export function moveNodes(doc: FlowDoc, moves: Record<string, Point>): FlowDoc {
  return { ...doc, positions: { ...doc.positions, ...moves } }
}

/**
 * Removes nodes. Transitions that name a removed node keep their target, as in legacy (the target
 * shows as a dangling pill). The start node is never removed: callers refuse that first.
 */
export function removeNodes(doc: FlowDoc, ids: ReadonlySet<string>): FlowDoc {
  const nodes = doc.nodes.filter((node) => !ids.has(node.id))
  const positions = { ...doc.positions }
  for (const id of ids) delete positions[id]
  return { ...doc, nodes, positions, links: doc.links.filter((l) => !ids.has(l.source) && !ids.has(l.target)) }
}

export function removeTransition(doc: FlowDoc, nodeId: string, index: number): FlowDoc {
  return updateNode(doc, nodeId, (node) => ({ ...node, next: node.next.filter((_, i) => i !== index) }))
}

/** Unlinks transitions (target ''), keeping them: the condition and the output port stay (legacy link delete). */
export function unlinkTransitions(doc: FlowDoc, refs: readonly { nodeId: string; index: number }[]): FlowDoc {
  let next = doc
  for (const { nodeId, index } of refs) {
    next = updateNode(next, nodeId, (node) => ({ ...node, next: node.next.map((t, i) => (i === index ? { ...t, node: '' } : t)) }))
  }
  return next
}

/** Points transition `index` of `nodeId` at `target` (a node name or a flow destination). */
export function connectTransition(doc: FlowDoc, nodeId: string, index: number, target: string): FlowDoc {
  return updateNode(doc, nodeId, (node) => ({
    ...node,
    next: node.next.map((t, i) => (i === index ? { ...t, node: target } : t)),
  }))
}

/** legacy stores the start node by name, so this writes the node's name. */
export function setStartNode(doc: FlowDoc, id: string): FlowDoc {
  const name = findNode(doc, id)?.name
  if (name === undefined) return doc
  return { ...doc, meta: { ...doc.meta, startNode: name } }
}

export interface PasteItem {
  node: FlowNodeJson
  position: Point
}

/** Flow-wide transitions and on receives (legacy `catchAll`). Missing lists read as empty. */
export function catchAllOf(doc: FlowDoc): CatchAll {
  const c = doc.meta.catchAll as Partial<CatchAll> | undefined
  return { onReceive: c?.onReceive ?? [], next: c?.next ?? [] }
}

export function updateCatchAll(doc: FlowDoc, patch: (c: CatchAll) => CatchAll): FlowDoc {
  return { ...doc, meta: { ...doc.meta, catchAll: patch(catchAllOf(doc)) } }
}

/** Where pasted copies land: their centre moves to `at`, keeping the layout between them. */
export function centredPositions(items: readonly PasteItem[], at: Point): Point[] {
  if (items.length === 0) return []
  const cx = items.reduce((sum, i) => sum + i.position.x, 0) / items.length
  const cy = items.reduce((sum, i) => sum + i.position.y, 0) / items.length
  return items.map((i) => ({ x: Math.round(i.position.x - cx + at.x), y: Math.round(i.position.y - cy + at.y) }))
}

/** legacy util/flows copyName: `name-copy`, then `name-copy-1`, `name-copy-2`... Never a name in `siblings`. */
export function copyName(siblings: readonly string[], name: string): string {
  const candidate = (i: number) => `${name}-copy${i > 0 ? `-${i}` : ''}`
  let i = 0
  while (siblings.includes(candidate(i))) i++
  return candidate(i)
}

/**
 * Pastes copied nodes centred on `at` (legacy requestPasteFlowNode). Each copy gets a new id and a
 * copyName. A transition between two copied nodes points at its copy; any other transition is
 * left unlinked (''), as legacy does. Skill nodes are the caller's job: it gives them new skill flows.
 */
export function pasteNodes(doc: FlowDoc, items: readonly PasteItem[], at: Point, newId: () => string): { doc: FlowDoc; newIds: string[] } {
  if (items.length === 0) return { doc, newIds: [] }
  const siblings = doc.nodes.map((n) => n.name)
  const nameMap = new Map<string, string>()
  const copies = items.map(({ node }) => {
    const name = copyName(siblings, node.name)
    siblings.push(name)
    nameMap.set(node.name, name)
    return { source: node, id: newId(), name }
  })
  const nodes: FlowNodeJson[] = []
  const positions: Record<string, Point> = {}
  const placed = centredPositions(items, at)
  copies.forEach(({ source, id, name }, i) => {
    nodes.push({
      ...structuredClone(source),
      id,
      name,
      next: source.next.map((t) => ({ ...structuredClone(t), node: nameMap.get(t.node) ?? '' })),
    })
    positions[id] = placed[i]
  })
  return {
    doc: { ...doc, nodes: [...doc.nodes, ...nodes], positions: { ...doc.positions, ...positions } },
    newIds: copies.map((c) => c.id),
  }
}

/** Creates a new node id that is not used in the flow. */
export function uniqueNodeId(doc: FlowDoc, base: string): string {
  const existing = nodeIds(doc)
  if (!existing.has(base)) return base
  let n = 2
  while (existing.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/** Removes several transitions at once. Indexes are taken from the original list. */
export function removeTransitions(doc: FlowDoc, refs: readonly { nodeId: string; index: number }[]): FlowDoc {
  let next = doc
  const byNode = new Map<string, number[]>()
  for (const ref of refs) byNode.set(ref.nodeId, [...(byNode.get(ref.nodeId) ?? []), ref.index])
  for (const [nodeId, indexes] of byNode) {
    const drop = new Set(indexes)
    next = updateNode(next, nodeId, (node) => ({ ...node, next: node.next.filter((_, i) => !drop.has(i)) }))
  }
  return next
}

/** Renames a node and points every transition that named the old name at the new one. */
export function renameNode(doc: FlowDoc, id: string, name: string): FlowDoc {
  const old = findNode(doc, id)?.name
  if (old === undefined || old === name) return updateNode(doc, id, (node) => ({ ...node, name }))
  return {
    ...doc,
    nodes: doc.nodes.map((node) => ({
      ...(node.id === id ? { ...node, name } : node),
      next: node.next.map((t) => (t.node === old ? { ...t, node: name } : t)),
    })),
  }
}

/** A node name no other node uses. Names are what transitions point at, so they must be unique. */
export function uniqueNodeName(doc: FlowDoc, base: string): string {
  const taken = new Set(doc.nodes.map((n) => n.name))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/**
 * Moves one action of an on enter / on receive list, or one transition, inside a node (drag or
 * keyboard reorder). A move that changes nothing returns the document itself, so it adds no undo step.
 */
export function moveNodeItem(doc: FlowDoc, id: string, field: 'onEnter' | 'onReceive' | 'next', from: number, to: number): FlowDoc {
  const node = findNode(doc, id)
  const list = node?.[field]
  if (!node || !list) return doc
  const next = moveItem<unknown>(list, from, to) as typeof list
  if (next.every((item, i) => item === list[i])) return doc
  return updateNode(doc, id, (n) => ({ ...n, [field]: next }))
}

/** Moves one flow-wide action or transition (the catch-all list). Same no-op rule as moveNodeItem. */
export function moveCatchAllItem(doc: FlowDoc, field: 'onReceive' | 'next', from: number, to: number): FlowDoc {
  const list = catchAllOf(doc)[field]
  if (!list) return doc
  const next = moveItem<unknown>(list, from, to) as typeof list
  if (next.every((item, i) => item === list[i])) return doc
  return updateCatchAll(doc, (c) => ({ ...c, [field]: next }))
}
