import { X } from 'lucide-react'
import { useState } from 'react'
import type { CatchAll } from '@/api/types'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ActionList, AddButton, TransitionList, type ActionSection } from './Inspector'

export interface FlowWidePanelProps {
  catchAll: CatchAll
  contentLabels: Record<string, string>
  onEditAction: (section: ActionSection, index: number | null) => void
  onRemoveAction: (section: ActionSection, index: number) => void
  onEditTransition: (index: number | null) => void
  onRemoveTransition: (index: number) => void
  onMoveAction: (section: ActionSection, from: number, to: number) => void
  onMoveTransition: (from: number, to: number) => void
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
                  onMoveAction={props.onMoveAction}
                />
                <AddButton label="Add action" onClick={() => props.onEditAction('onReceive', null)} />
              </>
            )}
            {tab === 'transitions' && (
              <>
                <p className="text-xs text-muted-foreground">Checked after a node's own transitions. The first match is followed.</p>
                <TransitionList
                  transitions={catchAll.next}
                  label="Flow-wide transitions"
                  onEdit={props.onEditTransition}
                  onRemove={props.onRemoveTransition}
                  onMove={props.onMoveTransition}
                  editLabel="Edit flow-wide transition"
                  removeLabel="Delete flow-wide transition"
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
