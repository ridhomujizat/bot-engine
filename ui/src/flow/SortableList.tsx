import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface SortableListProps<T> {
  /** The rows, in order. */
  items: readonly T[]
  /** Accessible name of the list; each grip is named after its row number. */
  label: string
  onMove: (from: number, to: number) => void
  /** Renders a row; `handle` is the drag grip the row places where it wants it. */
  render: (item: T, index: number, handle: ReactNode) => ReactNode
}

/**
 * A vertical list that reorders by dragging its grips (mouse or touch) or from the keyboard: focus
 * a grip, Space picks it up, the arrow keys move it, Space drops it, Escape cancels. One drop is one
 * `onMove`, so one edit and one undo step.
 */
export function SortableList<T>({ items, label, onMove, render }: SortableListProps<T>) {
  // Index first, so two equal rows (the same action twice) keep distinct ids while one is dragged.
  const ids = items.map((item, i) => `${i}:${JSON.stringify(item)}`)
  const sensors = useSensors(
    // A small distance keeps a plain click on the grip (or a row's edit button) from starting a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const [active, setActive] = useState<string | null>(null)
  // Focus follows a keyboard-moved row: rows re-key after a move, so its grip is found again by index.
  const focusIndex = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (focusIndex.current === null) return
    const index = focusIndex.current
    focusIndex.current = null
    const grip = listRef.current?.querySelector<HTMLElement>(`[data-sortable-index="${index}"] [data-grip]`)
    if (grip && listRef.current?.contains(document.activeElement) !== false) grip.focus()
  })

  function onDragStart(event: DragStartEvent) {
    setActive(String(event.active.id))
  }

  function onDragEnd(event: DragEndEvent) {
    setActive(null)
    const from = ids.indexOf(String(event.active.id))
    const to = event.over ? ids.indexOf(String(event.over.id)) : -1
    if (from === -1 || to === -1 || from === to) return
    focusIndex.current = to
    onMove(from, to)
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActive(null)}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div ref={listRef} role="list" aria-label={label} className="grid min-w-0 gap-2">
          {items.map((item, i) => (
            <SortableRow key={ids[i]} id={ids[i]} index={i} dragging={active === ids[i]}>
              {(handle) => render(item, i, handle)}
            </SortableRow>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

function SortableRow({ id, index, dragging, children }: { id: string; index: number; dragging: boolean; children: (handle: ReactNode) => ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id })
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      data-grip
      aria-label={`Drag to reorder row ${index + 1}`}
      className="flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-ring outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-3.5" />
    </button>
  )
  return (
    <div
      ref={setNodeRef}
      role="listitem"
      data-sortable-index={index}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('relative min-w-0', (isDragging || dragging) && 'z-10 opacity-90 shadow-md')}
    >
      {children(handle)}
    </div>
  )
}
