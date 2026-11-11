import { useMutation } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { saveContentElement } from '@/api/studio'
import type { ActionDef, ContentElement } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioItem } from '@/components/ui/radio-group'
import { Select } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { formatNodeAction, parseNodeAction } from './actions'
import { ContentForm, contentPreview, emptyFormData } from './ContentForm'

export interface ActionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  botId: string
  section: 'On enter' | 'On receive'
  /** The action being edited, or null when adding one. */
  initial: string | null
  actions: ActionDef[]
  contents: ContentElement[]
  onSubmit: (raw: string) => void
}

/** Add or edit one node action: "Say something" (content element) or "Execute code" (bot action). */
export function ActionDialog(props: ActionDialogProps) {
  const { open, onOpenChange, initial, section } = props
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[560px]"
        title={initial ? 'Edit action' : 'Add action'}
        description={`Runs when the flow arrives at this node (${section}).`}
      >
        {open && <ActionForm key={initial ?? 'new'} {...props} />}
      </DialogContent>
    </Dialog>
  )
}

function ActionForm({ botId, initial, actions, contents, onSubmit, onOpenChange }: ActionDialogProps) {
  const parsed = initial ? parseNodeAction(initial) : null
  const [kind, setKind] = useState<'say' | 'code'>(parsed?.kind ?? 'say')
  const done = (raw: string) => {
    onSubmit(raw)
    onOpenChange(false)
  }

  return (
    <>
      <RadioGroup value={kind} onValueChange={(v) => setKind(v as 'say' | 'code')} className="flex gap-5">
        <RadioItem value="say">Say something</RadioItem>
        <RadioItem value="code">Execute code</RadioItem>
      </RadioGroup>
      {kind === 'say' ? (
        <SayForm
          botId={botId}
          existingId={parsed?.kind === 'say' ? parsed.contentId : null}
          contents={contents}
          onDone={done}
        />
      ) : (
        <CodeForm initial={parsed?.kind === 'code' ? parsed : null} actions={actions} onDone={done} />
      )}
    </>
  )
}

