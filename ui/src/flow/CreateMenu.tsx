import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

export interface CreateMenuProps {
  /** Viewport pixels where the menu opens. */
  at: { x: number; y: number }
  canPaste: boolean
  onPaste: () => void
  onStandard: () => void
  onChoice: () => void
  onClose: () => void
}

/**
 * Context menu on empty canvas (legacy handleContextMenuNoElement): paste, standard node, choice skill.
 * Opened by right click, or by dropping a dragged transition port on empty canvas, which then links
 * the created node to that port.
 */
export function CreateMenu({ at, canPaste, onPaste, onStandard, onChoice, onClose }: CreateMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Add node"
      className="fixed z-50 flex min-w-[180px] flex-col gap-px rounded-lg border border-border bg-background p-1 shadow-lg"
 // Kept inside the viewport: a menu opened near the right or bottom edge still shows all its items.
      style={{ left: Math.max(8, Math.min(at.x, window.innerWidth - 200)), top: Math.max(8, Math.min(at.y, window.innerHeight - 140)) }}
    >
      {canPaste && <Item label="Paste" onClick={onPaste} />}
      {canPaste && <div className="my-1 h-px bg-border" />}
      <span className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted-foreground">Add node</span>
      <Item label="Standard node" onClick={onStandard} />
      <Item label="Choice skill" onClick={onChoice} />
    </div>
  )
}

function Item({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn('flex h-7 items-center rounded-md px-2 text-left text-[13px] hover:bg-muted')}
    >
      {label}
    </button>
  )
}
