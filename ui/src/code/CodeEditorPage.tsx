import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Editor from '@monaco-editor/react'
import { Code2, FileCode, Folder, MessageSquare, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { listCodeFiles, readCodeFile, saveCodeFile } from '@/api/codeEditor'
import type { CodeFile } from '@/api/types'
import { Rail, Topbar } from '@/app/AppShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { configureMonaco } from './monaco'

configureMonaco()

const SCOPE = ['event', 'args', 'user', 'session', 'temp', 'bot', 'bp.logger', 'bp.cms', 'bp.events']

/** Stable key for a file: type, hook folder and location. */
function keyOf(file: CodeFile): string {
  return `${file.type}:${file.hookType ?? ''}:${file.location}`
}

function labelOf(file: CodeFile): string {
  return file.type === 'hook' ? `${file.hookType ?? ''}/${file.location}` : file.name
}

/** Action and hook editor. Files are read and written through the code-editor module API. */
export function CodeEditorPage() {
  const { botId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState<{ key: string; text: string } | null>(null)

  const files = useQuery({ queryKey: ['code-files', botId], queryFn: () => listCodeFiles(botId), enabled: botId !== '' })
  const actions = files.data?.['bot.actions'] ?? []
  const hooks = files.data?.['bot.hooks'] ?? []
  const all = useMemo(() => [...actions, ...hooks], [actions, hooks])
  const requested = params.get('file')
  const file = all.find((f) => keyOf(f) === requested) ?? all[0]
  const key = file ? keyOf(file) : ''

  const content = useQuery({
    queryKey: ['code', botId, key],
    queryFn: () => readCodeFile(botId, file as CodeFile),
    enabled: file !== undefined,
  })

  const text = draft && draft.key === key ? draft.text : (content.data ?? '')
  const dirty = draft !== null && draft.key === key && draft.text !== content.data

  const save = useMutation({
    mutationFn: () => saveCodeFile(botId, file as CodeFile, text),
    onSuccess: () => {
      setDraft(null)
      void queryClient.invalidateQueries({ queryKey: ['code', botId, key] })
    },
  })

  const needle = filter.trim().toLowerCase()
  const groups: { label: string; items: CodeFile[] }[] = [
    { label: 'Actions', items: actions.filter((f) => f.name.toLowerCase().includes(needle)) },
    { label: 'Hooks', items: hooks.filter((f) => labelOf(f).toLowerCase().includes(needle)) },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Topbar
        crumbs={[botId, 'code', file ? labelOf(file) : '...']}
        status={
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn('size-1.5 rounded-full', dirty ? 'bg-amber' : 'bg-green')} />
            {dirty ? 'Unsaved changes' : 'Saved'}
          </span>
        }
        actions={
          <Button variant="outline" onClick={() => navigate(`/bots/${encodeURIComponent(botId)}/flows?emulator=1`)}>
            <MessageSquare /> Emulator
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1">
        <Rail active="code" />
        <aside className="flex w-[264px] shrink-0 flex-col border-r border-border bg-background">
          <div className="flex h-11 items-center px-3">
            <span className="flex-1 text-sm font-semibold">Code</span>
          </div>
          <div className="px-2 pb-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-8" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-px overflow-y-auto px-2 pb-2">
            {groups.map((group) => (
              <div key={group.label} className="flex flex-col gap-px">
                <div className="flex h-7 items-center gap-1.5 px-2 text-[13px] text-muted-foreground">
                  <Folder className="size-3.5" />
                  {group.label}
                </div>
                {group.items.map((f) => {
                  const active = keyOf(f) === key
                  return (
                    <button
                      key={keyOf(f)}
                      type="button"
                      onClick={() => setParams({ file: keyOf(f) })}
                      className={cn('flex h-7 items-center gap-1.5 rounded-md pr-2 pl-6 text-left font-mono-code text-xs hover:bg-muted', active && 'bg-muted font-medium')}
                    >
                      <FileCode className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{labelOf(f)}</span>
                    </button>
                  )
                })}
              </div>
            ))}
            {files.isError && <p role="alert" className="px-2 text-xs text-red">{files.error.message}</p>}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-background">
          {file ? (
            <>
              <div className="flex h-9 items-center gap-2 border-b border-border bg-canvas px-3">
                <span className="flex h-full items-center gap-1.5 border-r border-border bg-background pr-3 font-mono-code text-xs">
                  <Code2 className="size-3.5 text-muted-foreground" />
                  {file.name}
                  {dirty && <span className="size-1.5 rounded-full bg-amber" aria-label="Unsaved" />}
                </span>
                <Badge tone={file.type === 'hook' ? 'text-amber bg-amber-bg' : 'text-violet bg-violet-bg'}>
                  {file.type === 'hook' ? `Hook · ${file.hookType ?? ''}` : 'Action'}
                </Badge>
                <div className="flex-1" />
                <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setDraft(null)}>
                  Discard
                </Button>
                <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
                  Save
                </Button>
              </div>
              {(save.isError || content.isError) && (
                <p role="alert" className="border-b border-border px-3 py-1.5 text-xs text-red">
                  {(save.error ?? content.error)?.message}
                </p>
              )}
              <div className="min-h-0 flex-1">
                {content.isPending ? (
                  <p className="p-4 text-muted-foreground">Loading...</p>
                ) : (
                  <Editor
                    height="100%"
                    path={`bot/${key}`}
                    language="javascript"
                    value={text}
                    theme="vs"
                    onChange={(value) => setDraft({ key, text: value ?? '' })}
                    options={{
                      fontFamily: 'Liberation Mono, Menlo, monospace',
                      fontSize: 12,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      tabSize: 2,
                    }}
                  />
                )}
              </div>
              <div className="flex h-7 items-center gap-2 border-t border-border bg-background px-3 text-[11px] text-muted-foreground">
                <span className="font-medium">Available in this action:</span>
                <span className="font-mono-code">{SCOPE.join('  ')}</span>
              </div>
            </>
          ) : (
            <p className="p-4 text-muted-foreground">{files.isPending ? 'Loading files...' : 'This bot has no actions or hooks yet.'}</p>
          )}
        </section>
      </div>
      <footer className="flex h-[26px] shrink-0 items-center justify-between border-t border-border bg-background px-3 text-[11px] text-muted-foreground">
        <span>{botId}  ·  {file ? `${file.type === 'hook' ? 'hooks' : 'actions'}/${labelOf(file)}` : ''}  ·  JavaScript</span>
        <span>{dirty ? 'Unsaved changes' : ''}</span>
      </footer>
    </div>
  )
}
