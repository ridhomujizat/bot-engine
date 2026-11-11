/**
 * Node geometry, shared by the node components (CSS) and the edge router (SVG).
 * Values come from docs/design/generate.py; every row has a fixed height so that
 * transition ports line up with their pills.
 */
export const NODE_W = 240
export const HEAD_H = 48
export const NODE_PAD = 12
export const SEC_T = 10
export const SEC_B = 12
export const LBL_H = 16
export const GAP = 6
export const PILL_H = 26
export const SEPARATOR_H = 1
export const EDGE_RADIUS = 8
export const EDGE_TIP = 7
/**
 * Terminal pills sit this far right of the node's right border. Handles stand about 9px outside
 * the border and the pill's input handle about 10px inside its left edge, so 80 leaves room for
 * the edge to turn right, go down or up, and turn back into the pill.
 */
export const TERMINAL_OFFSET = 80
/** Gap between columns of an auto-laid-out flow (node width is NODE_W). */
export const COLUMN_GAP = 120
/** Vertical gap between stacked nodes of an auto-laid-out flow. */
export const ROW_GAP = 32
/** Clearance below the lowest node of a backward edge's detour. */
export const ROUTE_CLEARANCE = 24
/** Stagger between parallel edges leaving one port column. */
export const EDGE_LANE_STEP = 18
/** Lead from the source port to the first vertical segment of a route. */
export const EDGE_LEAD = 28
/** How far left of the target port a backward route comes in. */
export const EDGE_APPROACH = 24
export const TERMINAL_H = 28

/** Height of one section: top pad, label, n rows with gaps, bottom pad. */
export function sectionHeight(rows: number): number {
  return SEC_T + LBL_H + rows * (GAP + PILL_H) + SEC_B
}

export interface SectionCounts {
  onEnter: number
  onReceive: number
  transitions: number
}

/**
 * Offset from the top of a node to the centre of transition `index`'s pill.
 * The sections render in order: On enter, On receive, Transitions. A section is
 * only drawn when it has rows, and each drawn section is preceded by a separator.
 */
export function transitionPortOffset(counts: SectionCounts, index: number): number {
  let y = HEAD_H
  y += SEPARATOR_H + sectionHeight(shownRows(counts.onEnter))
  y += SEPARATOR_H + sectionHeight(shownRows(counts.onReceive))
  y += SEPARATOR_H + SEC_T + LBL_H + GAP + index * (GAP + PILL_H) + PILL_H / 2
  return y
}

/** Rows a section draws: its items, or one empty-state row so the section still shows. */
export function shownRows(rows: number): number {
  return Math.max(1, rows)
}

export function nodeHeight(counts: SectionCounts): number {
  let y = HEAD_H
  y += SEPARATOR_H + sectionHeight(shownRows(counts.onEnter))
  y += SEPARATOR_H + sectionHeight(shownRows(counts.onReceive))
  y += SEPARATOR_H + sectionHeight(shownRows(counts.transitions))
  return y
}

export interface EdgeRoute {
  d: string
  /** x of the first vertical segment: where the hover delete button sits. */
  midX: number
  /** Vertical centre of that segment. */
  midY: number
}

export interface EdgeRouteInput {
  sx: number
  sy: number
  tx: number
  ty: number
  /** Index of the edge among its siblings: staggers the vertical segment. */
  lane?: number
  /** y of the detour used when the target lies behind the source. */
  routeY?: number
}

/**
 * Orthogonal (step) route with rounded corners and an arrow tip at the target. Forward edges
 * turn once right of the source and once left of the target. An edge whose target is not
 * clearly to the right of its source detours below both nodes, so the path never runs
 * backwards through the curve radius. The result contains only finite coordinates.
 */
export function routeEdge({ sx, sy, tx, ty, lane = 0, routeY }: EdgeRouteInput): EdgeRoute {
  const tip = tx - 1
  const end = tip - EDGE_TIP
  const dy = ty - sy
 // Forward when the vertical lane fits between the source lead and the target's corner radius.
  const laneMax = end - EDGE_RADIUS
  const forward = laneMax >= sx + EDGE_LEAD
  const midX = forward ? Math.min(sx + EDGE_LEAD + EDGE_LANE_STEP * lane, laneMax) : sx + EDGE_LEAD + EDGE_LANE_STEP * lane

  if (forward) {
    if (Math.abs(dy) < 1) return { d: `M${sx} ${sy} L${end} ${ty}`, midX, midY: sy }
    return {
      d: roundedPolyline([[sx, sy], [midX, sy], [midX, ty], [end, ty]]),
      midX,
      midY: (sy + ty) / 2,
    }
  }

  const detourY = routeY ?? Math.max(sy, ty) + ROUTE_CLEARANCE
  const leftX = tx - EDGE_APPROACH
  return {
    d: roundedPolyline([[sx, sy], [midX, sy], [midX, detourY], [leftX, detourY], [leftX, ty], [end, ty]]),
    midX,
    midY: (sy + detourY) / 2,
  }
}

