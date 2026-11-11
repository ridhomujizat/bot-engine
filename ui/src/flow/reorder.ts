/**
 * Pure reorder helpers for the drag-to-reorder lists (transitions, actions, flow-wide rows).
 * They return a new array; an index outside the list or a move onto itself returns the list unchanged.
 */

/** Moves the item at `from` so it ends at index `to` of the result. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const inRange = (i: number) => Number.isInteger(i) && i >= 0 && i < list.length
  if (!inRange(from) || !inRange(to) || from === to) return [...list]
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/**
 * Sortable ids for a list of strings. The index is part of the id so two equal rows (two identical
 * actions) stay distinct while dragging.
 */
export function sortableIdsOf(list: readonly string[]): string[] {
  return list.map((value, i) => `${i}:${value}`)
}

/** Index of a sortable id in the id list, or -1. */
export function indexOfId(ids: readonly string[], id: string | number | undefined): number {
  if (id === undefined) return -1
  return ids.indexOf(String(id))
}
