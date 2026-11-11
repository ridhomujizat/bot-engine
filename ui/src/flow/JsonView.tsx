import { useState } from 'react'
import type { FlowJson } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export interface JsonViewProps {
  name: string
  json: string
  /** Applies a parsed flow to the draft. Throws with a message when the shape is wrong. */
  onApply: (flow: FlowJson) => void
}

/** Raw `*.json` editor. Validate applies the text to the draft; Save writes it with the rest. */
export function JsonView({ name, json, onApply }: JsonViewProps) {
  const [text, setText] = useState(json)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const lines = text.split('\n').length

  function validate(): FlowJson | null {
    try {
      const flow = parseFlow(text)
      setMessage({ ok: true, text: `Valid  ·  ${flow.nodes.length} nodes` })
      return flow
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Invalid JSON' })
      return null
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-10 items-center gap-2 border-b border-border bg-canvas px-3">
        <span className="font-mono-code text-xs">flows/{name}</span>
        <Badge>legacy format</Badge>
        <span className="flex-1 truncate text-xs text-muted-foreground">Layout is stored in the matching .ui.json</span>
        {message && <span className={message.ok ? 'text-xs text-green' : 'text-xs text-red'}>{message.text}</span>}
        <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard?.writeText(text)}>
          Copy
        </Button>
        <Button variant="outline" size="sm" onClick={() => {
          try {
            setText(JSON.stringify(JSON.parse(text), null, 2))
            setMessage(null)
          } catch {
            setMessage({ ok: false, text: 'Fix the JSON before formatting' })
          }
        }}>
          Format
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const flow = validate()
            if (flow) onApply(flow)
          }}
        >
          Apply
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 overflow-auto font-mono-code text-xs">
        <div className="shrink-0 border-r border-border bg-canvas py-2.5 pr-3 pl-3 text-right text-ring select-none">
          {Array.from({ length: lines }, (_, i) => (
            <div key={i} style={{ height: 20 }}>{i + 1}</div>
          ))}
        </div>
        <textarea
          aria-label="Flow JSON"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setMessage(null)
          }}
          wrap="off"
          className="min-h-full flex-1 resize-none bg-background py-2.5 pr-3 pl-3 leading-5 outline-none"
          style={{ lineHeight: '20px' }}
        />
      </div>
    </div>
  )
}

/** Checks the parts the editor relies on: nodes with ids and names, transitions, and a start node. */
export function parseFlow(text: string): FlowJson {
  const value = JSON.parse(text) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The flow must be a JSON object')
  const flow = value as Partial<FlowJson>
  if (!Array.isArray(flow.nodes)) throw new Error('"nodes" must be an array')
  if (typeof flow.startNode !== 'string') throw new Error('"startNode" must be a node name')
  flow.nodes.forEach((node, i) => {
    if (!node || typeof node.id !== 'string' || typeof node.name !== 'string') {
      throw new Error(`nodes[${i}] needs string "id" and "name"`)
    }
    if (!Array.isArray(node.next)) throw new Error(`nodes[${i}].next must be an array`)
    node.next.forEach((t, j) => {
      if (typeof t?.condition !== 'string' || typeof t?.node !== 'string') {
        throw new Error(`nodes[${i}].next[${j}] needs string "condition" and "node"`)
      }
    })
  })
  return flow as FlowJson
}
