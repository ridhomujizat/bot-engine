import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Code2, MessageSquare, Plus, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { saveContentElement } from '@/api/studio'
import type { ActionDef, ContentElement } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, SegmentItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { formatNodeAction, parseNodeAction } from './actions'
import { ContentForm, CONTENT_TYPES, contentPreview, emptyFormData } from './ContentForm'
import { type ContentDraft, hasChanges, mergeFormData, prefillDraft } from './contentEdit'

export interface ActionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  botId: string
  section: 'On enter' | 'On receive'
  /** The action being edited, or null when adding one. */
  initial: string | null
  actions: ActionDef[]
  contents: ContentElement[]
  /** References to each content element across the bot's flows (see contentUsageCounts). */
  usageCounts: Record<string, number>
  onSubmit: (raw: string) => void
}

/**
 * Add or edit one node action: "Say something" (a content element) or "Execute code" (a bot action).
 * The body scrolls; the footer stays at the bottom of the dialog.
 */
export function ActionDialog(props: ActionDialogProps) {
  const { open, onOpenChange, initial, section } = props
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[576px]"
        title={initial ? 'Edit action' : 'Add action'}
        description={`Runs when the flow arrives at this node (${section}).`}
      >
        {open && <ActionForm key={initial ?? 'new'} {...props} />}
      </DialogContent>
    </Dialog>
  )
}

function ActionForm({ botId, initial, actions, contents, usageCounts, onSubmit, onOpenChange }: ActionDialogProps) {
  const parsed = initial ? parseNodeAction(initial) : null
  const [kind, setKind] = useState<'say' | 'code'>(parsed?.kind ?? 'say')
  const done = (raw: string) => {
    onSubmit(raw)
    onOpenChange(false)
  }
  const cancel = () => onOpenChange(false)

  return (
    <>
      <div className="grid gap-1.5">
        <RadioGroup
          aria-label="Action kind"
          value={kind}
          onValueChange={(v) => setKind(v as 'say' | 'code')}
          className="grid grid-cols-2 gap-0.5 rounded-lg bg-muted p-1"
        >
          <SegmentItem value="say">
            <MessageSquare className="size-3.5" />
            Say something
          </SegmentItem>
          <SegmentItem value="code">
            <Code2 className="size-3.5" />
            Execute code
          </SegmentItem>
        </RadioGroup>
        <p className="text-xs text-muted-foreground">
          {kind === 'say' ? 'Sends a message from a content element to the user.' : 'Runs a bot action and stores its result.'}
        </p>
      </div>
      {kind === 'say' ? (
        <SayForm
          botId={botId}
          existingId={parsed?.kind === 'say' ? parsed.contentId : null}
          existingArgs={parsed?.kind === 'say' ? parsed.args : ''}
          contents={contents}
          usageCounts={usageCounts}
          onDone={done}
          onCancel={cancel}
        />
      ) : (
        <CodeForm initial={parsed?.kind === 'code' ? parsed : null} actions={actions} onDone={done} onCancel={cancel} />
      )}
    </>
  )
}

/** Value of the picker's "New..." entry. Content element ids never equal it. */
const NEW_ELEMENT = '__new__'

function blankDraft(): ContentDraft {
  return { contentType: 'builtin_text', formData: emptyFormData('builtin_text') }
}

/** The picker's text for an element: its preview, or its id when the preview is empty. */
function contentLabelText(c: ContentElement): string {
  const preview = contentPreview(c.contentType, c.formData)
  return preview && preview !== c.contentType ? preview : c.id
}

export function typeLabel(contentType: string): string {
  return CONTENT_TYPES.find((t) => t.id === contentType)?.label ?? contentType
}

/**
 * The say action's content: pick an element (or "New..."), edit it in the form, save. The element is
 * written only when its formData changed; the action then names it. An element used in more than one
 * place shows a notice, and "Duplicate and edit only here" makes this action edit its own copy.
 */
