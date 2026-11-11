import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/main'
import type { FlowNodeJson, Point } from '@/api/types'
import { COLUMN_GAP, HEAD_H, NODE_W, ROW_GAP, TERMINAL_H, TERMINAL_OFFSET, nodeHeight, transitionPortOffset, type SectionCounts } from './layout'
import type { FlowRFEdge, FlowRFNode, StandardNodeData, StepEdgeData } from './graph'

/**
 * Tidy-up of the flow canvas. Two actions, both pure over the rendered graph (node positions,
 * measured sizes, edges):
 *  - fixOverlaps: keeps the layout, pushes apart only the nodes that overlap or sit closer than MIN_GAP.
 *  - arrange: layered left-to-right layout (elkjs, layered algorithm) from the start node.
 * Positions are always written on the 5-unit grid. Terminal pills (flow, END, return) are not moved on
 * their own: they belong to the node they hang off, so they move with it.
 */

export const MIN_GAP = 24
export const GRID = 5
/** Width of a terminal pill when it has not been measured yet (the pill's label is capped at 180px). */
export const PILL_FALLBACK_W = 160
/** Space kept right of a terminal pill when a node is arranged. */
const PILL_PAD = 16

export type Sizes = Record<string, { w: number; h: number }>
export type TidyMode = 'fix' | 'arrange'

export function snapNearest(v: number): number {
  return Math.round(v / GRID) * GRID
}
const snapUp = (v: number) => Math.ceil(v / GRID - 1e-9) * GRID
const snapDown = (v: number) => Math.floor(v / GRID + 1e-9) * GRID

function countsOf(node: FlowNodeJson): SectionCounts {
  return { onEnter: node.onEnter?.length ?? 0, onReceive: node.onReceive?.length ?? 0, transitions: node.next.length }
}

const isReal = (n: FlowRFNode) => n.type !== 'terminal'

/** Rendered size per node and pill: React Flow's measured size where known, the layout estimate otherwise. */
export function sizesOf(nodes: FlowRFNode[]): Sizes {
  const out: Sizes = {}
  for (const n of nodes) {
    if (isReal(n)) {
      const node = (n.data as StandardNodeData).node
      out[n.id] = { w: NODE_W, h: n.measured?.height || nodeHeight(countsOf(node)) }
    } else {
      out[n.id] = { w: n.measured?.width || PILL_FALLBACK_W, h: n.measured?.height || TERMINAL_H }
    }
  }
  return out
}

/** A movable unit: the node body (parts[0]) and the pills hanging off it, as offsets from its top-left. */
export interface Part {
  dx: number
  dy: number
  w: number
  h: number
}
export interface Obj {
  id: string
  x: number
  y: number
  parts: Part[]
}

/** One object per real node, with its terminal pills as extra parts (owner = the source node). */
export function objectsOf(nodes: FlowRFNode[], edges: FlowRFEdge[], sizes: Sizes): Obj[] {
  const objs = new Map<string, Obj>()
  for (const n of nodes) {
    if (!isReal(n)) continue
    objs.set(n.id, { id: n.id, x: n.position.x, y: n.position.y, parts: [{ dx: 0, dy: 0, w: NODE_W, h: sizes[n.id]?.h ?? TERMINAL_H }] })
  }
  const terminals = new Map(nodes.filter((n) => !isReal(n)).map((n) => [n.id, n]))
  for (const e of edges) {
    const owner = objs.get(e.source)
    const pill = terminals.get(e.target)
    if (!owner || !pill) continue
    const s = sizes[pill.id] ?? { w: PILL_FALLBACK_W, h: TERMINAL_H }
    owner.parts.push({ dx: pill.position.x - owner.x, dy: pill.position.y - owner.y, w: s.w, h: s.h })
  }
  return [...objs.values()]
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const rectOf = (o: Obj, p: Part): Rect => ({ x: o.x + p.dx, y: o.y + p.dy, w: p.w, h: p.h })

/** Gaps between two rectangles per axis: negative when they overlap on that axis. */
function clearance(a: Rect, b: Rect): { gx: number; gy: number } {
  return {
    gx: Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)),
    gy: Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h)),
  }
}

/** Two rectangles conflict when they are closer than `gap` on both axes (gap 0: they overlap). */
function conflicts(a: Rect, b: Rect, gap: number): boolean {
  const { gx, gy } = clearance(a, b)
  return gx < gap && gy < gap
}

function firstConflict(a: Obj, b: Obj, gap: number): [Part, Part] | null {
  for (const pa of a.parts) {
    for (const pb of b.parts) {
      if (conflicts(rectOf(a, pa), rectOf(b, pb), gap)) return [pa, pb]
    }
  }
  return null
}