/** Rounded orthogonal polyline: each corner is cut back by up to EDGE_RADIUS on both sides. */
export function roundedPolyline(points: Array<[number, number]>): string {
  let d = `M${points[0][0]} ${points[0][1]}`
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1]
    const [cx, cy] = points[i]
    const [nx, ny] = points[i + 1]
    const lenIn = Math.hypot(cx - px, cy - py)
    const lenOut = Math.hypot(nx - cx, ny - cy)
    const r = Math.min(EDGE_RADIUS, lenIn / 2, lenOut / 2)
    if (r <= 0) {
      d += ` L${cx} ${cy}`
      continue
    }
    const ax = cx + ((px - cx) / lenIn) * r
    const ay = cy + ((py - cy) / lenIn) * r
    const bx = cx + ((nx - cx) / lenOut) * r
    const by = cy + ((ny - cy) / lenOut) * r
    d += ` L${ax} ${ay} Q${cx} ${cy} ${bx} ${by}`
  }
  const last = points[points.length - 1]
  return `${d} L${last[0]} ${last[1]}`
}

/** Two-point form used by the first edge tests: same geometry as routeEdge. */
export function orthogonalPath(sx: number, sy: number, tx: number, ty: number, lane = 0): EdgeRoute {
  return routeEdge({ sx, sy, tx, ty, lane })
}

/** Length and half-width of the arrow head used by straight edges (kept small, like legacy). */
export const STRAIGHT_ARROW_LEN = 6
export const STRAIGHT_ARROW_HALF = 3.5

export interface StraightRoute {
  /** Line from the source port to the arrow base. */
  d: string
  /** Arrow head polygon, tip on the target port. */
  arrow: string
  /** Midpoint of the straight line: where the hover delete button sits. */
  midX: number
  midY: number
}

/**
 * Straight edge from a source port to a target port (legacy style). The arrow tip is one pixel
 * short of the target port, and the line stops at the arrow base. Works for any direction,
 * including backward edges. Degenerate (zero-length) input yields a point with no arrow.
 */
export function straightRoute(sx: number, sy: number, tx: number, ty: number): StraightRoute {
  const midX = (sx + tx) / 2
  const midY = (sy + ty) / 2
  const len = Math.hypot(tx - sx, ty - sy)
  if (len < 1) return { d: `M${sx} ${sy} L${tx} ${ty}`, arrow: '', midX, midY }
  const ux = (tx - sx) / len
  const uy = (ty - sy) / len
  const px = -uy
  const py = ux
  const tipX = tx - ux
  const tipY = ty - uy
  const baseX = tipX - ux * STRAIGHT_ARROW_LEN
  const baseY = tipY - uy * STRAIGHT_ARROW_LEN
  const arrow = `M${baseX + px * STRAIGHT_ARROW_HALF} ${baseY + py * STRAIGHT_ARROW_HALF} L${tipX} ${tipY} L${baseX - px * STRAIGHT_ARROW_HALF} ${baseY - py * STRAIGHT_ARROW_HALF} z`
  return { d: `M${sx} ${sy} L${baseX} ${baseY}`, arrow, midX, midY }
}

/** Arrow head polygon at the target end of an edge. */
export function arrowPath(tx: number, ty: number): string {
  const tip = tx - 1
  const end = tip - EDGE_TIP
  return `M${end - 1} ${ty - 4.5} L${tip} ${ty} L${end - 1} ${ty + 4.5} z`
}

export interface Point2 {
  x: number
  y: number
}

export function isFinitePoint(p: Partial<Point2> | undefined | null): p is Point2 {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y)
}

export interface LayoutNode {
  id: string
  /** Estimated rendered height (see nodeHeight). */
  height: number
  /** Ids of nodes this node transitions to. Targets outside the input are ignored. */
  targets: string[]
}

/**
 * Places nodes that have no stored position in layers left to right by transition depth.
 * Layer 0 starts at `origin`; each column is NODE_W + COLUMN_GAP wide; nodes in a column stack
 * with ROW_GAP between them, in document order. Only the ids passed in are returned.
 */
export function autoLayout(nodes: LayoutNode[], roots: string[], origin: Point2): Record<string, Point2> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const depth = new Map<string, number>()
  const queue: string[] = []
  const visit = (id: string, d: number) => {
    if (!byId.has(id) || depth.has(id)) return
    depth.set(id, d)
    queue.push(id)
  }
  for (const root of roots) visit(root, 0)
 // Nodes unreachable from the roots start their own layer-0 chains, in document order.
  const drain = () => {
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head]
      for (const t of byId.get(id)!.targets) visit(t, depth.get(id)! + 1)
    }
  }
  drain()
  for (const n of nodes) {
    if (!depth.has(n.id)) {
      visit(n.id, 0)
      drain()
    }
  }

  const columns = new Map<number, LayoutNode[]>()
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0
    columns.set(d, [...(columns.get(d) ?? []), n])
  }
  const out: Record<string, Point2> = {}
  for (const [d, column] of columns) {
    let y = origin.y
    for (const n of column) {
      out[n.id] = { x: origin.x + d * (NODE_W + COLUMN_GAP), y }
      y += n.height + ROW_GAP
    }
  }
  return out
}
