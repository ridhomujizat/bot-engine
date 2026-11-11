import { useState } from 'react'
import type { Transition } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioItem } from '@/components/ui/radio-group'
import { Select } from '@/components/ui/select'

export interface TransitionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Transition being edited, or null when adding one. */
  initial: Transition | null
  /** Names of the other nodes in this flow. Transitions name nodes, not ids. */
  nodeNames: string[]
  /** Flow files available as subflow targets (flow name without the folder prefix kept). */
  flowNames: string[]
  onSubmit: (transition: Transition) => void
}

type ConditionKind = 'always' | 'otherwise' | 'raw'
type DestKind = 'node' | 'subflow' | 'return' | 'end'

/** Edit one transition: its condition and where it goes. Conditions are JavaScript expressions. */
export function TransitionDialog(props: TransitionDialogProps) {
  const { open, onOpenChange, initial } = props
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[520px]"
        title={initial ? 'Edit transition' : 'Add transition'}
        description="Transitions are checked in order. The first one that matches is followed."
      >
        {open && <TransitionForm key={initial ? 'edit' : 'new'} {...props} />}
      </DialogContent>
    </Dialog>
  )
}

function conditionKindOf(condition: string): ConditionKind {
  if (condition === 'true') return 'always'
  if (condition === 'otherwise') return 'otherwise'
  return 'raw'
}

/**
 * legacy's conditionType for a condition (TransitionModalForm.getConditionType): always, intent, props or raw.
 * legacy saves it with every transition, so ours does too.
 */
export function conditionTypeOf(condition: string): string {
  const c = condition.trim()
  if (c === 'true') return 'always'
  if (c.includes('event.nlu.intent.name')) return 'intent'
  if (/^(user|session|temp)\./.test(c)) return 'props'
  return 'raw'
}

function destKindOf(target: string, nodeNames: string[]): DestKind {
  if (nodeNames.includes(target)) return 'node'
  if (target === '#') return 'return'
  if (target === 'END') return 'end'
  return 'subflow'
}

function TransitionForm({ initial, nodeNames, flowNames, onSubmit, onOpenChange }: TransitionDialogProps) {
  const [condKind, setCondKind] = useState<ConditionKind>(initial ? conditionKindOf(initial.condition) : 'always')
  const [raw, setRaw] = useState(initial && conditionKindOf(initial.condition) === 'raw' ? initial.condition : '')
  const initialTarget = initial?.node ?? ''
  const [destKind, setDestKind] = useState<DestKind>(initial ? destKindOf(initialTarget, nodeNames) : 'node')
  const [nodeTarget, setNodeTarget] = useState(destKindOf(initialTarget, nodeNames) === 'node' ? initialTarget : (nodeNames[0] ?? ''))
  const [subflow, setSubflow] = useState(
    destKindOf(initialTarget, nodeNames) === 'subflow' ? initialTarget.split('#')[0] : (flowNames[0] ?? ''),
  )
  const [subNode, setSubNode] = useState(
    destKindOf(initialTarget, nodeNames) === 'subflow' && initialTarget.includes('#') ? initialTarget.split('#')[1] : '',
  )

  function submit() {
    const condition = condKind === 'always' ? 'true' : condKind === 'otherwise' ? 'otherwise' : raw.trim()
    let target: string
    switch (destKind) {
      case 'node':
        target = nodeTarget
        break
      case 'subflow':
        target = subNode.trim() ? `${subflow}#${subNode.trim()}` : subflow
        break
      case 'return':
        target = '#'
        break
      case 'end':
        target = 'END'
        break
    }
 // legacy keeps the stored conditionType while the condition kind is unchanged (it is only recomputed on a new kind).
    const keepStored = initial?.conditionType !== undefined && condKind === conditionKindOf(initial.condition)
    const conditionType =
      condKind === 'always' ? 'always' : keepStored ? initial?.conditionType : conditionTypeOf(condition)
    onSubmit({ ...(initial ?? {}), condition, conditionType, node: target })
    onOpenChange(false)
  }

  const canSubmit = (condKind !== 'raw' || raw.trim().length > 0) && (destKind !== 'node' || nodeTarget) && (destKind !== 'subflow' || subflow)

  return (
    <>
      <div className="grid gap-2.5">
        <Label>Condition</Label>
        <RadioGroup value={condKind} onValueChange={(v) => setCondKind(v as ConditionKind)}>
          <RadioItem value="always">Always</RadioItem>
          <RadioItem value="raw">Raw expression</RadioItem>
          <RadioItem value="otherwise">Otherwise (when no other transition matches)</RadioItem>
        </RadioGroup>
        {condKind === 'raw' && (
          <Input aria-label="Raw expression" className="font-mono-code" value={raw} onChange={(e) => setRaw(e.target.value)} />
        )}
      </div>

      <div className="h-px bg-border" />

      <div className="grid gap-2.5">
        <Label>When the condition is met</Label>
        <RadioGroup value={destKind} onValueChange={(v) => setDestKind(v as DestKind)}>
          <RadioItem value="node">Transition to node</RadioItem>
          <RadioItem value="subflow">Transition to subflow</RadioItem>
          <RadioItem value="return">Return to parent flow</RadioItem>
          <RadioItem value="end">End flow</RadioItem>
        </RadioGroup>
        {destKind === 'node' && (
          <Select aria-label="Target node" value={nodeTarget} onChange={(e) => setNodeTarget(e.target.value)}>
            {nodeNames.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </Select>
        )}
        {destKind === 'subflow' && (
          <div className="grid grid-cols-2 gap-2">
            <Select aria-label="Subflow" value={subflow} onChange={(e) => setSubflow(e.target.value)}>
              {flowNames.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </Select>
            <Input aria-label="Node in subflow" placeholder="Node (optional)" className="font-mono-code" value={subNode} onChange={(e) => setSubNode(e.target.value)} />
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="button" disabled={!canSubmit} onClick={submit}>
          {initial ? 'Update' : 'Add'}
        </Button>
      </div>
    </>
  )
}