/** How far `a` (the mover) has to travel in each direction to clear `b` by `gap`. Never negative. */
function pushMoves(a: Rect, b: Rect, gap: number): { down: number; up: number; right: number; left: number } {
  return {
    down: Math.max(0, b.y + b.h + gap - a.y),
    up: Math.max(0, a.y + a.h - (b.y - gap)),
    right: Math.max(0, b.x + b.w + gap - a.x),
    left: Math.max(0, a.x + a.w - (b.x - gap)),
  }
}

/** Ids of the objects that overlap (gap 0) or sit closer than `gap` to another object. */
export function overlappingIds(objs: Obj[], gap = 0): string[] {
  const hit = new Set<string>()
  for (let i = 0; i < objs.length; i++) {
    for (let j = i + 1; j < objs.length; j++) {
      if (objs[i].id === objs[j].id) continue
      if (firstConflict(objs[i], objs[j], gap)) {
        hit.add(objs[i].id)
        hit.add(objs[j].id)
      }
    }
  }
  return [...hit]
}

export interface FixOptions {
  gap?: number
  /** Objects allowed to move. Others are obstacles. Default: all. */
  movable?: ReadonlySet<string>
  maxPasses?: number
}

export interface FixResult {
  /** Only the objects that moved, on the grid. */
  positions: Record<string, Point>
  /** Objects still too close after the passes (0 when the layout is fixed). */
  remaining: number
}

/**
 * Pushes apart the objects that overlap or are closer than the gap, just far enough to clear it.
 * A conflict moves one object: the later one (by y, then x) when both may move, so the order of the
 * layout is kept. Between two movable objects the mover only goes down or right, which settles;
 * against a fixed obstacle it takes the cheapest of the four ways out. Targets snap to the grid in
 * the push direction, so a pushed object never lands closer than the gap. Repeats until nothing conflicts.
 */
export function fixOverlaps(input: Obj[], opts: FixOptions = {}): FixResult {
  const gap = opts.gap ?? MIN_GAP
  const maxPasses = opts.maxPasses ?? 1000
  const objs = input.map((o) => ({ ...o }))
  const start = new Map(objs.map((o) => [o.id, { x: o.x, y: o.y }]))
  const canMove = (o: Obj) => opts.movable === undefined || opts.movable.has(o.id)
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false
    for (let i = 0; i < objs.length; i++) {
      for (let j = i + 1; j < objs.length; j++) {
        const A = objs[i]
        const B = objs[j]
        if (A.id === B.id) continue
        const hit = firstConflict(A, B, gap)
        if (!hit) continue
        const aMove = canMove(A)
        const bMove = canMove(B)
        if (!aMove && !bMove) continue
        const aLater = A.y > B.y || (A.y === B.y && A.x > B.x)
        const mover = aMove && bMove ? (aLater ? A : B) : aMove ? A : B
        const other = mover === A ? B : A
        const [mp, op] = mover === A ? hit : [hit[1], hit[0]]
        const mr = rectOf(mover, mp)
        const or = rectOf(other, op)
        const moves = pushMoves(mr, or, gap)
        if (canMove(other)) {
          // Two movable objects: only down or right, so the pair settles instead of bouncing.
          if (moves.down <= moves.right) {
            mover.y = snapUp(or.y + or.h + gap - mp.dy)
            mover.x = snapNearest(mover.x)
          } else {
            mover.x = snapUp(or.x + or.w + gap - mp.dx)
            mover.y = snapNearest(mover.y)
          }
        } else {
          // Against a fixed obstacle: the cheapest of the four ways out (ties: down, up, right, left).
          const best = Math.min(moves.down, moves.up, moves.right, moves.left)
          if (best === moves.down || best === moves.up) {
            mover.y = best === moves.down ? snapUp(or.y + or.h + gap - mp.dy) : snapDown(or.y - gap - mr.h - mp.dy)
            mover.x = snapNearest(mover.x)
          } else {
            mover.x = best === moves.right ? snapUp(or.x + or.w + gap - mp.dx) : snapDown(or.x - gap - mr.w - mp.dx)
            mover.y = snapNearest(mover.y)
          }
        }
        changed = true
      }
    }
    if (!changed) break
  }
  const positions: Record<string, Point> = {}
  for (const o of objs) {
    const s = start.get(o.id)!
    if (o.x !== s.x || o.y !== s.y) positions[o.id] = { x: o.x, y: o.y }
  }
  return { positions, remaining: overlappingIds(objs, gap).length }
}

