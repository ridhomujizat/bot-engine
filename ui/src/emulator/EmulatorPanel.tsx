import { FileText, RotateCcw, Send, X } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { ResponsePayload } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { EmulatorApi, EmulatorMessage } from './useEmulator'

export interface EmulatorPanelProps {
  emu: EmulatorApi
  botId: string
  onClose: () => void
  /** Literal trigger texts of the bot's flows, shown as quick-start chips. */
  triggers: string[]
}

/** Chat panel that talks to the converse API with the emulator's own userId. */
export function EmulatorPanel({ emu, botId, onClose, triggers }: EmulatorPanelProps) {
  const [draft, setDraft] = useState('')

  function submit(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || emu.busy) return
    setDraft('')
    emu.send({ type: 'text', text, payload: { text } }, text)
  }

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-background">
      <div className="flex h-11 items-center gap-2 border-b border-border px-3.5">
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

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3.5" aria-live="polite">
        {emu.messages.length === 0 && (
          <p className="text-xs text-muted-foreground">Send a message to start a conversation as {emu.userId}.</p>
        )}
        {emu.messages.map((m) => (
          <MessageView key={m.id} message={m} disabled={emu.busy} onChoose={(title, value) => emu.send({ type: 'single-choice', text: title, payload: { text: title, payload: value } }, title)} />
        ))}
        {emu.busy && <p className="text-xs text-muted-foreground">Bot is typing...</p>}
        {emu.error && <p role="alert" className="text-xs text-red">{emu.error}</p>}
      </div>

      {triggers.length > 0 && (
        <div role="group" aria-label="Quick start" className="flex flex-wrap gap-1.5 border-t border-border px-3.5 pt-2.5">
          {triggers.map((text) => (
            <button
              key={text}
              type="button"
              disabled={emu.busy || emu.metadataError !== null}
              onClick={() => emu.send({ type: 'text', text, payload: { text } }, text)}
              className="max-w-full truncate rounded-full border border-border bg-background px-2.5 py-0.5 font-mono-code text-[11px] hover:bg-muted disabled:opacity-50"
            >
              {text}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={submit} className="flex items-center gap-2 border-t border-border p-3">
        <Input aria-label="Message" placeholder="Type a message" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" size="icon" aria-label="Send message" disabled={emu.busy || !draft.trim() || emu.metadataError !== null}>
          <Send />
        </Button>
      </form>

      <StatePanel emu={emu} botId={botId} />
    </aside>
  )
}

function MessageView({
  message,
  disabled,
  onChoose,
}: {
  message: EmulatorMessage
  disabled: boolean
  onChoose: (title: string, value: string) => void
}) {
  if (message.from === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[240px] rounded-xl bg-primary px-3 py-2 text-[13px] leading-[18px] text-primary-foreground">{message.text}</div>
      </div>
    )
  }
  const payload = message.payload as ResponsePayload
  return <BotPayload payload={payload} disabled={disabled} onChoose={onChoose} />
}

function BotPayload({
  payload,
  disabled,
  onChoose,
}: {
  payload: ResponsePayload
  disabled: boolean
  onChoose: (title: string, value: string) => void
}) {
  switch (payload.type) {
    case 'text':
      return <Bubble>{String(payload.text ?? '')}</Bubble>
    case 'single-choice': {
      const choices = (payload.choices as { title: string; value: string }[] | undefined) ?? []
      return (
        <div className="flex flex-col gap-1.5">
          {payload.text ? <Bubble>{String(payload.text)}</Bubble> : null}
          <div className="grid gap-1.5">
            {choices.map((c) => (
              <Button key={c.value} variant="outline" className="h-8 justify-start" disabled={disabled} onClick={() => onChoose(c.title, c.value)}>
                {c.title}
              </Button>
            ))}
          </div>
        </div>
      )
    }
    case 'carousel': {
      const items = (payload.items as { title: string; subtitle?: string }[] | undefined) ?? []
      return (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {items.map((item, i) => (
            <div key={i} className="w-[180px] shrink-0 rounded-xl border border-border p-3">
              <div className="text-[13px] font-medium">{item.title}</div>
              {item.subtitle && <div className="mt-0.5 text-xs text-muted-foreground">{item.subtitle}</div>}
            </div>
          ))}
        </div>
      )
    }
    case 'image':
      return (
        <div className="flex flex-col gap-1">
          <img src={String(payload.image)} alt={String(payload.title ?? '')} className="max-h-[160px] rounded-lg border border-border object-cover" onError={(e) => (e.currentTarget.style.display = 'none')} />
          {payload.title ? <span className="text-xs text-muted-foreground">{String(payload.title)}</span> : null}
        </div>
      )
    case 'file':
      return (
        <a href={String(payload.file)} target="_blank" rel="noreferrer" className="inline-flex max-w-[260px] items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px] hover:bg-muted">
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{String(payload.title ?? payload.file)}</span>
        </a>
      )
    default:
      return <Bubble>{JSON.stringify(payload)}</Bubble>
  }
}

function Bubble({ children }: { children: ReactNode }) {
  return <div className={cn('max-w-[240px] rounded-xl bg-muted px-3 py-2 text-[13px] leading-[18px] whitespace-pre-wrap')}>{children}</div>
}

function StatePanel({ emu, botId }: { emu: EmulatorApi; botId: string }) {
  const [tab, setTab] = useState('state')
  const state = emu.state
  return (
    <div className="flex max-h-[240px] flex-col gap-2 overflow-y-auto border-t border-border bg-canvas p-3.5">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="state">State</TabsTrigger>
          <TabsTrigger value="session">Session</TabsTrigger>
          <TabsTrigger value="temp">Temp</TabsTrigger>
          <TabsTrigger value="metadata">Metadata</TabsTrigger>
          <TabsTrigger value="raw">Raw</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'raw' ? (
        <pre className="font-mono-code text-[11px] whitespace-pre-wrap">
          {JSON.stringify(emu.exchange ?? { state: state ?? {} }, null, 2)}
        </pre>
      ) : tab === 'metadata' ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-muted-foreground">
            Sent as <span className="font-mono-code">metadata</span> with every message. <span className="font-mono-code">new_session</span> is set by the emulator.
          </p>
          <Textarea
            aria-label="Emulator metadata JSON"
            spellCheck={false}
            className="font-mono-code text-[11px]"
            rows={10}
            value={emu.metadataText}
            onChange={(e) => emu.changeMetadata(e.target.value)}
          />
          {emu.metadataError && <p role="alert" className="text-[11px] text-red">{emu.metadataError}</p>}
        </div>
      ) : (
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
      )}
    </div>
  )
}

function Kv({ k, v }: { k: string; v: unknown }) {
  const text = v === undefined || v === null || v === '' ? '-' : typeof v === 'string' ? v : JSON.stringify(v)
  return (
    <div className="flex items-center gap-2 font-mono-code text-[11px]">
      <span className="text-muted-foreground">{k}</span>
      <span className="flex-1" />
      <span className="max-w-[200px] truncate">{text}</span>
    </div>
  )
}
