import { Code2, GripVertical, MessageSquare, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { FlowNodeJson } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { codeSummary, parseNodeAction, transitionLabel } from './actions'

export type ActionSection = 'onEnter' | 'onReceive'

export interface InspectorProps {
  node: FlowNodeJson
  isStart: boolean
  contentLabels: Record<string, string>
  onRename: (name: string) => void
  onSetStart: () => void
  onToggleWait: (on: boolean) => void
  onEditAction: (section: ActionSection, index: number | null) => void
  onRemoveAction: (section: ActionSection, index: number) => void
  onEditTransition: (index: number | null) => void
  onRemoveTransition: (index: number) => void
  onClose: () => void
}

/** Right panel for the selected node: name, then the On enter / On receive / Transitions tabs. */
export function Inspector(props: InspectorProps) {
  const { node, isStart, onRename, onClose } = props
  const [name, setName] = useState(node.name)
  const [tab, setTab] = useState('onEnter')

  useEffect(() => setName(node.name), [node.id, node.name])

  function commitName() {
    const trimmed = name.trim()
    if (trimmed && trimmed !== node.name) onRename(trimmed)
    else setName(node.name)
  }

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-border bg-background">
      <div className="flex h-11 items-center gap-2 border-b border-border px-3.5">
        <span className="flex-1 text-sm font-semibold">Node properties</span>
        <button type="button" aria-label="Close properties" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex flex-col gap-3 overflow-y-auto p-3.5">
        <div className="grid gap-1.5">
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
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{node.type === 'skill-call' ? `Skill ${node.skill ?? ''} · ${node.flow ?? ''}` : 'Standard node'}</span>
          {isStart ? (
            <span className="font-medium text-green">Start node</span>
          ) : (
            <Button variant="ghost" size="sm" onClick={props.onSetStart}>
              Set as start node
            </Button>
          )}
        </div>

        <Tabs value={tab} onValueChange={setTab} className="grid gap-3">
          <TabsList>
            <TabsTrigger value="onEnter">On enter</TabsTrigger>
            <TabsTrigger value="onReceive">On receive</TabsTrigger>
            <TabsTrigger value="transitions">Transitions</TabsTrigger>
          </TabsList>

          <div className="grid gap-2.5">
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
                <p className="text-xs text-muted-foreground">Evaluated in order after On enter / On receive. The first match is followed.</p>
                {node.next.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-lg border border-border bg-background p-2 pl-2">
                    <GripVertical className="size-3.5 shrink-0 text-ring" />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className={cn('truncate text-xs', transitionLabel(t) === t.condition && t.condition !== 'true' ? 'font-mono-code text-[12px]' : 'font-medium')}>
                        {transitionLabel(t)}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">{t.node}</span>
                    </div>
                    <RowButton label="Edit transition" onClick={() => props.onEditTransition(i)}>
                      <Pencil className="size-3.5" />
                    </RowButton>
                    <RowButton label="Delete transition" onClick={() => props.onRemoveTransition(i)}>
                      <Trash2 className="size-3.5" />
                    </RowButton>
                  </div>
                ))}
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
}: { section: ActionSection; actions: string[]; contentLabels: Record<string, string> } & Pick<InspectorProps, 'onEditAction' | 'onRemoveAction'>) {
  return (
    <>
      {actions.map((raw, i) => {
        const action = parseNodeAction(raw)
        const isSay = action.kind === 'say'
        const Icon = isSay ? MessageSquare : Code2
        const title = isSay ? (contentLabels[action.contentId] ?? action.contentId) : action.name
        const subtitle = action.kind === 'code' ? codeSummary(action.name, action.args).detail : null
        return (
          <div key={`${i}-${raw}`} className="flex items-center gap-2 rounded-lg border border-border bg-background p-2">
            <GripVertical className="size-3.5 shrink-0 text-ring" />
            <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-[5px]', isSay ? 'bg-blue-bg' : 'bg-violet-bg')}>
              <Icon className={cn('size-3', isSay ? 'text-blue' : 'text-violet')} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={cn('truncate text-[13px]', !isSay && 'font-mono-code text-xs')}>{title}</span>
              {subtitle && <span className="truncate font-mono-code text-[11px] text-muted-foreground">{subtitle}</span>}
            </div>
            <RowButton label="Edit action" onClick={() => onEditAction(section, i)}>
              <Pencil className="size-3.5" />
            </RowButton>
            <RowButton label="Delete action" onClick={() => onRemoveAction(section, i)}>
              <Trash2 className="size-3.5" />
            </RowButton>
          </div>
        )
      })}
    </>
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
