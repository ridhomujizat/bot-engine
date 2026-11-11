import { ChevronDown, ChevronUp, FileText, RotateCcw, Send, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { ResponsePayload } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { PREF_DRAWER_HEIGHT, PREF_DRAWER_OPEN, PREF_QUICK_START, readFlag, readNumber, writeFlag, writePref } from './prefs'
import type { EmulatorApi, EmulatorMessage } from './useEmulator'

export interface EmulatorPanelProps {
  emu: EmulatorApi
  botId: string
  onClose: () => void
  /** Literal trigger texts of the main flow and the open flow, shown as quick-start chips. */
  triggers: string[]
  /** Editor follows the conversation's flow and node after each reply. */
  follow: boolean
  onFollowChange: (on: boolean) => void
}

const DRAWER_DEFAULT_HEIGHT = 260
const DRAWER_MIN_HEIGHT = 120

/** Chat panel that talks to the converse API with the emulator's own userId. */
export function EmulatorPanel({ emu, botId, onClose, triggers, follow, onFollowChange }: EmulatorPanelProps) {
  const [draft, setDraft] = useState('')
  const [quickOpen, setQuickOpen] = useState(() => readFlag(PREF_QUICK_START, true))
  const scroller = useRef<HTMLDivElement>(null)
  const lastId = emu.messages.at(-1)?.id

  // Newest message in view: scroll to the bottom when one arrives or the bot starts typing.
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastId, emu.busy])

  function submit(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || emu.busy) return
    setDraft('')
    emu.send({ type: 'text', text, payload: { text } }, text)
  }

  function toggleQuick() {
    setQuickOpen((open) => {
      writeFlag(PREF_QUICK_START, !open)
      return !open
    })
  }

  const lastIndex = emu.messages.length - 1
  // Choices answer the newest message only: once the user replies (or the bot sends more), they are spent.
  const choicesLive = !emu.busy && emu.metadataError === null

  return (
    <aside className="flex w-[380px] shrink-0 flex-col overflow-hidden border-l border-border bg-background">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3.5">
        <span className="text-sm font-semibold">Emulator</span>
        <Badge>{botId}</Badge>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={emu.reset} aria-label="Reset emulator session">
          <RotateCcw /> Reset
        </Button>
        <button type="button" aria-label="Close emulator" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3.5 text-xs">
        <Switch id="emulator-follow" aria-label="Follow conversation" checked={follow} onCheckedChange={onFollowChange} />
        <label htmlFor="emulator-follow" className="cursor-pointer text-muted-foreground" title="After each reply, the editor opens the flow and node the conversation is on">
          Follow conversation
        </label>
        {emu.state?.context?.currentFlow && (
          <span className="ml-auto min-w-0 truncate font-mono-code text-[11px] text-muted-foreground" title="Current flow and node">
            {emu.state.context.currentFlow}
            {emu.state.context.currentNode ? ` · ${emu.state.context.currentNode}` : ''}
          </span>
        )}
      </div>

      <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto px-3.5 py-3" aria-live="polite">
        {emu.messages.length === 0 && (
          <p className="text-xs text-muted-foreground">Send a message to start a conversation as {emu.userId}.</p>
        )}
        {emu.messages.map((m, i) => (
          <MessageView
            key={m.id}
            message={m}
            active={i === lastIndex && choicesLive}
            onChoose={(title, value) => emu.send({ type: 'single-choice', text: title, payload: { text: title, payload: value } }, title)}
            onSay={(text, label) => emu.send({ type: 'text', text, payload: { text } }, label)}
          />
        ))}
        {emu.busy && <Typing />}
        {emu.error && <p role="alert" className="text-xs text-red">{emu.error}</p>}
      </div>

      {triggers.length > 0 && (
        <div className="shrink-0 border-t border-border px-3.5 pt-2">
          <button
            type="button"
            aria-expanded={quickOpen}
            aria-controls="emulator-quick-start"
            onClick={toggleQuick}
            className="flex w-full items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={cn('size-3 transition-transform', !quickOpen && '-rotate-90')} />
            Quick start
            <span className="ml-auto font-normal">{triggers.length}</span>
          </button>
          {quickOpen && (
            <div id="emulator-quick-start" role="group" aria-label="Quick start" className="mt-1.5 flex gap-1.5 overflow-x-auto pb-2.5">
              {triggers.map((text) => (
                <button
                  key={text}
                  type="button"
                  title={text}
                  disabled={emu.busy || emu.metadataError !== null}
                  onClick={() => emu.send({ type: 'text', text, payload: { text } }, text)}
                  className="max-w-[160px] shrink-0 truncate rounded-full border border-border bg-background px-2.5 py-0.5 font-mono-code text-[11px] hover:bg-muted disabled:opacity-50"
                >
                  {text}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <form onSubmit={submit} className="flex shrink-0 items-center gap-2 border-t border-border p-3">
        <Input aria-label="Message" placeholder="Type a message" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" size="icon" aria-label="Send message" disabled={emu.busy || !draft.trim() || emu.metadataError !== null}>
          <Send />
        </Button>
      </form>

      <Drawer emu={emu} botId={botId} />
    </aside>
  )
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function Stamp({ at, align }: { at: number; align: 'start' | 'end' }) {
  return (
    <time dateTime={new Date(at).toISOString()} className={cn('px-1 text-[10px] leading-3 text-muted-foreground/80', align === 'end' && 'text-right')}>
      {clock(at)}
    </time>
  )
}

function MessageView({
  message,
  active,
  onChoose,
  onSay,
}: {
  message: EmulatorMessage
  active: boolean
  onChoose: (title: string, value: string) => void
  onSay: (text: string, label: string) => void
}) {
  if (message.from === 'user') {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-3 py-2 text-[13px] leading-[18px] break-words whitespace-pre-wrap text-primary-foreground">
          {message.text}
        </div>
        <Stamp at={message.at} align="end" />
      </div>
    )
  }
  const payload = message.payload as ResponsePayload
  return (
    <div className="flex w-full min-w-0 flex-col items-start gap-0.5">
      <BotPayload payload={payload} active={active} onChoose={onChoose} onSay={onSay} />
      <Stamp at={message.at} align="start" />
    </div>
  )
}

function BotPayload({
  payload,
  active,
  onChoose,
  onSay,
}: {
  payload: ResponsePayload
  active: boolean
  onChoose: (title: string, value: string) => void
  onSay: (text: string, label: string) => void
}) {
  switch (payload.type) {
    case 'text':
      return <Bubble>{String(payload.text ?? '')}</Bubble>
    case 'single-choice':
      return <SingleChoice payload={payload as ChoicePayload} active={active} onChoose={onChoose} />
    case 'carousel':
      return <Carousel items={(payload.items as CarouselItem[] | undefined) ?? []} active={active} onChoose={onChoose} onSay={onSay} />
    case 'image':
      return (
        <div className="flex max-w-[80%] flex-col gap-1">
          <img
            src={String(payload.image)}
            alt={String(payload.title ?? '')}
            className="max-h-[160px] rounded-xl border border-border object-cover"
            onError={(e) => (e.currentTarget.style.display = 'none')}
          />
          {payload.title ? <span className="text-xs text-muted-foreground">{String(payload.title)}</span> : null}
        </div>
      )
    case 'file':
      return (
        <a
          href={String(payload.file)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex max-w-[80%] items-center gap-2 rounded-xl border border-border px-3 py-2 text-[13px] hover:bg-muted"
        >
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{String(payload.title ?? payload.file)}</span>
        </a>
      )
    default:
      return <Bubble>{JSON.stringify(payload)}</Bubble>
  }
}

function Bubble({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-[80%] rounded-2xl rounded-bl-md bg-muted px-3 py-2 text-[13px] leading-[18px] break-words whitespace-pre-wrap">
      {children}
    </div>
  )
}

function Typing() {
  return (
    <div role="status" className="flex items-center gap-1 self-start rounded-2xl rounded-bl-md bg-muted px-3 py-2.5">
      <span className="sr-only">Bot is typing...</span>
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  )
}

/** Single-choice reply: wrapping chips under the bubble, or a select when the element is a dropdown. */
interface ChoicePayload {
  text?: string
  choices?: { title: string; value: string }[]
  isDropdown?: boolean
}

function SingleChoice({
  payload,
  active,
  onChoose,
}: {
  payload: ChoicePayload
  active: boolean
  onChoose: (title: string, value: string) => void
}) {
  const choices = payload.choices ?? []
  return (
    <div className="flex w-full min-w-0 flex-col items-start gap-1.5">
      {payload.text ? <Bubble>{String(payload.text)}</Bubble> : null}
      {payload.isDropdown ? (
        <div className="w-[240px] max-w-[80%]">
          <Select
            value=""
            disabled={!active}
            onValueChange={(value) => {
              const picked = choices.find((c) => c.value === value)
              if (picked) onChoose(picked.title, picked.value)
            }}
          >
            <SelectTrigger aria-label="Choose an option">
              <SelectValue placeholder="Choose an option" />
            </SelectTrigger>
            <SelectContent>
              {choices.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div role="group" aria-label="Choices" className="flex flex-wrap gap-1.5">
          {choices.map((c) => (
            <button
              key={c.value}
              type="button"
              disabled={!active}
              onClick={() => onChoose(c.title, c.value)}
              className="max-w-[240px] truncate rounded-full border border-border bg-background px-3 py-1 text-[12px] font-medium hover:bg-muted disabled:cursor-default disabled:opacity-40 disabled:hover:bg-background"
            >
              {c.title}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface CarouselAction {
  title: string
  /** "Say something" (sends text), "Open URL" (link) or "Postback" (sends the payload). */
  action?: string
  text?: string
  url?: string
  payload?: string
}

interface CarouselItem {
  title: string
  subtitle?: string
  image?: string
  actions?: CarouselAction[]
}

/** Horizontal row of cards: image, title, subtitle and the card's action buttons. */
function Carousel({
  items,
  active,
  onChoose,
  onSay,
}: {
  items: CarouselItem[]
  active: boolean
  onChoose: (title: string, value: string) => void
  onSay: (text: string, label: string) => void
}) {
  return (
    <div role="list" aria-label="Carousel" className="flex w-full min-w-0 snap-x gap-2 overflow-x-auto pb-1">
      {items.map((item, i) => (
        <div key={i} role="listitem" className="flex w-[200px] shrink-0 snap-start flex-col overflow-hidden rounded-xl border border-border bg-background">
          {item.image ? (
            <img
              src={item.image}
              alt={item.title}
              className="h-24 w-full object-cover"
              onError={(e) => (e.currentTarget.style.display = 'none')}
            />
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 pt-2.5">
            <div className="line-clamp-2 text-[13px] leading-[18px] font-medium break-words">{item.title}</div>
            {item.subtitle ? <div className="line-clamp-2 text-xs leading-4 text-muted-foreground break-words">{item.subtitle}</div> : null}
          </div>
          {(item.actions ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2 pb-3">
              {(item.actions ?? []).map((a, j) =>
                a.action === 'Open URL' && a.url ? (
                  <a
                    key={j}
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-border px-2 py-1 text-[12px] font-medium text-blue hover:bg-muted"
                  >
                    {a.title}
                  </a>
                ) : (
                  <button
                    key={j}
                    type="button"
                    disabled={!active}
                    onClick={() =>
                      a.action === 'Postback'
                        ? onChoose(a.title, a.payload ?? a.title)
                        : onSay(a.text ?? a.title, a.title)
                    }
                    className="rounded-md border border-border px-2 py-1 text-[12px] font-medium hover:bg-muted disabled:cursor-default disabled:opacity-40 disabled:hover:bg-background"
                  >
                    {a.title}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** Bottom drawer: State, Session, Temp, Metadata and Raw. Collapsed by default; a tab opens it. */
function Drawer({ emu, botId }: { emu: EmulatorApi; botId: string }) {
  const [open, setOpen] = useState(() => readFlag(PREF_DRAWER_OPEN, false))
  const [tab, setTab] = useState('state')
  const [height, setHeight] = useState(() => readNumber(PREF_DRAWER_HEIGHT, DRAWER_DEFAULT_HEIGHT))
  const heightRef = useRef(height)

  function setOpenSaved(next: boolean) {
    setOpen(next)
    writeFlag(PREF_DRAWER_OPEN, next)
  }

  function show(next: string) {
    setTab(next)
    if (!open) setOpenSaved(true)
  }

  function maxHeight(): number {
    return Math.max(DRAWER_MIN_HEIGHT, Math.round(window.innerHeight * 0.6))
  }

  /** Drag the splitter above the drawer: the drawer grows as the pointer moves up. */
  function startDrag(event: ReactPointerEvent) {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = heightRef.current
    const move = (e: PointerEvent) => {
      const next = Math.min(maxHeight(), Math.max(DRAWER_MIN_HEIGHT, startHeight + (startY - e.clientY)))
      heightRef.current = next
      setHeight(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      writePref(PREF_DRAWER_HEIGHT, String(heightRef.current))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="flex shrink-0 flex-col border-t border-border bg-canvas">
      {open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize details"
          aria-valuenow={height}
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
            const next = Math.min(maxHeight(), Math.max(DRAWER_MIN_HEIGHT, height + (e.key === 'ArrowUp' ? 24 : -24)))
            heightRef.current = next
            setHeight(next)
            writePref(PREF_DRAWER_HEIGHT, String(next))
          }}
          className="flex h-2 cursor-row-resize items-center justify-center outline-none hover:bg-border focus-visible:bg-border"
        >
          <span className="h-0.5 w-8 rounded-full bg-border" />
        </div>
      )}
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <Tabs value={tab} onValueChange={setTab} className="min-w-0 flex-1">
          <TabsList className="h-8">
            <TabsTrigger className="px-2" value="state" onClick={() => show('state')}>State</TabsTrigger>
            <TabsTrigger className="px-2" value="session" onClick={() => show('session')}>Session</TabsTrigger>
            <TabsTrigger className="px-2" value="temp" onClick={() => show('temp')}>Temp</TabsTrigger>
            <TabsTrigger className="px-2" value="metadata" onClick={() => show('metadata')}>Metadata</TabsTrigger>
            <TabsTrigger className="px-2" value="raw" onClick={() => show('raw')}>Raw</TabsTrigger>
          </TabsList>
        </Tabs>
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? 'Hide details' : 'Show details'}
          onClick={() => setOpenSaved(!open)}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        </button>
      </div>
      {open && (
        <div style={{ height }} className="flex min-h-0 flex-col gap-2 overflow-x-hidden overflow-y-auto border-t border-border p-3.5">
          <DrawerBody tab={tab} emu={emu} botId={botId} />
        </div>
      )}
    </div>
  )
}

function DrawerBody({ tab, emu, botId }: { tab: string; emu: EmulatorApi; botId: string }) {
  const state = emu.state
  if (tab === 'raw') {
    return (
      <pre className="font-mono-code text-[11px] whitespace-pre-wrap break-all">
        {JSON.stringify(emu.exchange ?? { state: state ?? {} }, null, 2)}
      </pre>
    )
  }
  if (tab === 'metadata') {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] text-muted-foreground">
          Sent as <span className="font-mono-code">metadata</span> with every message. <span className="font-mono-code">new_session</span> is set by the emulator.
        </p>
        <Textarea
          aria-label="Emulator metadata JSON"
          spellCheck={false}
          className="font-mono-code text-[11px]"
          rows={8}
          value={emu.metadataText}
          onChange={(e) => emu.changeMetadata(e.target.value)}
        />
        {emu.metadataError && <p role="alert" className="text-[11px] text-red">{emu.metadataError}</p>}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      {tab === 'state' && (
        <>
          <Kv k="bot" v={botId} />
          <Kv k="userId" v={emu.userId} />
          <Kv k="currentFlow" v={state?.context?.currentFlow} />
          <Kv k="currentNode" v={state?.context?.currentNode} />
          <Kv k="previousNode" v={state?.context?.previousNode} />
          <Kv k="__stacktrace" v={emu.stacktrace.join(' > ')} />
        </>
      )}
      {tab === 'session' && Object.entries(state?.session ?? {}).map(([k, v]) => <Kv key={k} k={`session.${k}`} v={v} />)}
      {tab === 'temp' && Object.entries(state?.temp ?? {}).map(([k, v]) => <Kv key={k} k={`temp.${k}`} v={v} />)}
    </div>
  )
}

function Kv({ k, v }: { k: string; v: unknown }) {
  const text = v === undefined || v === null || v === '' ? '-' : typeof v === 'string' ? v : JSON.stringify(v)
  return (
    <div className="flex min-w-0 items-center gap-2 font-mono-code text-[11px]">
      <span className="shrink-0 text-muted-foreground">{k}</span>
      <span className="min-w-0 flex-1" />
      <span title={text} className="min-w-0 max-w-[200px] truncate">{text}</span>
    </div>
  )
}
