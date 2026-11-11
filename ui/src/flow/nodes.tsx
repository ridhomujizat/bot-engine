import { Handle, Position, type NodeProps } from '@xyflow/react'
import { ArrowUpRight, Code2, GripVertical, MessageSquare, Play, Square, Undo2, Workflow, Zap } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import type { FlowNodeJson } from '@/api/types'
import { transitionLabel } from './actions'
import { describeAction } from './preview'
import { useFlowActions } from './flowActions'
import type { StandardNodeData, TerminalNodeData, FlowRFNode } from './graph'
import {
  GAP,
  HEAD_H,
  LBL_H,
  NODE_PAD,
  NODE_W,
  PILL_H,
  SEC_B,
  SEC_T,
  SEPARATOR_H,
  transitionPortOffset,
} from './layout'
import { cn } from '@/lib/utils'

const KIND = {
  say: { Icon: MessageSquare, fg: 'text-blue', bg: 'bg-blue-bg' },
  code: { Icon: Code2, fg: 'text-violet', bg: 'bg-violet-bg' },
} as const

function countsOf(node: FlowNodeJson) {
  return {
    onEnter: node.onEnter?.length ?? 0,
    onReceive: node.onReceive?.length ?? 0,
    transitions: node.next.length,
  }
}

/** A clickable row inside a node card: a press that moves the node is a drag and is handled by the canvas. */
function ClickRow({
  label,
  title,
  onOpen,
  className,
  style,
  children,
}: {
  label: string
  title: string
  onOpen: () => void
  className: string
  style: CSSProperties
  children: ReactNode
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        onOpen()
      }}
      className={cn(
        'cursor-pointer outline-none transition-colors hover:border-primary/50 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      style={style}
    >
      {children}
    </div>
  )
}

/** Action row: a coloured kind chip plus a friendly label, in a fixed-height pill. Clicking it edits the action. */
function ActionPill({ raw, nodeId, section, index, contentLabels }: {
  raw: string
  nodeId: string
  section: 'onEnter' | 'onReceive'
  index: number
  contentLabels: Record<string, string>
}) {
  const { openNodeTarget } = useFlowActions()
  const view = describeAction(raw, contentLabels)
  const kind = view.kind === 'say' ? 'say' : 'code'
  const { Icon, fg, bg } = KIND[kind]
  return (
    <ClickRow
      label={`Open action ${view.full}`}
      title={view.full}
      onOpen={() => openNodeTarget(nodeId, { kind: 'action', section, index })}
      className="flex items-center gap-2 rounded-[7px] border border-border bg-canvas pr-2.5 pl-1"
      style={{ height: PILL_H }}
    >
      <span className={cn('flex size-[18px] shrink-0 items-center justify-center rounded-[5px]', bg)}>
        <Icon className={cn('size-2.5', fg)} />
      </span>
      <span className={cn('min-w-0 flex-1 truncate text-xs leading-4', view.mono && 'font-mono-code text-[11px]')}>{view.label}</span>
    </ClickRow>
  )
}

/** A section always renders (the legacy editor shows every section); an empty one shows a dashed placeholder row. */
function Section({ title, children, rows, empty, onEmpty }: {
  title: string
  children: ReactNode
  rows: number
  empty: string
  onEmpty: () => void
}) {
  return (
    <>
      <div className="bg-border" style={{ height: SEPARATOR_H }} />
      <div className="flex min-w-0 flex-col" style={{ padding: `${SEC_T}px ${NODE_PAD}px ${SEC_B}px`, gap: GAP }}>
        <div className="text-[11px] leading-4 font-medium text-muted-foreground" style={{ height: LBL_H }}>
          {title}
        </div>
        {rows > 0 ? children : <EmptyRow text={empty} label={`${title}: ${empty}`} onOpen={onEmpty} />}
      </div>
    </>
  )
}

function EmptyRow({ text, label, onOpen }: { text: string; label: string; onOpen: () => void }) {
  return (
    <ClickRow
      label={label}
      title={text}
      onOpen={onOpen}
      className="flex items-center rounded-[7px] border border-dashed border-border px-2.5 text-[11px] text-muted-foreground"
      style={{ height: PILL_H }}
    >
      <span className="truncate">{text}</span>
    </ClickRow>
  )
}

