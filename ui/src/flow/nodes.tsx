import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Code2, GripVertical, MessageSquare, Play, Square, Undo2, Workflow, Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import type { FlowNodeJson } from '@/api/types'
import { codeSummary, parseNodeAction, transitionLabel } from './actions'
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

/** Action row: a coloured kind chip plus the action label, in a fixed-height pill. */
function ActionPill({ raw, contentLabels }: { raw: string; contentLabels: Record<string, string> }) {
  const action = parseNodeAction(raw)
  const kind = action.kind === 'say' ? 'say' : 'code'
  const { Icon, fg, bg } = KIND[kind]
  const text =
    action.kind === 'say' ? (contentLabels[action.contentId] ?? action.contentId) : codeSummary(action.name, action.args).pill
  return (
    <div
      className="flex items-center gap-2 rounded-[7px] border border-border bg-canvas pr-2.5 pl-1"
      style={{ height: PILL_H }}
      title={raw}
    >
      <span className={cn('flex size-[18px] shrink-0 items-center justify-center rounded-[5px]', bg)}>
        <Icon className={cn('size-2.5', fg)} />
      </span>
      <span className={cn('min-w-0 flex-1 truncate text-xs leading-4', kind === 'code' && 'font-mono-code text-[11px]')}>
        {text}
      </span>
    </div>
  )
}

/** A section always renders (legacy shows every section); an empty one shows a dashed placeholder row. */
function Section({ title, children, rows, empty }: { title: string; children: ReactNode; rows: number; empty: string }) {
  return (
    <>
      <div className="bg-border" style={{ height: SEPARATOR_H }} />
      <div className="flex flex-col" style={{ padding: `${SEC_T}px ${NODE_PAD}px ${SEC_B}px`, gap: GAP }}>
        <div className="text-[11px] leading-4 font-medium text-muted-foreground" style={{ height: LBL_H }}>
          {title}
        </div>
        {rows > 0 ? children : <EmptyRow text={empty} />}
      </div>
    </>
  )
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div
      className="flex items-center rounded-[7px] border border-dashed border-border px-2.5 text-[11px] text-muted-foreground"
      style={{ height: PILL_H }}
    >
      {text}
    </div>
  )
}

function NodeFrame({ data, selected, tile, subtitle, node }: {
  data: StandardNodeData
  selected: boolean
  tile: ReactNode
  subtitle: string
  node: FlowNodeJson
}) {
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
      <Section title="On enter" rows={counts.onEnter} empty="No actions. Add one in properties">
        {node.onEnter?.map((raw, i) => <ActionPill key={`e${i}`} raw={raw} contentLabels={data.contentLabels} />)}
      </Section>
      <Section title="On receive" rows={counts.onReceive} empty={node.onReceive == null ? 'Not waiting for user input' : 'Waiting. No actions yet'}>
        {node.onReceive?.map((raw, i) => <ActionPill key={`r${i}`} raw={raw} contentLabels={data.contentLabels} />)}
      </Section>
      <Section title="Transitions" rows={counts.transitions} empty="No transitions. Add one in properties">
        {node.next.map((t, i) => {
          const always = t.condition === 'true' || t.condition === 'otherwise'
          const open = t.node === ''
          return (
            <div
              key={i}
              className="flex items-center gap-2 rounded-[7px] border border-border bg-background px-2.5"
              style={{ height: PILL_H }}
            >
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-xs leading-4',
                  always && !t.caption ? 'font-medium text-muted-foreground' : t.caption ? 'font-medium' : 'font-mono-code text-[11px]',
                )}
              >
                {transitionLabel(t)}
              </span>
              {open && <span className="shrink-0 text-[10px] text-muted-foreground">not connected</span>}
            </div>
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

export function TerminalNode({ data }: NodeProps<FlowRFNode>) {
  const d = data as TerminalNodeData
  const Icon = d.icon === 'return' ? Undo2 : d.icon === 'end' ? Square : Workflow
  return (
    <div
      className="flex items-center gap-1.5 rounded-full border border-border bg-background pr-3 pl-2.5 text-xs font-medium text-muted-foreground shadow-sm"
      style={{ height: 28 }}
    >
      <Icon className="size-3" />
      <span className="max-w-[180px] truncate">{d.label}</span>
      <Handle id="in" type="target" position={Position.Left} style={{ top: 14 }} />
    </div>
  )
}
