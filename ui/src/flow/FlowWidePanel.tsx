import { GripVertical, Pencil, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { CatchAll } from '@/api/types'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { transitionLabel } from './actions'
import { ActionList, AddButton, RowButton, type ActionSection } from './Inspector'

export interface FlowWidePanelProps {
  catchAll: CatchAll
  contentLabels: Record<string, string>
  onEditAction: (section: ActionSection, index: number | null) => void
  onRemoveAction: (section: ActionSection, index: number) => void
  onEditTransition: (index: number | null) => void
  onRemoveTransition: (index: number) => void
  onClose: () => void
}

/**
 * Properties of the flow itself (legacy "flow-wide transitions / on receives"): transitions and
 * on-receive actions that apply to every node of the flow. Opened from the bar above the canvas.
 */
export function FlowWidePanel(props: FlowWidePanelProps) {
  const { catchAll, onClose } = props
  const [tab, setTab] = useState('onReceive')
  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-border bg-background">
      <div className="flex h-11 items-center gap-2 border-b border-border px-3.5">
        <span className="flex-1 text-sm font-semibold">Flow-wide</span>
        <button type="button" aria-label="Close flow-wide properties" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex flex-col gap-3 overflow-y-auto p-3.5">
        <p className="text-xs text-muted-foreground">Applies to every node of this flow, after the node's own transitions.</p>
        <Tabs value={tab} onValueChange={setTab} className="grid gap-3">
          <TabsList>
            <TabsTrigger value="onReceive">On receive</TabsTrigger>
            <TabsTrigger value="transitions">Transitions</TabsTrigger>
          </TabsList>
          <div className="grid gap-2.5">
            {tab === 'onReceive' && (
              <>
                <p className="text-xs text-muted-foreground">Runs when the user replies on any node of this flow</p>
                <ActionList
                  section="onReceive"
                  actions={catchAll.onReceive ?? []}
                  contentLabels={props.contentLabels}
                  onEditAction={props.onEditAction}
                  onRemoveAction={props.onRemoveAction}
                />
                <AddButton label="Add action" onClick={() => props.onEditAction('onReceive', null)} />
              </>
            )}
            {tab === 'transitions' && (
              <>
                <p className="text-xs text-muted-foreground">Checked after a node's own transitions. The first match is followed.</p>
                {catchAll.next.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-lg border border-border bg-background p-2">
                    <GripVertical className="size-3.5 shrink-0 text-ring" />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className={cn('truncate text-xs', transitionLabel(t) === t.condition && t.condition !== 'true' ? 'font-mono-code text-[12px]' : 'font-medium')}>
                        {transitionLabel(t)}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">{t.node || 'not connected'}</span>
                    </div>
                    <RowButton label="Edit flow-wide transition" onClick={() => props.onEditTransition(i)}>
                      <Pencil className="size-3.5" />
                    </RowButton>
                    <RowButton label="Delete flow-wide transition" onClick={() => props.onRemoveTransition(i)}>
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
