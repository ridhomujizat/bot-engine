import { Code2, Flag, MessageSquare, Pencil, Plus, Square, Trash2, Undo2, Workflow, X, type LucideIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { FlowNodeJson } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { InspectorTab } from './flowActions'
import { describeAction } from './preview'
import { SortableList } from './SortableList'
import { flowTargetLabel, parseFlowTarget } from './navigation'

export type ActionSection = 'onEnter' | 'onReceive'

export interface InspectorProps {
  node: FlowNodeJson
  isStart: boolean
  contentLabels: Record<string, string>
  /** The open tab; the page owns it so a click on a node card can pick the tab. */
  tab: InspectorTab
  onTabChange: (tab: InspectorTab) => void
  onRename: (name: string) => void
  onSetStart: () => void
  onToggleWait: (on: boolean) => void
  onEditAction: (section: ActionSection, index: number | null) => void
  onRemoveAction: (section: ActionSection, index: number) => void
  onEditTransition: (index: number | null) => void
  onRemoveTransition: (index: number) => void
  /** Drag or keyboard reorder of an on enter / on receive action list. One call is one undo step. */
  onMoveAction: (section: ActionSection, from: number, to: number) => void
  /** Drag or keyboard reorder of the transitions. The output ports follow the new order. */
  onMoveTransition: (from: number, to: number) => void
  onClose: () => void
}

/** Right panel for the selected node: name, then the On enter / On receive / Transitions tabs. */
export function Inspector(props: InspectorProps) {
  const { node, isStart, onRename, onClose, tab, onTabChange } = props
  const [name, setName] = useState(node.name)

  useEffect(() => setName(node.name), [node.id, node.name])

  function commitName() {
    const trimmed = name.trim()
    if (trimmed && trimmed !== node.name) onRename(trimmed)
    else setName(node.name)
  }

  return (
    <aside className="flex w-[360px] shrink-0 flex-col overflow-hidden border-l border-border bg-background">
      <div className="flex h-11 items-center gap-2 border-b border-border px-3.5">
        <span className="flex-1 text-sm font-semibold">Node properties</span>
        <button type="button" aria-label="Close properties" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto p-3.5">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="node-name">Node name</Label>
          <Input
            id="node-name"
            className="font-mono-code"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{node.type === 'skill-call' ? `Skill ${node.skill ?? ''} · ${node.flow ?? ''}` : 'Standard node'}</span>
          {isStart ? (
            <span className="font-medium text-green">Start node</span>
          ) : (
            <Button variant="ghost" size="sm" onClick={props.onSetStart}>
              Set as start node
            </Button>
          )}
        </div>

        <Tabs value={tab} onValueChange={(value) => onTabChange(value as InspectorTab)} className="grid min-w-0 gap-3">
          <TabsList>
            <TabsTrigger value="onEnter">On enter</TabsTrigger>
            <TabsTrigger value="onReceive">On receive</TabsTrigger>
            <TabsTrigger value="transitions">Transitions</TabsTrigger>
          </TabsList>

          <div className="grid min-w-0 gap-2.5">
            {tab === 'onEnter' && (
              <>
                <p className="text-xs text-muted-foreground">Runs when the flow arrives at this node</p>
                <ActionList section="onEnter" actions={node.onEnter ?? []} {...props} />
                <AddButton label="Add action" onClick={() => props.onEditAction('onEnter', null)} />
              </>
            )}
            {tab === 'onReceive' && (
              <>
                <div className="flex items-center gap-2.5 text-[13px]">
                  <Switch
                    id="wait-for-user"
                    checked={node.onReceive !== null && node.onReceive !== undefined}
                    onCheckedChange={props.onToggleWait}
                  />
                  <Label htmlFor="wait-for-user" className="font-normal">Wait for user message</Label>
                </div>
                <p className="text-xs text-muted-foreground">Runs when the user replies while on this node</p>
                <ActionList section="onReceive" actions={node.onReceive ?? []} {...props} />
                <AddButton label="Add action" disabled={node.onReceive == null} onClick={() => props.onEditAction('onReceive', null)} />
              </>
            )}
            {tab === 'transitions' && (
              <>
                <p className="text-xs text-muted-foreground">Evaluated in order after On enter / On receive. The first match is followed. Drag to reorder.</p>
                <TransitionList
                  transitions={node.next}
                  label="Transitions"
                  onEdit={props.onEditTransition}
                  onRemove={props.onRemoveTransition}
                  onMove={props.onMoveTransition}
                  editLabel="Edit transition"
                  removeLabel="Delete transition"
                />
                <AddButton label="Add transition" onClick={() => props.onEditTransition(null)} />
              </>
            )}
          </div>
        </Tabs>
      </div>
    </aside>
  )
}

export function ActionList({
  section,
  actions,
  contentLabels,
  onEditAction,
  onRemoveAction,
  onMoveAction,
}: { section: ActionSection; actions: string[]; contentLabels: Record<string, string> } & Pick<InspectorProps, 'onEditAction' | 'onRemoveAction' | 'onMoveAction'>) {
  return (
    <SortableList
      items={actions}
      label={`${section === 'onEnter' ? 'On enter' : 'On receive'} actions`}
      onMove={(from, to) => onMoveAction(section, from, to)}
      render={(raw, i, handle) => {
        const view = describeAction(raw, contentLabels)
        const isSay = view.kind === 'say'
        const Icon = isSay ? MessageSquare : Code2
        return (
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-background p-2">
            {handle}
            <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-[5px]', isSay ? 'bg-blue-bg' : 'bg-violet-bg')}>
              <Icon className={cn('size-3', isSay ? 'text-blue' : 'text-violet')} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span title={view.full} className={cn('truncate text-[13px]', view.mono && 'font-mono-code text-xs')}>
                {view.label}
              </span>
              {view.detail && (
                <span title={view.detail} className="truncate text-[11px] text-muted-foreground">
                  {view.detail}
                </span>
              )}
              {view.badge && (
                <span title={view.badge} className="block max-w-full truncate self-start rounded bg-muted px-1.5 py-px font-mono-code text-[10px] text-muted-foreground">
                  {view.badge}
                </span>
              )}
            </div>
            <RowButton label="Edit action" onClick={() => onEditAction(section, i)}>
              <Pencil className="size-3.5" />
            </RowButton>
            <RowButton label="Delete action" onClick={() => onRemoveAction(section, i)}>
              <Trash2 className="size-3.5" />
            </RowButton>
          </div>
        )
      }}
    />
  )
}

/** Where a transition goes, as an icon and a short text: a node, a subflow, the end, a return, or nothing yet. */
export function describeTarget(target: string): { Icon: LucideIcon; text: string; muted: boolean } {
  if (target === '') return { Icon: Square, text: 'Not connected', muted: true }
  if (target === 'END') return { Icon: Flag, text: 'End flow', muted: false }
  if (target === '#') return { Icon: Undo2, text: 'Return to caller', muted: false }
  const flow = parseFlowTarget(target)
  if (flow && (target.includes('#') || target.endsWith('.json'))) return { Icon: Workflow, text: flowTargetLabel(flow), muted: false }
  return { Icon: Square, text: target, muted: false }
}

/** A transition row's main line: the caption when set, otherwise the condition (in mono). */
function primaryOf(t: { caption?: string; condition: string }): { text: string; className: string } {
  if (t.caption) return { text: t.caption, className: 'font-medium' }
  if (t.condition === 'true') return { text: 'Always', className: 'font-medium' }
  if (t.condition === 'otherwise') return { text: 'Otherwise', className: 'font-medium' }
  return { text: t.condition, className: 'font-mono-code text-[12px]' }
}

/** Reorderable list of transitions (a node's, or the flow-wide ones). */
export function TransitionList({
  transitions,
  label,
  onEdit,
  onRemove,
  onMove,
  editLabel,
  removeLabel,
}: {
  transitions: Array<{ condition: string; node: string; caption?: string }>
  label: string
  onEdit: (index: number) => void
  onRemove: (index: number) => void
  onMove: (from: number, to: number) => void
  editLabel: string
  removeLabel: string
}) {
  return (
    <SortableList
      items={transitions}
      label={label}
      onMove={onMove}
      render={(t, i, handle) => {
        const primary = primaryOf(t)
        const target = describeTarget(t.node)
        return (
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-background p-2">
            {handle}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span title={primary.text} className={cn('truncate text-[13px] leading-5', primary.className)}>
                {primary.text}
              </span>
              <span title={target.text} className={cn('flex min-w-0 items-center gap-1.5 text-xs', target.muted ? 'italic text-muted-foreground' : 'text-muted-foreground')}>
                <target.Icon className="size-3 shrink-0" />
                <span className="truncate">{target.text}</span>
              </span>
            </div>
            <RowButton label={editLabel} onClick={() => onEdit(i)}>
              <Pencil className="size-3.5" />
            </RowButton>
            <RowButton label={removeLabel} onClick={() => onRemove(i)}>
              <Trash2 className="size-3.5" />
            </RowButton>
          </div>
        )
      }}
    />
  )
}

export function RowButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
      {children}
    </button>
  )
}

export function AddButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="outline" className="w-full" onClick={onClick} disabled={disabled}>
      <Plus /> {label}
    </Button>
  )
}
