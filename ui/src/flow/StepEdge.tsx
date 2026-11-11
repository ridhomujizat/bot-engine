import { EdgeLabelRenderer, type EdgeProps } from '@xyflow/react'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { FlowRFEdge } from './graph'
import { arrowPath, routeEdge, straightRoute } from './layout'
import { useFlowActions } from './flowActions'

/**
 * Transition edge, drawn in the style chosen on the canvas: orthogonal (rounded right angles) or
 * straight (one line port to port, as in legacy). Hover or selection turns it primary and shows a
 * delete button at the middle of the line.
 */
export function StepEdge({ id, sourceX, sourceY, targetX, targetY, data, selected }: EdgeProps<FlowRFEdge>) {
  const [hover, setHover] = useState(false)
  const actions = useFlowActions()
  const straight = data?.style === 'straight'

  const route = straight
    ? straightRoute(sourceX, sourceY, targetX, targetY)
    : (() => {
        const r = routeEdge({ sx: sourceX, sy: sourceY, tx: targetX, ty: targetY, lane: data?.lane ?? 0, routeY: data?.routeY })
        return { d: r.d, arrow: arrowPath(targetX, targetY), midX: r.midX, midY: r.midY }
      })()
  const { d, arrow, midX, midY } = route

  // Run path (emulator): green. The newest step animates more than the earlier ones; reduced motion keeps the colour only.
  const run = data?.run
  const onRun = run !== undefined
  const hot = hover || selected || Boolean(data?.highlight)
 // Idle edges are light grey and thin (legacy look). Hot and run-path edges stand out.
  const idle = straight ? '#C4C4CB' : '#BDBDC5'
  const color = onRun ? '#16A34A' : hot ? '#18181B' : idle
  const width = run === 'recent' ? 2.75 : onRun ? 2.25 : hot ? 2 : straight ? 1 : 1.25
  const runClass = run === 'recent' ? 'run-edge run-edge-recent' : run === 'past' ? 'run-edge' : undefined

  return (
    <g
      data-edge-id={id}
      data-edge-style={straight ? 'straight' : 'orthogonal'}
      data-run={run ?? undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" className={runClass} />
      {arrow && <path d={arrow} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" />}
      {hover && data && (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label="Delete transition"
            title="Delete transition"
            onMouseEnter={() => setHover(true)}
            onClick={(e) => {
              e.stopPropagation()
              actions.removeTransition(data.sourceId, data.index)
            }}
            className="pointer-events-auto absolute flex size-6 items-center justify-center rounded-full border border-red/40 bg-background shadow-md hover:bg-red/5"
            style={{ transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)` }}
          >
            <Trash2 className="size-3 text-red" />
          </button>
        </EdgeLabelRenderer>
      )}
    </g>
  )
}