function NodeFrame({ data, selected, tile, subtitle, node }: {
  data: StandardNodeData
  selected: boolean
  tile: ReactNode
  subtitle: string
  node: FlowNodeJson
}) {
  const { openNodeTarget } = useFlowActions()
  const counts = countsOf(node)
  const active = data.onRun
  const ring = selected ? 'border-primary' : active ? 'border-green' : 'border-border'
  const shadow = selected
    ? 'shadow-[0_0_0_4px_rgba(24,24,27,0.15),0_4px_12px_-2px_rgba(0,0,0,0.1)]'
    : active
      ? 'shadow-[0_0_0_4px_rgba(22,163,74,0.15),0_4px_12px_-2px_rgba(0,0,0,0.1)]'
      : 'shadow-[0_4px_12px_-2px_rgba(0,0,0,0.1)]'

  return (
    <div
      className={cn('relative overflow-visible rounded-xl border-[1.5px] bg-background', ring, shadow)}
      style={{ width: NODE_W }}
    >
      <div className="flex items-center gap-2.5 overflow-hidden rounded-t-xl bg-canvas" style={{ height: HEAD_H, padding: `0 ${NODE_PAD}px` }}>
        {tile}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] leading-4 font-semibold">{node.name}</span>
          <span className="truncate text-[11px] leading-[14px] text-muted-foreground">{subtitle}</span>
        </div>
        <GripVertical className="size-3.5 shrink-0 text-ring" />
      </div>
      <Section
        title="On enter"
        rows={counts.onEnter}
        empty="No actions. Add one in properties"
        onEmpty={() => openNodeTarget(node.id, { kind: 'tab', tab: 'onEnter' })}
      >
        {node.onEnter?.map((raw, i) => (
          <ActionPill key={`e${i}`} raw={raw} nodeId={node.id} section="onEnter" index={i} contentLabels={data.contentLabels} />
        ))}
      </Section>
      <Section
        title="On receive"
        rows={counts.onReceive}
        empty={node.onReceive == null ? 'Not waiting for user input' : 'Waiting. No actions yet'}
        onEmpty={() => openNodeTarget(node.id, { kind: 'tab', tab: 'onReceive' })}
      >
        {node.onReceive?.map((raw, i) => (
          <ActionPill key={`r${i}`} raw={raw} nodeId={node.id} section="onReceive" index={i} contentLabels={data.contentLabels} />
        ))}
      </Section>
      <Section
        title="Transitions"
        rows={counts.transitions}
        empty="No transitions. Add one in properties"
        onEmpty={() => openNodeTarget(node.id, { kind: 'tab', tab: 'transitions' })}
      >
        {node.next.map((t, i) => {
          const always = t.condition === 'true' || t.condition === 'otherwise'
          const open = t.node === ''
          const label = transitionLabel(t)
          return (
            <ClickRow
              key={i}
              label={`Open transition ${label}`}
              title={`${label}${t.node ? ` → ${t.node}` : ''}`}
              onOpen={() => openNodeTarget(node.id, { kind: 'transition', index: i })}
              className="flex items-center gap-2 rounded-[7px] border border-border bg-background px-2.5"
              style={{ height: PILL_H }}
            >
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-xs leading-4',
                  always && !t.caption ? 'font-medium text-muted-foreground' : t.caption ? 'font-medium' : 'font-mono-code text-[11px]',
                )}
              >
                {label}
              </span>
              {open && <span className="shrink-0 text-[10px] text-muted-foreground">not connected</span>}
            </ClickRow>
          )
        })}
      </Section>
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        style={{ top: HEAD_H / 2 }}
      />
      {node.next.map((_, i) => (
        <Handle
          key={`t${i}`}
          id={`t${i}`}
          type="source"
          position={Position.Right}
          style={{ top: transitionPortOffset(counts, i) }}
        />
      ))}
    </div>
  )
}

export function StandardNode({ data, selected }: NodeProps<FlowRFNode>) {
  const d = data as StandardNodeData
  const isStart = d.isStart
  const tile = (
    <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg', isStart ? 'bg-green' : 'bg-primary')}>
      {isStart ? <Play className="size-3 text-white" /> : <Square className="size-3 text-white" />}
    </span>
  )
  return (
    <NodeFrame data={d} selected={selected} tile={tile} node={d.node} subtitle={isStart ? 'Start node' : 'Standard node'} />
  )
}

export function SkillNode({ data, selected }: NodeProps<FlowRFNode>) {
  const d = data as StandardNodeData
  const tile = (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber">
      <Zap className="size-3 text-white" />
    </span>
  )
  return (
    <NodeFrame
      data={d}
      selected={selected}
      tile={tile}
      node={d.node}
      subtitle={`Skill  ·  ${d.node.skill ?? 'choice'}`}
    />
  )
}

/**
 * Transition target that is not a node of this flow. A flow target opens that flow (click, or Enter
 * on the focused pill); return and END have no fixed target and stay plain.
 */
export function TerminalNode({ data }: NodeProps<FlowRFNode>) {
  const d = data as TerminalNodeData
  const { openFlow } = useFlowActions()
  const Icon = d.icon === 'return' ? Undo2 : d.icon === 'end' ? Square : Workflow
  const target = d.target
  const pillClass = 'nodrag nopan flex items-center gap-1.5 rounded-full border border-border bg-background pr-3 pl-2.5 text-xs font-medium text-muted-foreground shadow-sm'
  if (!target) {
    return (
      <div className={pillClass} style={{ height: 28 }}>
        <Icon className="size-3" />
        <span className="max-w-[180px] truncate">{d.label}</span>
        <Handle id="in" type="target" position={Position.Left} style={{ top: 14 }} />
      </div>
    )
  }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open flow ${d.label}`}
      title={`Open ${d.label}`}
      onClick={(e) => {
        e.stopPropagation()
        openFlow(target)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation()
        openFlow(target)
      }}
      className={cn(
        pillClass,
        'group cursor-pointer pr-2.5 outline-none transition-colors hover:border-primary/50 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
      )}
      style={{ height: 28 }}
    >
      <Icon className="size-3" />
      <span className="max-w-[160px] truncate group-hover:underline group-hover:underline-offset-2">{d.label}</span>
      <ArrowUpRight className="size-3 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
      <Handle id="in" type="target" position={Position.Left} style={{ top: 14 }} />
    </div>
  )
}