// ---- Auto-arrange (elkjs layered) -------------------------------------------------------------

const ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.spacing.nodeNode': String(ROW_GAP),
  'elk.layered.spacing.nodeNodeBetweenLayers': String(COLUMN_GAP),
  // Between a node and a layer that only carries edges (dummies). Left at the default (20), nodes two layers apart clash.
  'elk.layered.spacing.edgeNodeBetweenLayers': String(COLUMN_GAP),
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  // Measured on two dense flows (chord crossings): DEPTH_FIRST cycle breaking and network simplex
  // placement cut crossings from 9 to 4 and from 36 to 15 against the defaults.
  'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.thoroughness': '100',
}

interface Port {
  /** Offset of the transition's pill centre from the node top (transitionPortOffset). */
  y: number
  /** Width of the terminal pill this transition shows, if any. */
  pillW: number | null
  /** Target node id when the transition links to a node of the laid-out set. */
  target: string | null
}
interface ArrangeNode {
  id: string
  h: number
  isStart: boolean
  ports: Port[]
}

const portIn = (id: string) => `${id}~in`
const portOut = (id: string, i: number) => `${id}~out${i}`

/**
 * Lays out one group of nodes with ELK. Returns top-left positions relative to the group's origin.
 * ELK centres the nodes of a layer, so nodes of different widths would not share a left edge. The
 * ELK pass therefore uses the plain node width, and the columns are placed afterwards: each column
 * is as wide as its widest pill reservation, so pills never reach the next column.
 */
async function layoutGroup(group: ArrangeNode[], first: string | undefined): Promise<Record<string, Point>> {
  const ids = new Set(group.map((a) => a.id))
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: ELK_OPTIONS,
    children: group.map((a) => {
      return {
        id: a.id,
        width: NODE_W,
        height: a.h,
        layoutOptions: {
          'elk.portConstraints': 'FIXED_POS',
          ...(a.id === first ? { 'elk.layered.layering.layerConstraint': 'FIRST' } : {}),
        },
        ports: [
          { id: portIn(a.id), x: 0, y: HEAD_H / 2, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'WEST' } },
          ...a.ports.map((p, i) => ({ id: portOut(a.id, i), x: NODE_W, y: p.y, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'EAST' } })),
        ],
      }
    }),
    // Edges into the first node are left out: it is a source for the layering, so the first layer holds it.
    edges: group.flatMap((a) =>
      a.ports.flatMap((p, i): ElkExtendedEdge[] =>
        p.target !== null && ids.has(p.target) && p.target !== first
          ? [{ id: `${a.id}~e${i}`, sources: [portOut(a.id, i)], targets: [portIn(p.target)] }]
          : [],
      ),
    ),
  }
  const res = await new ELK().layout(graph)
  const children = (res.children ?? []).map((c) => ({ id: c.id, x: c.x ?? 0, y: c.y ?? 0 }))
  if (children.length === 0) return {}
  const minY = Math.min(...children.map((c) => c.y))
  // Columns: nodes that share an ELK x. Each starts after the previous column's width and the column gap.
  const xs = [...new Set(children.map((c) => c.x))].sort((p, q) => p - q)
  const reserve = new Map<number, number>()
  for (const c of children) {
    const a = group.find((g) => g.id === c.id)!
    const pillW = a.ports.reduce<number | null>((m, p) => (p.pillW === null ? m : Math.max(m ?? 0, p.pillW)), null)
    const room = pillW === null ? 0 : TERMINAL_OFFSET + pillW + PILL_PAD
    reserve.set(c.x, Math.max(reserve.get(c.x) ?? 0, room))
  }
  const colX = new Map<number, number>()
  let x = 0
  for (const cx of xs) {
    colX.set(cx, x)
    x += NODE_W + (reserve.get(cx) ?? 0) + COLUMN_GAP
  }
  return Object.fromEntries(children.map((c) => [c.id, { x: colX.get(c.x)!, y: c.y - minY }]))
}

export interface ArrangeOptions {
  /** Lay out only these nodes (the others stay where they are). */
  subset?: ReadonlySet<string>
  /** Top-left of the laid-out block. */
  origin: Point
}

/**
 * Layered left-to-right layout. The start node is the first layer; nodes reachable from it follow in
 * transition depth; nodes it cannot reach (disconnected) are laid out as a block below. A node's box
 * reserves its terminal pill's room. Positions come back on the grid.
 */