function SayForm({
  botId,
  existingId,
  existingArgs,
  contents,
  usageCounts,
  onDone,
  onCancel,
}: {
  botId: string
  existingId: string | null
  /** Args after the content id (for example `{"skill":"choice"}`), kept when the action is saved. */
  existingArgs: string
  contents: ContentElement[]
  usageCounts: Record<string, number>
  onDone: (raw: string) => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const loaded = contents.find((c) => c.id === existingId)
  const [selection, setSelection] = useState<string>(loaded ? loaded.id : NEW_ELEMENT)
  const [draft, setDraft] = useState<ContentDraft>(() => (loaded ? prefillDraft(loaded) : blankDraft()))
  // True after "Duplicate and edit only here": saving creates a copy of the selected element.
  const [copying, setCopying] = useState(false)

  const original = selection === NEW_ELEMENT ? undefined : contents.find((c) => c.id === selection)
  const usage = original ? (usageCounts[original.id] ?? 0) : 0
  const shared = original !== undefined && !copying && usage > 1

  function choose(id: string) {
    const element = id === NEW_ELEMENT ? undefined : contents.find((c) => c.id === id)
    setSelection(id)
    setCopying(false)
    setDraft(element ? prefillDraft(element) : blankDraft())
  }

  const save = useMutation({
    mutationFn: async (): Promise<string> => {
      if (!original) return saveContentElement(botId, draft.contentType, null, draft.formData)
      if (copying) {
        return saveContentElement(botId, original.contentType, null, mergeFormData(original.formData, draft.formData))
      }
      if (!hasChanges(original.formData, draft.formData)) return original.id
      // Same id, modifiedOn updated by the server. Keys the form does not render are sent back unchanged.
      return saveContentElement(botId, original.contentType, original.id, mergeFormData(original.formData, draft.formData))
    },
    onSuccess: (id) => {
      // The new or edited element must reach the labels on the cards and rows at once, not after a reload.
      void queryClient.invalidateQueries({ queryKey: ['content', botId] })
      onDone(formatNodeAction({ kind: 'say', contentId: id, args: existingArgs }))
    },
  })

  const canSubmit = contentPreview(draft.contentType, draft.formData).length > 0
  const options = contents.map((c) => ({
    value: c.id,
    badge: typeLabel(c.contentType),
    // An element with no text yet shows its id, not its bare type name.
    label: contentLabelText(c),
  }))

  return (
    <>
      <Section title="Content element">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <Combobox
              id="content-element"
              label="Content element"
              value={selection}
              onValueChange={choose}
              leading={[{ value: NEW_ELEMENT, label: 'New…' }]}
              options={options}
              placeholder="Choose a message"
              searchPlaceholder="Search messages..."
              emptyText="No message matches"
            />
          </div>
        </div>

        {shared && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-xs">
            <span>Used in {usage} places — changes apply everywhere</span>
            <Button type="button" variant="outline" size="sm" onClick={() => setCopying(true)}>
              Duplicate and edit only here
            </Button>
          </div>
        )}
        {copying && original && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
            <span>Saving creates a copy for this action. The other {usage - 1} places keep the original.</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => choose(original.id)}>
              Keep shared
            </Button>
          </div>
        )}
      </Section>

      <Section
        title="Content"
        aside={
          selection === NEW_ELEMENT ? (
            <Select value={draft.contentType} onValueChange={(t) => setDraft({ contentType: t, formData: emptyFormData(t) })}>
              <SelectTrigger id="content-type" aria-label="Content type" className="h-7 w-[150px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTENT_TYPES.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Badge tone="text-blue bg-blue-bg" aria-label="Content type">
              {typeLabel(draft.contentType)}
            </Badge>
          )
        }
      >
        <div className="rounded-lg border border-border bg-canvas/50 p-3.5">
          <ContentForm
            botId={botId}
            contentType={draft.contentType}
            formData={draft.formData}
            typeEditable={!original}
            showType={false}
            onContentType={(t) => setDraft({ contentType: t, formData: emptyFormData(t) })}
            onFormData={(formData) => setDraft({ ...draft, formData })}
          />
        </div>
      </Section>

      {save.isError && <p role="alert" className="text-xs text-red">{save.error.message}</p>}
      <ActionFooter
        onCancel={onCancel}
        saveLabel={original ? 'Save action' : 'Add action (Alt+Enter)'}
        disabled={!canSubmit || save.isPending}
        onSave={() => save.mutate()}
      />
    </>
  )
}

