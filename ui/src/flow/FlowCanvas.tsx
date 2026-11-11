import {
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  useStore,
  ConnectionLineType,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeMouseHandler,
  useNodes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { LayoutGrid, Maximize2, Minus, Move, Network, Plus, Square, Zap } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { FlowActionsContext, type FlowActions } from './flowActions'
import { TERMINAL_PREFIX, type FlowRFEdge, type FlowRFNode, type StepEdgeData } from './graph'
import { SkillNode, StandardNode, TerminalNode } from './nodes'
import { StepEdge } from './StepEdge'
import type { Point } from '@/api/types'
import { cn } from '@/lib/utils'
import type { EdgeStyle } from './edgeStyle'
import { objectsOf, overlappingIds, sizesOf, tidyPositions, type TidyMode } from './tidy'

const EDGE_STYLE_OPTIONS: Array<{ value: EdgeStyle; label: string }> = [
  { value: 'straight', label: 'Straight' },
  { value: 'orthogonal', label: 'Orthogonal' },
]

export const NODE_DRAG_TYPE = 'application/x-bot-engine-node'
const DRAG_CLICK_WINDOW_MS = 400
export type NewNodeKind = 'standard' | 'choice'

/** A transition port a link is dragged from: `out` is transition `index` of the node, `in` its input. */
export interface LinkSource {
  nodeId: string
  index: number
  side: 'out' | 'in'
}

export interface CreateMenuRequest {
  /** Where the menu opens (viewport pixels). */
  screen: Point
  /** Where a node created from the menu lands (flow units). */
  flow: Point
  /** Set when the menu follows a link dragged from a port and dropped on empty canvas. */
  link: LinkSource | null
}

export interface CanvasHandlers extends FlowActions {
  onSelect: (nodeIds: string[]) => void
  /** A node was clicked without being dragged: opens its properties. */
  onOpenNode: (nodeId: string) => void
  /** Double click: a choice skill node opens its skill editor, others open properties. */
  onEditNode: (nodeId: string) => void
  onMove: (positions: Record<string, Point>) => void
  onConnect: (sourceId: string, index: number, targetId: string) => void
  onDropNode: (kind: NewNodeKind, position: Point) => void
  onDeleteNodes: (nodeIds: string[]) => void
  /** Selected transitions to delete (Backspace / Delete on a selected edge). */
  onDeleteEdges: (refs: { nodeId: string; index: number }[]) => void
  onOpenCreateMenu: (request: CreateMenuRequest) => void
  /** Pointer position on the canvas, in flow units (paste location). */
  onPointer: (point: Point) => void
  /** The pane was clicked: closes any menu and the properties. */
  onPaneClick: () => void
  /** A short message for the page's notice line (tidy results). */
  onNotice: (text: string) => void
}

export interface CanvasProps {
  nodes: FlowRFNode[]
  edges: FlowRFEdge[]
  /** A node the page wants selected once it exists (a node just dropped or created). */
  selectRequest: string | null
  onSelectRequestDone: () => void
  /** The overlap hint was closed for this flow. */
  hintDismissed: boolean
  onDismissHint: () => void
  /** Drawing style of every edge; a view setting, saved per browser by the page. */
  edgeStyle: EdgeStyle
  onEdgeStyleChange: (style: EdgeStyle) => void
  handlers: CanvasHandlers
}

const nodeTypes = { standard: StandardNode, skill: SkillNode, terminal: TerminalNode }
const edgeTypes = { step: StepEdge }
// Every edge, including the one being dragged, is orthogonal. No bezier fallback anywhere.
const defaultEdgeOptions = { type: 'step' as const }

export function FlowCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}