export async function arrange(nodes: FlowRFNode[], edges: FlowRFEdge[], sizes: Sizes, opts: ArrangeOptions): Promise<Record<string, Point>> {
  const reals = nodes.filter(isReal)
  const realIds = new Set(reals.map((n) => n.id))
  const included = reals.filter((n) => !opts.subset || opts.subset.has(n.id))
  const inc = new Set(included.map((n) => n.id))
  const info = new Map<string, ArrangeNode>()
  for (const n of included) {
    const d = n.data as StandardNodeData
    const counts = countsOf(d.node)
    info.set(n.id, {
      id: n.id,
      h: sizes[n.id]?.h ?? nodeHeight(counts),
      isStart: d.isStart,
      ports: d.node.next.map((_, i) => ({ y: transitionPortOffset(counts, i), pillW: null, target: null })),
    })
  }
  for (const e of edges) {
    const src = info.get(e.source)
    if (!src) continue
    const port = src.ports[(e.data as StepEdgeData).index]
    if (!port) continue
    if (realIds.has(e.target)) {
      if (inc.has(e.target)) port.target = e.target
    } else {
      port.pillW = sizes[e.target]?.w ?? PILL_FALLBACK_W
    }
  }

  const list = included.map((n) => info.get(n.id)!)
  const startId = opts.subset ? undefined : list.find((a) => a.isStart)?.id
  let main: ArrangeNode[] = []
  let rest = list
  if (startId !== undefined) {
    const reach = new Set([startId])
    const queue = [startId]
    for (let k = 0; k < queue.length; k++) {
      for (const p of info.get(queue[k])!.ports) {
        if (p.target !== null && !reach.has(p.target)) {
          reach.add(p.target)
          queue.push(p.target)
        }
      }
    }
    main = list.filter((a) => reach.has(a.id))
    rest = list.filter((a) => !reach.has(a.id))
  }

  const pos = new Map<string, Point>()
  if (main.length > 0) {
    const laid = await layoutGroup(main, startId)
    // The start node is the first column. When it is alone there (the usual case), it goes to the top of that
    // column, so it is the top-left node of the flow.
    const firstColumn = Object.keys(laid).filter((id) => laid[id].x === 0)
    if (startId !== undefined && firstColumn.length === 1 && firstColumn[0] === startId) laid[startId] = { x: 0, y: 0 }
    for (const [id, p] of Object.entries(laid)) pos.set(id, { x: p.x + opts.origin.x, y: p.y + opts.origin.y })
  }
  const mainBottom = main.reduce((m, a) => Math.max(m, pos.get(a.id)!.y + a.h), opts.origin.y)
  if (rest.length > 0) {
    const restOrigin = main.length > 0 ? { x: opts.origin.x, y: mainBottom + COLUMN_GAP } : opts.origin
    const laid = await layoutGroup(rest, undefined)
    for (const [id, p] of Object.entries(laid)) pos.set(id, { x: p.x + restOrigin.x, y: p.y + restOrigin.y })
  }
  return Object.fromEntries([...pos].map(([id, p]) => [id, { x: snapNearest(p.x), y: snapNearest(p.y) }]))
}

/**
 * Positions to write for a tidy action: only nodes whose position changes. `subset` limits the action
 * to the selected nodes (the others are obstacles). Arrange runs the fix pass afterwards as a safety net.
 */
export async function tidyPositions(
  nodes: FlowRFNode[],
  edges: FlowRFEdge[],
  mode: TidyMode,
  subset: ReadonlySet<string> | null,
): Promise<Record<string, Point>> {
  const sizes = sizesOf(nodes)
  const objs = objectsOf(nodes, edges, sizes)
  const current = new Map(nodes.map((n) => [n.id, n.position]))
  const changed = (out: Record<string, Point>) =>
    Object.fromEntries(Object.entries(out).filter(([id, p]) => current.get(id)?.x !== p.x || current.get(id)?.y !== p.y))

  if (mode === 'fix') {
    return changed(fixOverlaps(objs, { movable: subset ?? undefined }).positions)
  }

  const scope = nodes.filter((n) => isReal(n) && (!subset || subset.has(n.id)))
  const origin = {
    x: Math.min(...scope.map((n) => n.position.x)),
    y: Math.min(...scope.map((n) => n.position.y)),
  }
  const laid = await arrange(nodes, edges, sizes, { subset: subset ?? undefined, origin })
  const applied = objs.map((o) => (laid[o.id] ? { ...o, x: laid[o.id].x, y: laid[o.id].y } : o))
  const fixed = fixOverlaps(applied, { movable: new Set(Object.keys(laid)) }).positions
  const out: Record<string, Point> = {}
  for (const id of Object.keys(laid)) out[id] = fixed[id] ?? laid[id]
  return changed(out)
}