function CodeForm({
  initial,
  actions,
  onDone,
  onCancel,
}: {
  initial: { name: string; args: string } | null
  actions: ActionDef[]
  onDone: (raw: string) => void
  onCancel: () => void
}) {
  const initialRows = parseRows(initial?.args ?? '')
  const [name, setName] = useState(initial?.name ?? actions[0]?.name ?? '')
  const [rows, setRows] = useState<ParamRow[]>(initialRows ?? paramRowsOf(actions, initial?.name ?? actions[0]?.name ?? ''))
  const [rawMode, setRawMode] = useState(initialRows === null && Boolean(initial?.args))
  const [rawArgs, setRawArgs] = useState(initial?.args ?? '')

  function submit() {
    const args = rawMode ? rawArgs.trim() : rowsToArgs(rows)
    onDone(args ? `${name} ${args}` : name)
  }

  return (
    <>
      <Section title="Action">
        <Combobox
          id="action-name"
          label="Action"
          value={name}
          options={actions.map((a) => ({ value: a.name, label: a.name, badge: a.category ?? 'Other' }))}
          searchPlaceholder="Search actions..."
          emptyText="No action matches"
          onValueChange={(next) => {
            setName(next)
            // Start from the action's declared parameters, unless the user already typed some.
            if (rows.every((r) => !r.key && !r.value)) setRows(paramRowsOf(actions, next))
          }}
        />
        <p className="text-xs text-muted-foreground">Stores a value in temp, session, user or bot memory.</p>
      </Section>

      <Section
        title="Parameters"
        aside={
          <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setRawMode((v) => !v)}>
            {rawMode ? 'Use table' : 'Edit raw JSON'}
          </button>
        }
      >
        {rawMode ? (
          <Textarea aria-label="Raw arguments" className="font-mono-code text-xs" rows={4} value={rawArgs} onChange={(e) => setRawArgs(e.target.value)} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="grid grid-cols-2 gap-px bg-border text-xs font-medium text-muted-foreground">
              <div className="bg-canvas px-2.5 py-1.5">Parameter</div>
              <div className="bg-canvas px-2.5 py-1.5">Value</div>
            </div>
            {rows.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] border-t border-border">
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
                <button type="button" aria-label="Remove parameter" className="px-2.5 text-muted-foreground hover:text-red" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setRows([...rows, { key: '', value: '' }])} className="flex w-full items-center gap-1.5 border-t border-border px-2.5 py-2 text-xs text-muted-foreground hover:bg-muted">
              <Plus className="size-3" /> Add parameter
            </button>
          </div>
        )}
      </Section>

      <ActionFooter onCancel={onCancel} saveLabel="Add action (Alt+Enter)" disabled={!name} onSave={submit} />
    </>
  )
}

/** A labelled group of the dialog body. The title is small and muted; the aside sits on its right. */
function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid min-w-0 gap-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <Label className="text-xs font-medium text-muted-foreground">{title}</Label>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** Cancel and the primary button, right aligned. Pinned to the bottom of the dialog while the body scrolls. */
function ActionFooter({ onCancel, onSave, saveLabel, disabled }: { onCancel: () => void; onSave: () => void; saveLabel: string; disabled: boolean }) {
  return (
    <div className={cn('sticky bottom-0 -mx-6 -mb-6 mt-auto flex items-center justify-end gap-2 border-t border-border bg-background px-6 py-3')}>
      <Button variant="outline" onClick={onCancel}>
        Cancel
      </Button>
      <Button disabled={disabled} onClick={onSave}>
        {saveLabel}
      </Button>
    </div>
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
