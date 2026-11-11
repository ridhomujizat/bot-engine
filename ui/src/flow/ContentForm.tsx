import { Plus, Trash2, Upload } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { uploadMedia } from '@/api/studio'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

export const CONTENT_TYPES = [
  { id: 'builtin_text', label: 'Text' },
  { id: 'builtin_single-choice', label: 'Single choice' },
  { id: 'builtin_carousel', label: 'Carousel' },
  { id: 'builtin_card', label: 'Card' },
  { id: 'builtin_image', label: 'Image' },
  { id: 'builtin_file', label: 'File' },
] as const

/** Message text is stored per language (`text$en`), as in legacy content elements. */
const TEXT = 'text$en'

export function textOf(formData: Record<string, unknown>): string {
  const value = formData[TEXT] ?? formData.text
  return typeof value === 'string' ? value : ''
}

/** Single-choice options are stored per language (`choices$en`), as legacy and the engine read them. */
const CHOICES = 'choices$en'

export interface ChoiceOption {
  title: string
  value: string
}

/** The options of a single-choice element; falls back to the untranslated key for older data. */
export function choicesOf(formData: Record<string, unknown>): ChoiceOption[] {
  const value = formData[CHOICES] ?? formData.choices
  return Array.isArray(value) ? (value as ChoiceOption[]) : []
}

export function emptyFormData(contentType: string): Record<string, unknown> {
  switch (contentType) {
    case 'builtin_single-choice':
      return { [TEXT]: '', [CHOICES]: [{ title: '', value: '' }] }
    case 'builtin_carousel':
      return { items: [{ title: '', subtitle: '', image: '' }] }
    case 'builtin_card':
      return { title: '', subtitle: '', image: '' }
    case 'builtin_image':
      return { image: '', title: '' }
    case 'builtin_file':
      return { file: '', title: '' }
 // legacy text elements carry these two flags (saved as markdown$en false, typing$en true by default).
    case 'builtin_text':
      return { [TEXT]: '', 'markdown$en': false, 'typing$en': true }
    default:
      return { [TEXT]: '' }
  }
}

/** Short text for the content list and the node pill. */
export function contentPreview(contentType: string, formData: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  switch (contentType) {
    case 'builtin_text':
    case 'builtin_single-choice':
      return textOf(formData)
    case 'builtin_carousel':
      return `Carousel (${Array.isArray(formData.items) ? formData.items.length : 0})`
    default:
      return str(formData.title) || str(formData.image) || str(formData.file) || contentType
  }
}

interface ContentFormProps {
  botId: string
  contentType: string
  formData: Record<string, unknown>
  onContentType: (type: string) => void
  onFormData: (data: Record<string, unknown>) => void
}

