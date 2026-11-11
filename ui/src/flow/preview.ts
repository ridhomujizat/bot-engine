import { parseNodeAction } from './actions'
import { CONTENT_TYPES, basenameOf, listField, textField, textOf } from './ContentForm'

/** Longest preview shown in a row or pill; the rest is cut with an ellipsis (the full text is in the tooltip). */
export const PREVIEW_MAX = 48

/** One line of text: whitespace collapsed, cut to `max` characters with a trailing ellipsis. */
export function clip(text: string, max = PREVIEW_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** Name shown for a content type: "Single choice", "Carousel", ... Unknown types fall back to their id. */
export function contentTypeLabel(contentType: string): string {
  const known = CONTENT_TYPES.find((t) => t.id === contentType)
  if (known) return known.label
  const bare = contentType.replace(/^builtin_/, '').replace(/[-_]+/g, ' ').trim()
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : 'Message'
}

/**
 * The words an element shows: its text, its title, or how many cards it has. Fields are read through
 * their language keys (`items$en`, `title$en`), the way the legacy engine stores them.
 */
export function contentPreviewText(contentType: string, formData: Record<string, unknown>): string {
  switch (contentType) {
    case 'builtin_text':
    case 'builtin_single-choice':
      return textOf(formData)
    case 'builtin_carousel': {
      const count = listField(formData, 'items').length
      return `${count} ${count === 1 ? 'card' : 'cards'}`
    }
    case 'builtin_card':
      return textField(formData, 'title') || textField(formData, 'subtitle')
    case 'builtin_image':
      return textField(formData, 'title') || basenameOf(textField(formData, 'image'))
    case 'builtin_file':
      return textField(formData, 'title') || basenameOf(textField(formData, 'file'))
    default:
      return textField(formData, 'title') || textField(formData, 'text')
  }
}

/** Friendly label of a content element, as the legacy editor shows it: "Single choice · Silakan pilih …". */
export function contentLabel(contentType: string, formData: Record<string, unknown>): string {
  const type = contentTypeLabel(contentType)
  const preview = clip(contentPreviewText(contentType, formData))
  return preview ? `${type} · ${preview}` : type
}

/** Compact JSON for an args string: `{"skill": "choice"}` becomes `{"skill":"choice"}`. Non-JSON is kept as is. */
export function compactArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args))
  } catch {
    return args
  }
}

export function isSetVariable(name: string): boolean {
  return name === 'builtin/setVariable' || /(^|\/)setVariable$/.test(name)
}

/**
 * A variable value as it reads in the flow: `null`, `0`, `true`, `""` for an empty string, text as is,
 * and objects as JSON. A missing value reads as `undefined`.
 */
export function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value === '' ? '""' : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** The `temp.x = value` line of a setVariable action, or null when its args are not an assignment. */
export function setVariableLine(args: string): string | null {
  try {
    const parsed = JSON.parse(args) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as { name?: unknown; type?: unknown; value?: unknown }
    if (typeof o.name !== 'string' || o.name === '') return null
    const scope = typeof o.type === 'string' && o.type !== '' ? `${o.type}.` : ''
    return `${scope}${o.name} = ${formatValue(o.value)}`
  } catch {
    return null
  }
}

/** What one node action row shows. `label` is the main line; `detail` or `badge` the small muted line. */
export interface ActionView {
  kind: 'say' | 'code'
  label: string
  /** Muted line under the label: the action name of a setVariable row. */
  detail: string | null
  /** Compact args, shown as a small muted badge. */
  badge: string | null
  /** Monospace label (code actions). */
  mono: boolean
  /** Full text for the tooltip. */
  full: string
}

/**
 * Friendly rows for a node action. Say actions show their content element's label (the id when the
 * element is not loaded) with the args as a badge. setVariable shows the assignment. Other code
 * actions show the name with compact args.
 */
export function describeAction(raw: string, contentLabels: Record<string, string>): ActionView {
  const action = parseNodeAction(raw)
  if (action.kind === 'say') {
    const label = contentLabels[action.contentId] ?? action.contentId
    const badge = action.args ? compactArgs(action.args) : null
    return { kind: 'say', label, detail: null, badge, mono: false, full: [label, badge].filter(Boolean).join(' ') }
  }
  if (isSetVariable(action.name)) {
    const line = setVariableLine(action.args)
    if (line !== null) return { kind: 'code', label: line, detail: action.name, badge: null, mono: true, full: `${line} (${action.name})` }
  }
  const badge = action.args ? compactArgs(action.args) : null
  return { kind: 'code', label: action.name, detail: null, badge, mono: true, full: [action.name, badge].filter(Boolean).join(' ') }
}
