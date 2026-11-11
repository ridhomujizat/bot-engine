import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export interface NewFlowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  existing: string[]
  busy: boolean
  error: string | null
  onSubmit: (name: string) => void
  /** Rename or duplicate reuse this dialog: the title, the starting name and the button text change. */
  title?: string
  description?: string
  initialName?: string
  submitLabel?: string
}

/** Asks for a flow file name. `. on` is added when missing; `folder/name` creates a folder group. */
export function NewFlowDialog(props: NewFlowDialogProps) {
  const { open, onOpenChange } = props
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[440px]"
        title={props.title ?? 'New flow'}
        description={props.description ?? 'Creates a flow with one empty entry node.'}
      >
        {open && <NewFlowForm {...props} />}
      </DialogContent>
    </Dialog>
  )
}

function NewFlowForm({ existing, busy, error, onOpenChange, onSubmit, initialName = '', submitLabel = 'Create flow' }: NewFlowDialogProps) {
  const [name, setName] = useState(initialName.replace(/\.flow\.json$/, ''))
  const normalized = name.trim().endsWith('.flow.json') ? name.trim() : `${name.trim()}.flow.json`
  const valid = name.trim().length > 0 && !existing.some((e) => e.toLowerCase() === normalized.toLowerCase())
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor="flow-name">Name</Label>
        <Input id="flow-name" className="font-mono-code" placeholder="informasi/promo" value={name} onChange={(e) => setName(e.target.value)} />
        <p className="text-xs text-muted-foreground">
          {name.trim() && existing.includes(normalized) ? 'A flow with this name already exists' : `File: flows/${normalized}`}
        </p>
      </div>
      {error && <p role="alert" className="text-[13px] text-red">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="button" disabled={!valid || busy} onClick={() => onSubmit(normalized)}>
          {submitLabel}
        </Button>
      </div>
    </>
  )
}