/** Form for one content element. Field names match the built-in content types in legacy. */
export function ContentForm({ botId, contentType, formData, onContentType, onFormData }: ContentFormProps) {
  const set = (key: string, value: unknown) => onFormData({ ...formData, [key]: value })
  const str = (key: string) => (typeof formData[key] === 'string' ? (formData[key] as string) : '')
  const list = <T,>(key: string): T[] => (Array.isArray(formData[key]) ? (formData[key] as T[]) : [])

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="content-type">Content type</Label>
        <Select id="content-type" value={contentType} onChange={(e) => onContentType(e.target.value)}>
          {CONTENT_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </Select>
      </div>

      {contentType === 'builtin_text' && (
        <div className="grid gap-1.5">
          <Label htmlFor="content-text">Message</Label>
          <Textarea id="content-text" rows={4} value={textOf(formData)} onChange={(e) => set(TEXT, e.target.value)} />
          <p className="text-xs text-muted-foreground">Supports {'{{session.x}}'}, {'{{temp.x}}'}, {'{{user.x}}'} and {'{{event.payload.x}}'}.</p>
          <label className="flex items-center gap-2 text-[13px]">
            <Switch aria-label="Show typing indicators" checked={formData['typing$en'] !== false} onCheckedChange={(v) => set('typing$en', v)} />
            Show typing indicators
          </label>
        </div>
      )}

      {contentType === 'builtin_single-choice' && (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="content-text">Question</Label>
            <Textarea id="content-text" rows={2} value={textOf(formData)} onChange={(e) => set(TEXT, e.target.value)} />
          </div>
          <ListEditor
            label="Choices"
            items={choicesOf(formData)}
            empty={{ title: '', value: '' }}
            onChange={(items) => set(CHOICES, items)}
            render={(item, update) => (
              <>
                <Input aria-label="Choice title" placeholder="Title" value={item.title} onChange={(e) => update({ ...item, title: e.target.value })} />
                <Input aria-label="Choice value" className="w-[120px] font-mono-code" placeholder="value" value={item.value} onChange={(e) => update({ ...item, value: e.target.value })} />
              </>
            )}
          />
        </>
      )}

      {contentType === 'builtin_carousel' && (
        <ListEditor
          label="Cards"
          items={list<{ title: string; subtitle: string; image: string }>('items')}
          empty={{ title: '', subtitle: '', image: '' }}
          onChange={(items) => set('items', items)}
          render={(item, update) => (
            <div className="grid flex-1 gap-1.5">
              <Input aria-label="Card title" placeholder="Title" value={item.title} onChange={(e) => update({ ...item, title: e.target.value })} />
              <Input aria-label="Card subtitle" placeholder="Subtitle" value={item.subtitle} onChange={(e) => update({ ...item, subtitle: e.target.value })} />
            </div>
          )}
        />
      )}

      {contentType === 'builtin_card' && (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="card-title">Title</Label>
            <Input id="card-title" value={str('title')} onChange={(e) => set('title', e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="card-subtitle">Subtitle</Label>
            <Input id="card-subtitle" value={str('subtitle')} onChange={(e) => set('subtitle', e.target.value)} />
          </div>
          <UploadField botId={botId} label="Image" accept="image/*" value={str('image')} onChange={(url) => set('image', url)} />
        </>
      )}

      {contentType === 'builtin_image' && (
        <>
          <UploadField botId={botId} label="Image" accept="image/*" value={str('image')} onChange={(url) => set('image', url)} />
          <div className="grid gap-1.5">
            <Label htmlFor="image-title">Label</Label>
            <Input id="image-title" value={str('title')} onChange={(e) => set('title', e.target.value)} />
          </div>
        </>
      )}

      {contentType === 'builtin_file' && (
        <>
          <UploadField botId={botId} label="File" accept=".pdf,.doc,.docx,.xls,.xlsx,.txt" value={str('file')} onChange={(url) => set('file', url)} />
          <div className="grid gap-1.5">
            <Label htmlFor="file-title">Label</Label>
            <Input id="file-title" value={str('title')} onChange={(e) => set('title', e.target.value)} />
          </div>
        </>
      )}
    </div>
  )
}

/** Uploads through `POST /media` and stores the returned URL. The URL can also be pasted. */
function UploadField({
  botId,
  label,
  accept,
  value,
  onChange,
}: {
  botId: string
  label: string
  accept: string
  value: string
  onChange: (url: string) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = `upload-${label.toLowerCase()}`

  async function pick(file: File | undefined) {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      onChange(await uploadMedia(botId, file))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input id={id} className="font-mono-code text-xs" placeholder="URL" value={value} onChange={(e) => onChange(e.target.value)} />
        <label className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 text-[13px] font-medium hover:bg-muted">
          <Upload className="size-3.5" />
          {busy ? 'Uploading...' : 'Upload'}
          <input type="file" accept={accept} className="sr-only" disabled={busy} onChange={(e) => void pick(e.target.files?.[0])} />
        </label>
      </div>
      {error && <p role="alert" className="text-xs text-red">{error}</p>}
    </div>
  )
}

function ListEditor<T>({
  label,
  items,
  empty,
  onChange,
  render,
}: {
  label: string
  items: T[]
  empty: T
  onChange: (items: T[]) => void
  render: (item: T, update: (item: T) => void) => ReactNode
}) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2">
          {render(item, (next) => onChange(items.map((x, j) => (j === i ? next : x))))}
          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" className="justify-self-start" onClick={() => onChange([...items, { ...empty }])}>
        <Plus /> Add {label.toLowerCase().replace(/s$/, '')}
      </Button>
    </div>
  )
}
