import { useState, type KeyboardEvent } from 'react'
import type { ContentElement } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { choicesOf, contentPreview, type ChoiceOption } from './ContentForm'

export interface ChoiceSkillValues {
  contentId: string
  maxAttempts: number
  invalidContentId: string
  /** One entry per choice value: the candidates the user may type for it (legacy keywords). */
  keywords: Record<string, string[]>
}

export interface ChoiceSkillDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contents: ContentElement[]
  /** Values to start from when editing an existing choice skill. */
  initial?: ChoiceSkillValues
  busy: boolean
  error: string | null
  onSubmit: (values: ChoiceSkillValues) => void
}

/**
 * Keywords a choice starts with (legacy onContentChanged handler): its value and its title, without repeats.
 * A value that contains a comma is one keyword, so keywords are edited as chips, not as text.
 */
export function defaultKeywords(choices: ChoiceOption[]): Record<string, string[]> {
  return Object.fromEntries(choices.map((c) => [c.value, [...new Set([c.value, c.title])]]))
}

/**
 * Inserts a choice skill: asks a question, waits for the answer and routes on the chosen value.
 * The choices belong to the question's content element, so they are shown here, not edited.
 */
export function ChoiceSkillDialog(props: ChoiceSkillDialogProps) {
  const { open, onOpenChange } = props
  const editing = props.initial !== undefined
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[580px]"
        title={editing ? 'Edit choice skill' : 'Choice skill'}
        description={
          editing
            ? 'Regenerates the skill flow. Transitions keep their targets when their condition or caption is unchanged.'
            : 'Asks a question, waits for the answer and routes on the selected value.'
        }
      >
        {open && <ChoiceForm {...props} />}
      </DialogContent>
    </Dialog>
  )
}

function ChoiceForm({ contents, initial, busy, error, onOpenChange, onSubmit }: ChoiceSkillDialogProps) {
  const questions = contents.filter((c) => c.contentType === 'builtin_single-choice')
  const texts = contents.filter((c) => c.contentType === 'builtin_text')
  const [contentId, setContentId] = useState(initial?.contentId ?? questions[0]?.id ?? '')
  const [maxAttempts, setMaxAttempts] = useState(initial?.maxAttempts ?? 3)
  const [invalidContentId, setInvalidContentId] = useState(initial?.invalidContentId ?? '')

  const question = questions.find((q) => q.id === contentId)
  const choices = question ? choicesOf(question.formData) : []
  const valid = Boolean(contentId) && choices.length > 0

 // Keywords start from the saved skill when editing (legacy keeps them for the same question), else from the question.
  const [keywords, setKeywords] = useState<Record<string, string[]>>(() =>
    initial ? { ...defaultKeywords(choices), ...initial.keywords } : defaultKeywords(choices),
  )
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  function pickQuestion(id: string) {
    const picked = questions.find((q) => q.id === id)
    setContentId(id)
    setKeywords(defaultKeywords(picked ? choicesOf(picked.formData) : []))
    setDrafts({})
  }

  function addKeyword(value: string) {
    const word = (drafts[value] ?? '').trim()
    setDrafts({ ...drafts, [value]: '' })
    if (!word) return
    setKeywords({ ...keywords, [value]: [...(keywords[value] ?? []), word] })
  }

  function removeKeyword(value: string, index: number) {
    setKeywords({ ...keywords, [value]: (keywords[value] ?? []).filter((_, i) => i !== index) })
  }

  function onDraftKey(value: string, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    addKeyword(value)
  }

  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor="choice-question">Question</Label>
        <Select id="choice-question" value={contentId} onChange={(e) => pickQuestion(e.target.value)}>
          <option value="">Choose a question</option>
          {questions.map((c) => (
            <option key={c.id} value={c.id}>
              {contentPreview(c.contentType, c.formData)}  ·  #!{c.id}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">Single choice content element shown to the user.</p>
      </div>

      <div className="grid gap-2">
        <Label>Choices and keywords</Label>
        {choices.length === 0 && <p className="text-xs text-muted-foreground">Pick a question with choices.</p>}
        {choices.map((choice) => (
          <div key={choice.value} className="grid gap-1.5 rounded-md border border-border p-2">
            <div className="flex items-center gap-2 text-[13px]">
              <span className="flex-1 truncate">{choice.title}</span>
              <span className="font-mono-code text-xs text-muted-foreground">{choice.value}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {(keywords[choice.value] ?? []).map((word, i) => (
                <span key={`${word}-${i}`} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs">
                  {word}
                  <button type="button" aria-label={`Remove ${word}`} className="text-muted-foreground" onClick={() => removeKeyword(choice.value, i)}>
                    ×
                  </button>
                </span>
              ))}
              <Input
                aria-label={`Keywords for ${choice.value}`}
                placeholder="Type a keyword, Enter to add"
                className="h-7 min-w-[160px] flex-1"
                value={drafts[choice.value] ?? ''}
                onChange={(e) => setDrafts({ ...drafts, [choice.value]: e.target.value })}
                onKeyDown={(e) => onDraftKey(choice.value, e)}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="choice-attempts">Max attempts</Label>
          <Input id="choice-attempts" type="number" min={1} max={10} value={maxAttempts} onChange={(e) => setMaxAttempts(Number(e.target.value) || 1)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="choice-invalid">On invalid answer</Label>
          <Select id="choice-invalid" value={invalidContentId} onChange={(e) => setInvalidContentId(e.target.value)}>
            <option value="">Default message</option>
            {texts.map((c) => (
              <option key={c.id} value={c.id}>{contentPreview(c.contentType, c.formData)}</option>
            ))}
          </Select>
        </div>
      </div>

      {error && <p role="alert" className="text-[13px] text-red">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={!valid || busy}
          onClick={() =>
            onSubmit({
              contentId,
              maxAttempts,
              invalidContentId,
              keywords: Object.fromEntries(choices.map((c) => [c.value, keywords[c.value] ?? []])),
            })
          }
        >
          {busy ? (initial ? 'Saving...' : 'Inserting...') : initial ? 'Save' : 'Insert'}
        </Button>
      </div>
    </>
  )
}