function SayForm({
  botId,
  existingId,
  contents,
  onDone,
}: {
  botId: string
  existingId: string | null
  contents: ContentElement[]
  onDone: (raw: string) => void
}) {
  const existing = contents.find((c) => c.id === existingId)
  const [tab, setTab] = useState(existing ? 'pick' : 'create')
  const [picked, setPicked] = useState(existingId ?? '')
  const [contentType, setContentType] = useState(existing?.contentType ?? 'builtin_text')
  const [formData, setFormData] = useState<Record<string, unknown>>(existing?.formData ?? emptyFormData('builtin_text'))

  const save = useMutation({
    mutationFn: () =>
      tab === 'pick'
        ? Promise.resolve(picked)
        : saveContentElement(botId, contentType, existing ? existing.id : null, formData),
    onSuccess: (id) => onDone(formatNodeAction({ kind: 'say', contentId: id })),
  })

  const canSubmit = tab === 'pick' ? Boolean(picked) : contentPreview(contentType, formData).length > 0

  return (
    <>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="create">Create new</TabsTrigger>
          <TabsTrigger value="pick">Pick existing</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'pick' ? (
        <div className="grid gap-1.5">
          <Label htmlFor="pick-content">Content element</Label>
          <Select id="pick-content" value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">Choose a message</option>
            {contents.map((c) => (
              <option key={c.id} value={c.id}>
                {c.contentType.replace('builtin_', '')}: {contentPreview(c.contentType, c.formData)}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <ContentForm
          botId={botId}
          contentType={contentType}
          formData={formData}
          onContentType={(t) => {
            setContentType(t)
            setFormData(emptyFormData(t))
          }}
          onFormData={setFormData}
        />
      )}

      {save.isError && <p role="alert" className="text-[13px] text-red">{save.error.message}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button disabled={!canSubmit || save.isPending} onClick={() => save.mutate()}>
          {existing ? 'Save action' : 'Add action (Alt+Enter)'}
        </Button>
      </div>
    </>
  )
}

function CodeForm({
  initial,
  actions,
  onDone,
}: {
  initial: { name: string; args: string } | null
  actions: ActionDef[]
  onDone: (raw: string) => void
}) {
  const initialRows = parseRows(initial?.args ?? '')
  const [name, setName] = useState(initial?.name ?? actions[0]?.name ?? '')
  const [rows, setRows] = useState<ParamRow[]>(initialRows ?? paramRowsOf(actions, initial?.name ?? actions[0]?.name ?? ''))
  const [rawMode, setRawMode] = useState(initialRows === null && Boolean(initial?.args))
  const [rawArgs, setRawArgs] = useState(initial?.args ?? '')

  const categories = [...new Set(actions.map((a) => a.category ?? 'Other'))]

  function submit() {
    const args = rawMode ? rawArgs.trim() : rowsToArgs(rows)
    onDone(args ? `${name} ${args}` : name)
  }

  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor="action-name">Action</Label>
        <Select
          id="action-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
 // Start from the action's declared parameters, unless the user already typed some.
            if (rows.every((r) => !r.key && !r.value)) setRows(paramRowsOf(actions, e.target.value))
          }}
        >
          {categories.map((category) => (
            <optgroup key={category} label={category}>
              {actions
                .filter((a) => (a.category ?? 'Other') === category)
                .map((a) => (
                  <option key={a.name} value={a.name}>{a.name}</option>
                ))}
            </optgroup>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">Store a value in temp, session, user or bot memory.</p>
      </div>

      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <Label>Action parameters</Label>
          <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setRawMode((v) => !v)}>
            {rawMode ? 'Use table' : 'Edit raw JSON'}
          </button>
        </div>
        {rawMode ? (
          <Textarea aria-label="Raw arguments" className="font-mono-code text-xs" rows={4} value={rawArgs} onChange={(e) => setRawArgs(e.target.value)} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="grid grid-cols-[150px_1fr] bg-canvas text-xs font-medium text-muted-foreground">
              <div className="px-2.5 py-2">Parameter</div>
              <div className="border-l border-border px-2.5 py-2">Value</div>
            </div>
            {rows.map((row, i) => (
              <div key={i} className="grid grid-cols-[150px_1fr_auto] border-t border-border">
                <Input
                  aria-label="Parameter name"
                  className="rounded-none border-0 font-mono-code text-xs"
                  value={row.key}
                  onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                />
                <Input
                  aria-label="Parameter value"
                  className="rounded-none border-0 border-l font-mono-code text-xs"
                  value={row.value}
                  onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                />
                <button type="button" aria-label="Remove parameter" className="px-2 text-muted-foreground hover:text-red" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setRows([...rows, { key: '', value: '' }])} className="flex w-full items-center gap-1.5 border-t border-border px-2.5 py-2 text-xs text-muted-foreground hover:bg-muted">
              <Plus className="size-3" /> Add parameter
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button disabled={!name} onClick={submit}>Add action (Alt+Enter)</Button>
      </div>
    </>
  )
}

interface ParamRow {
  key: string
  value: string
}

/** Empty rows named after the action's declared parameters. */
function paramRowsOf(actions: ActionDef[], name: string): ParamRow[] {
  const params = actions.find((a) => a.name === name)?.params ?? []
  return params.length > 0 ? params.map((p) => ({ key: p.name, value: '' })) : [{ key: '', value: '' }]
}

/** Parses `{"k":"v"}` into table rows. Returns null when the args are not a flat object of strings. */
function parseRows(args: string): ParamRow[] | null {
  if (!args) return null
  try {
    const obj = JSON.parse(args) as unknown
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    const entries = Object.entries(obj as Record<string, unknown>)
    if (entries.some(([, v]) => typeof v !== 'string')) return null
    return entries.map(([key, value]) => ({ key, value: value as string }))
  } catch {
    return null
  }
}

function rowsToArgs(rows: ParamRow[]): string {
  const filled = rows.filter((r) => r.key.trim())
  if (filled.length === 0) return ''
  return JSON.stringify(Object.fromEntries(filled.map((r) => [r.key.trim(), r.value])))
}
