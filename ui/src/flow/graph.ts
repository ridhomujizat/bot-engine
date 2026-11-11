import type { Edge, Node } from '@xyflow/react'
import type { FlowNodeJson } from '@/api/types'
import { destinationLabel, parseDestination } from './actions'
import type { FlowDoc } from './model'
import { idByName } from './model'
import type { EdgeStyle } from './edgeStyle'
import {
  COLUMN_GAP,
  EDGE_LANE_STEP,
  NODE_W,
  ROUTE_CLEARANCE,
  TERMINAL_H,
  TERMINAL_OFFSET,
  autoLayout,
  isFinitePoint,
  nodeHeight,
  transitionPortOffset,
  type Point2,
} from './layout'

export interface StandardNodeData extends Record<string, unknown> {
  node: FlowNodeJson
  isStart: boolean
  contentLabels: Record<string, string>
  onRun: boolean
}

export interface TerminalNodeData extends Record<string, unknown> {
  label: string
  icon: 'flow' | 'return' | 'end'
}

export interface StepEdgeData extends Record<string, unknown> {
  sourceId: string
  index: number
  lane: number
  /** y of the detour a backward edge takes below its nodes. */
  routeY: number
  /** Drawing style, set by the canvas from the user's choice (not saved). */
  style?: EdgeStyle
  onRun: boolean
  highlight: boolean
}

export type FlowRFNode = Node<StandardNodeData | TerminalNodeData, 'standard' | 'skill' | 'terminal'>
export type FlowRFEdge = Edge<StepEdgeData, 'step'>

export const TERMINAL_PREFIX = 'end:'

export function terminalId(sourceId: string, index: number): string {
  return `${TERMINAL_PREFIX}${sourceId}:${index}`
}

export interface GraphInput {
  doc: FlowDoc
  contentLabels: Record<string, string>
  /** Node ids on the emulator's run path. Edges between two of them are drawn green. */
  runPath: ReadonlySet<string>
}

/** Where auto-placed nodes start: the top-left of the flow, or right of the stored nodes. */
function originFor(stored: Record<string, Point2>): Point2 {
  const pts = Object.values(stored)
  if (pts.length === 0) return { x: 100, y: 120 }
  return {
    x: Math.max(...pts.map((p) => p.x + NODE_W)) + COLUMN_GAP,
    y: Math.min(...pts.map((p) => p.y)),
  }
}

/**
 * Converts a flow document into React Flow nodes and edges. Derived data only: nothing here is saved.
 *
 * Positions: a node keeps its stored position when it has finite x and y. Other nodes are
 * auto-laid out and never written back. Edges: every transition yields one step edge whose both
 * ends are real (a node input port or a terminal pill). An edge without resolved, finite
 * endpoints is not emitted.
 */
export function toGraph({ doc, contentLabels, runPath }: GraphInput): { nodes: FlowRFNode[]; edges: FlowRFEdge[] } {
  const names = idByName(doc)
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const countsOf = (node: FlowNodeJson) => ({
    onEnter: node.onEnter?.length ?? 0,
    onReceive: node.onReceive?.length ?? 0,
    transitions: node.next.length,
  })

  const stored: Record<string, Point2> = {}
  for (const node of doc.nodes) {
    const p = doc.positions[node.id]
    if (isFinitePoint(p)) stored[node.id] = { x: p.x, y: p.y }
  }
  const unplaced = doc.nodes.filter((n) => !(n.id in stored))
  const auto = autoLayout(
    unplaced.map((n) => ({
      id: n.id,
      height: nodeHeight(countsOf(n)),
      targets: n.next
        .map((t) => names.get(t.node))
        .filter((id): id is string => id !== undefined && !(id in stored)),
    })),
    typeof doc.meta.startNode === 'string' && names.has(doc.meta.startNode) ? [names.get(doc.meta.startNode) as string] : [],
    originFor(stored),
  )
  const posOf = (id: string): Point2 => stored[id] ?? auto[id]

  const nodes: FlowRFNode[] = []
  const edges: FlowRFEdge[] = []

  for (const node of doc.nodes) {
    const pos = posOf(node.id)
    nodes.push({
      id: node.id,
      type: node.type === 'skill-call' ? 'skill' : 'standard',
      position: { x: pos.x, y: pos.y },
      data: {
        node,
        isStart: doc.meta.startNode === node.name,
        contentLabels,
        onRun: runPath.has(node.id),
      },
    })
  }

  for (const node of doc.nodes) {
    const pos = posOf(node.id)
    const bottom = pos.y + nodeHeight(countsOf(node))
    node.next.forEach((transition, index) => {
 // An unlinked transition (target '') is an open output port: no edge, no pill.
      if (transition.node === '') return
      const dest = parseDestination(transition.node, names)
      const portY = pos.y + transitionPortOffset(countsOf(node), index)
      const sourceX = pos.x + NODE_W

 // A name that is not a node of this flow is shown as a pill with the name, never as a dangling edge.
      const nodeTarget = dest.kind === 'node' && byId.has(dest.nodeId) ? dest.nodeId : null
      const terminalLabel = nodeTarget === null ? (dest.kind === 'node' ? transition.node : destinationLabel(dest)) : null
      const icon = dest.kind === 'return' ? 'return' : dest.kind === 'end' ? 'end' : 'flow'

      const target = nodeTarget ?? terminalId(node.id, index)
      const targetPos: Point2 =
        nodeTarget !== null
          ? posOf(nodeTarget)
          : { x: pos.x + NODE_W + TERMINAL_OFFSET, y: portY - TERMINAL_H / 2 }
      const targetBottom =
        nodeTarget !== null
          ? targetPos.y + nodeHeight(countsOf(byId.get(nodeTarget)!))
          : portY + TERMINAL_H / 2
      const routeY = Math.max(bottom, targetBottom) + ROUTE_CLEARANCE + index * EDGE_LANE_STEP
      const finite = [sourceX, portY, targetPos.x, targetPos.y, routeY].every(Number.isFinite)
      if (!finite) return

      if (terminalLabel !== null) {
        nodes.push({
          id: target,
          type: 'terminal',
          position: { x: targetPos.x, y: targetPos.y },
          data: { label: terminalLabel, icon },
          draggable: false,
          selectable: false,
        })
      }

      edges.push({
        id: `${node.id}:${index}`,
        type: 'step',
        source: node.id,
        sourceHandle: `t${index}`,
        target,
        targetHandle: 'in',
        deletable: true,
        data: {
          sourceId: node.id,
          index,
          lane: index,
          routeY,
          onRun: runPath.has(node.id) && dest.kind === 'node' && runPath.has(dest.nodeId),
          highlight: false,
        },
      })
    })
  }
  return { nodes, edges }
}