function Canvas({ nodes, edges, selectRequest, onSelectRequestDone, hintDismissed, onDismissHint, edgeStyle, onEdgeStyleChange, handlers }: CanvasProps) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<FlowRFNode>(nodes)
  const { screenToFlowPosition, zoomIn, zoomOut, fitView, getNodes } = useReactFlow()
  const zoom = useStore((s) => Math.round(s.transform[2] * 100))
  const [tidyOpen, setTidyOpen] = useState(false)
  // Overlaps as drawn: the live nodes carry React Flow's measured sizes once rendered (estimates before).
  const live = useNodes<FlowRFNode>()
  const overlapCount = useMemo(() => overlappingIds(objectsOf(live, edges, sizesOf(live))).length, [live, edges])
 // Edge selection is ours: React Flow reports it through onEdgesChange and the page never stores it.
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set())
 // A press that moved a node is a drag, not a click: it must not open the properties. React Flow
 // may or may not send the click after a drag, so the guard is a short time window, not a flag.
  const dragStart = useRef<Map<string, Point> | null>(null)
  const lastDragEnd = useRef(0)

 // Keep React Flow's own state (drag, selection) while taking structure from the document.
  useEffect(() => {
    setRfNodes((prev) => {
      const selected = new Set(prev.filter((n) => n.selected).map((n) => n.id))
      return nodes.map((n) => ({ ...n, selected: selected.has(n.id) }))
    })
  }, [nodes, setRfNodes])

 // Selection goes through React Flow so its onSelectionChange stays the single source. Setting
 // the node flags directly makes React Flow report an empty selection and the page loses it.
  useEffect(() => {
    if (!selectRequest || !nodes.some((n) => n.id === selectRequest)) return
    onNodesChange([
      ...rfNodes.filter((n) => n.selected && n.id !== selectRequest).map((n) => ({ type: 'select' as const, id: n.id, selected: false })),
      { type: 'select', id: selectRequest, selected: true },
    ])
    onSelectRequestDone()
  }, [nodes, selectRequest, rfNodes, onNodesChange, onSelectRequestDone])

  /**
   * One tidy action is one page edit, so one undo step. The view fits once the moved nodes are drawn.
   * Reads the nodes as React Flow measured them, so the sizes are the rendered ones.
   */
  async function runTidy(mode: TidyMode, selectedOnly: boolean) {
    setTidyOpen(false)
    const current = getNodes() as FlowRFNode[]
    const subset = selectedOnly ? new Set(current.filter((n) => n.selected && n.type !== 'terminal').map((n) => n.id)) : null
    const positions = await tidyPositions(current, edges, mode, subset)
    if (Object.keys(positions).length === 0) {
      handlers.onNotice(mode === 'fix' ? 'No overlaps to fix' : 'Nodes are already tidy')
      return
    }
    handlers.onMove(positions)
    // A tidied flow can be larger than the canvas's default minimum zoom (0.25) shows: allow zooming further out.
    window.setTimeout(() => void fitView({ padding: 0.2, duration: 300, minZoom: 0.1 }), 60)
  }

  const selectedIds = useMemo(() => new Set(rfNodes.filter((n) => n.selected).map((n) => n.id)), [rfNodes])
  const selectedCount = selectedIds.size
  const styledEdges = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        type: 'step',
        selected: selectedEdges.has(e.id),
        data: { ...e.data, highlight: selectedIds.has(e.source), style: edgeStyle } as FlowRFEdge['data'],
      })) as Edge[],
    [edges, selectedIds, selectedEdges, edgeStyle],
  )

  function onEdgesChange(changes: EdgeChange[]) {
    setSelectedEdges((prev) => {
      let next = prev
      for (const change of changes) {
        if (change.type !== 'select') continue
        if (change.selected && !next.has(change.id)) next = new Set(next).add(change.id)
        if (!change.selected && next.has(change.id)) {
          next = new Set(next)
          next.delete(change.id)
        }
      }
      return next
    })
  }

  function onDrop(event: DragEvent) {
    const kind = event.dataTransfer.getData(NODE_DRAG_TYPE) as NewNodeKind
    if (kind !== 'standard' && kind !== 'choice') return
    event.preventDefault()
    const p = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    handlers.onDropNode(kind, p)
  }

  const onNodeClick: NodeMouseHandler = (_event, node) => {
    if (Date.now() - lastDragEnd.current < DRAG_CLICK_WINDOW_MS) return
    handlers.onOpenNode(node.id)
  }

  const onNodeDragStart = (_event: unknown, _node: Node, dragged: Node[]) => {
    dragStart.current = new Map(dragged.map((n) => [n.id, { x: n.position.x, y: n.position.y }]))
  }

  const onNodeDragStop = (_event: unknown, _node: Node, dragged: Node[]) => {
    const start = dragStart.current
    dragStart.current = null
    const moved = dragged.filter((n) => {
      const from = start?.get(n.id)
      return from !== undefined && (from.x !== n.position.x || from.y !== n.position.y)
    })
    if (moved.length === 0) return
    lastDragEnd.current = Date.now()
 // legacy stores positions on the 5-unit grid as integers.
    handlers.onMove(Object.fromEntries(moved.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }])))
  }

  return (
    <FlowActionsContext.Provider value={handlers}>
      <div
        className="relative h-full w-full"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onMouseMove={(e) => handlers.onPointer(screenToFlowPosition({ x: e.clientX, y: e.clientY }))}
      >
        <ReactFlow
          nodes={rfNodes}
          edges={styledEdges}
 // Removal comes from the document (onDelete), never from React Flow's local state: a refused delete must keep the node.
          onNodesChange={(changes) => onNodesChange(changes.filter((c) => c.type !== 'remove'))}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          connectionLineType={ConnectionLineType.SmoothStep}
          fitView
 // legacy DiagramManager sets gridSize 5: dragged nodes land on multiples of 5 and store integers.
          snapToGrid
          snapGrid={[5, 5]}
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.25}
          maxZoom={2}
          deleteKeyCode={['Backspace', 'Delete']}
          connectionLineStyle={{ stroke: '#18181B', strokeWidth: 1.75 }}
          isValidConnection={(c) => !String(c.target).startsWith(TERMINAL_PREFIX)}
          onConnect={(c: Connection) => {
            const index = Number(String(c.sourceHandle).slice(1))
            if (c.source && c.target && Number.isFinite(index)) handlers.onConnect(c.source, index, c.target)
          }}
          onConnectEnd={(event, state) => {
 // Dropped on empty canvas (no handle under the pointer): offer to create the node there and link it.
            if (state.toHandle || !state.fromHandle) return
            const point = 'clientX' in event ? { x: event.clientX, y: event.clientY } : { x: 0, y: 0 }
            const link: LinkSource = {
              nodeId: state.fromNode?.id ?? '',
              index: state.fromHandle.type === 'source' ? Number(String(state.fromHandle.id).slice(1)) : 0,
              side: state.fromHandle.type === 'source' ? 'out' : 'in',
            }
            if (!link.nodeId) return
            handlers.onOpenCreateMenu({ screen: point, flow: screenToFlowPosition(point), link })
          }}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={(_event, node) => handlers.onEditNode(node.id)}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          onPaneClick={() => {
            setTidyOpen(false)
            handlers.onPaneClick()
          }}
          onPaneContextMenu={(event) => {
            event.preventDefault()
            const point = { x: event.clientX, y: event.clientY }
            handlers.onOpenCreateMenu({ screen: point, flow: screenToFlowPosition(point), link: null })
          }}
          onDelete={({ nodes: deletedNodes, edges: deletedEdges }) => {
 // Only transitions the user selected go; edges that merely touch a deleted node stay as dangling targets.
            const gone = new Set(deletedNodes.map((n) => n.id))
            const refs = deletedEdges
              .filter((e) => e.selected && !gone.has(e.source) && e.data !== undefined)
              .map((e) => ({ nodeId: (e.data as StepEdgeData).sourceId, index: (e.data as StepEdgeData).index }))
            if (refs.length > 0) handlers.onDeleteEdges(refs)
            if (deletedNodes.length > 0) handlers.onDeleteNodes([...gone])
          }}
          onSelectionChange={({ nodes: selected }) => handlers.onSelect(selected.map((n) => n.id))}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#D4D4D8" />
          {overlapCount > 0 && !hintDismissed && (
            <Panel position="bottom-center" className="flex items-center gap-2 rounded-full border border-border bg-background py-1 pr-1 pl-3 text-xs shadow-md">
              <div role="status" className="flex items-center gap-2">
                <span>
                  {overlapCount} {overlapCount === 1 ? 'node overlaps' : 'nodes overlap'} —
                </span>
                <button
                  type="button"
                  onClick={() => void runTidy('fix', false)}
                  className="rounded-full bg-primary px-2.5 py-0.5 font-medium text-primary-foreground hover:opacity-90"
                >
                  Fix overlaps
                </button>
              </div>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={onDismissHint}
                className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </Panel>
          )}
          <Panel position="top-left" className="flex w-[116px] flex-col gap-1.5 rounded-xl border border-border bg-background p-2 shadow-md">
            <span className="px-1 text-[11px] font-medium text-muted-foreground">Drag to add</span>
            <PaletteItem kind="standard" label="Node" icon={<Square className="size-2.5 text-white" />} tile="bg-primary" />
            <PaletteItem kind="choice" label="Choice" icon={<Zap className="size-2.5 text-white" />} tile="bg-amber" />
          </Panel>
          <Panel position="bottom-right" className="flex h-9 items-center gap-2 rounded-[10px] border border-border bg-background px-2 shadow-md">
            <span className="text-xs font-medium text-muted-foreground">Edges</span>
            <div role="group" aria-label="Edges: Straight / Orthogonal" className="flex h-6 items-center gap-0.5 rounded-[7px] bg-muted p-[2px]">
              {EDGE_STYLE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={edgeStyle === opt.value}
                  onClick={() => onEdgeStyleChange(opt.value)}
                  className={cn(
                    'h-5 rounded-[5px] px-2 text-xs font-medium',
                    edgeStyle === opt.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </Panel>
          <Panel position="bottom-left" className="flex h-9 items-center gap-1 rounded-[10px] border border-border bg-background px-1 shadow-md">
            <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => zoomOut()}>
              <Minus />
            </Button>
            <span className="w-10 text-center text-xs font-medium text-muted-foreground">{zoom}%</span>
            <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => zoomIn()}>
              <Plus />
            </Button>
            <span className="mx-1 h-4 w-px bg-border" />
            <Button variant="ghost" size="icon-sm" aria-label="Fit view" onClick={() => void fitView({ padding: 0.2 })}>
              <Maximize2 />
            </Button>
            <span className="mx-1 h-4 w-px bg-border" />
            <div className="relative" onKeyDown={(e) => e.key === 'Escape' && setTidyOpen(false)}>
              <Button variant="ghost" aria-haspopup="menu" aria-expanded={tidyOpen} onClick={() => setTidyOpen((open) => !open)}>
                <LayoutGrid /> Tidy up
              </Button>
              {tidyOpen && (
                <div role="menu" aria-label="Tidy up" className="absolute bottom-full left-0 mb-2 flex w-64 flex-col gap-0.5 rounded-xl border border-border bg-background p-1 shadow-md">
                  <TidyItem icon={<Move />} label="Fix overlaps" detail="Keeps your layout, moves only crowded nodes" onSelect={() => void runTidy('fix', false)} />
                  <TidyItem icon={<Network />} label="Auto-arrange" detail="Lays the flow out left to right from the start node" onSelect={() => void runTidy('arrange', false)} />
                  {selectedCount >= 2 && (
                    <>
                      <span className="my-1 h-px bg-border" />
                      <TidyItem icon={<Move />} label="Fix selected" detail={`Only the ${selectedCount} selected nodes move`} onSelect={() => void runTidy('fix', true)} />
                      <TidyItem icon={<Network />} label="Arrange selected" detail={`Lays out the ${selectedCount} selected nodes`} onSelect={() => void runTidy('arrange', true)} />
                    </>
                  )}
                </div>
              )}
            </div>
          </Panel>
        </ReactFlow>
      </div>
    </FlowActionsContext.Provider>
  )
}

function TidyItem({ icon, label, detail, onSelect }: { icon: ReactNode; label: string; detail: string; onSelect: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onSelect} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="text-xs font-medium">{label}</span>
        <span className="text-[11px] leading-4 text-muted-foreground">{detail}</span>
      </span>
    </button>
  )
}

function PaletteItem({ kind, label, icon, tile }: { kind: NewNodeKind; label: string; icon: ReactNode; tile: string }) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(NODE_DRAG_TYPE, kind)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      className="flex h-8 cursor-grab items-center gap-2 rounded-lg border border-border bg-background pr-2.5 pl-1.5 text-xs font-medium active:cursor-grabbing"
    >
      <span className={`flex size-5 items-center justify-center rounded-md ${tile}`}>{icon}</span>
      {label}
    </div>
  )
}
