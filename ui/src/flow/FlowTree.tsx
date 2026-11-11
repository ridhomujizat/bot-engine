import { ChevronDown, ChevronRight, Copy, FileJson, Folder, Pencil, Plus, Search, Trash2, Workflow } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface FlowTreeProps {
  names: string[]
  activeName: string
  dirtyNames: ReadonlySet<string>
  onSelect: (name: string) => void
  onNew: () => void
  onDelete: (name: string) => void
  onRename: (name: string) => void
  onDuplicate: (name: string) => void
}

interface Group {
  folder: string | null
  names: string[]
}

/** Flow list in the left panel: root flows first, then one collapsible group per folder. */
export function FlowTree({ names, activeName, dirtyNames, onSelect, onNew, onDelete, onRename, onDuplicate }: FlowTreeProps) {
  const [filter, setFilter] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())

  const groups = useMemo<Group[]>(() => {
    const needle = filter.trim().toLowerCase()
    const visible = names.filter((n) => n.toLowerCase().includes(needle)).sort()
    const root = visible.filter((n) => !n.includes('/'))
    const folders = new Map<string, string[]>()
    for (const n of visible.filter((x) => x.includes('/'))) {
      const folder = n.slice(0, n.indexOf('/'))
      folders.set(folder, [...(folders.get(folder) ?? []), n])
    }
    return [
      { folder: null, names: root },
      ...[...folders.entries()].map(([folder, list]) => ({ folder, names: list })),
    ]
  }, [names, filter])

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-border bg-background">
      <div className="flex h-11 items-center gap-2 pr-2 pl-3">
        <span className="flex-1 text-sm font-semibold">Flows</span>
        <Button variant="ghost" size="icon-sm" aria-label="New flow" onClick={onNew}>
          <Plus />
        </Button>
      </div>
      <div className="px-2 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Filter flows" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-col gap-px overflow-y-auto px-2 pb-2">
        {groups.map((group) => {
          const isClosed = group.folder !== null && closed.has(group.folder)
          return (
            <div key={group.folder ?? '/'} className="flex flex-col gap-px">
              {group.folder !== null && (
                <button
                  type="button"
                  onClick={() =>
                    setClosed((prev) => {
                      const next = new Set(prev)
                      if (next.has(group.folder as string)) next.delete(group.folder as string)
                      else next.add(group.folder as string)
                      return next
                    })
                  }
                  className="flex h-7 items-center gap-1.5 rounded-md px-2 text-left text-[13px] hover:bg-muted"
                >
                  {isClosed ? <ChevronRight className="size-3 text-muted-foreground" /> : <ChevronDown className="size-3 text-muted-foreground" />}
                  <Folder className="size-3.5 text-muted-foreground" />
                  {group.folder}
                </button>
              )}
              {!isClosed &&
                group.names.map((name) => {
                  const active = name === activeName
                  const label = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name
                  return (
                    <div
                      key={name}
                      className={cn(
                        'group flex h-7 items-center gap-1.5 rounded-md pr-1 text-[13px] hover:bg-muted',
                        active && 'bg-muted font-medium',
                        group.folder !== null && 'pl-6',
                        group.folder === null && 'pl-2',
                      )}
                    >
                      <button type="button" onClick={() => onSelect(name)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                        {name.endsWith('.json') && name.startsWith('skills/') ? (
                          <FileJson className="size-3.5 text-muted-foreground" />
                        ) : (
                          <Workflow className={cn('size-3.5', active ? 'text-foreground' : 'text-muted-foreground')} />
                        )}
                        <span className="truncate">{label.replace(/\.flow\.json$/, '')}</span>
                        {dirtyNames.has(name) && <span className="size-1.5 shrink-0 rounded-full bg-amber" aria-label="Unsaved" />}
                      </button>
                      {name === 'main.flow.json' && <Badge tone="text-green bg-green-bg">Start</Badge>}
                      <button
                        type="button"
                        aria-label={`Rename ${name}`}
                        onClick={() => onRename(name)}
                        className="hidden rounded p-0.5 text-muted-foreground hover:text-foreground group-hover:block"
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Duplicate ${name}`}
                        onClick={() => onDuplicate(name)}
                        className="hidden rounded p-0.5 text-muted-foreground hover:text-foreground group-hover:block"
                      >
                        <Copy className="size-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${name}`}
                        onClick={() => onDelete(name)}
                        className="hidden rounded p-0.5 text-muted-foreground hover:text-red group-hover:block"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
