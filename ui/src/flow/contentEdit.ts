import type { CatchAll, ContentElement } from '@/api/types'
import { parseNodeAction } from './actions'
import type { FlowDoc } from './model'
import type { ChoiceSkillData } from './skill'

// Editing a content element from the say action dialog. Pure helpers: the dialog does the writes.
// Every key of the stored formData is kept: the form renders some keys, the rest ride along untouched.

export interface ContentDraft {
  contentType: string
  formData: Record<string, unknown>
}

/** The editable copy of a stored element. A deep copy, so edits never touch the loaded element. */
export function prefillDraft(element: Pick<ContentElement, 'contentType' | 'formData'>): ContentDraft {
  return { contentType: element.contentType, formData: structuredClone(element.formData) }
}

/** The formData to store: the stored keys, with the edited values on top. Unrendered keys survive. */
export function mergeFormData(stored: Record<string, unknown>, edited: Record<string, unknown>): Record<string, unknown> {
  return { ...structuredClone(stored), ...structuredClone(edited) }
}

/** Keys whose value differs between the stored formData and the edited one (deep, by JSON). */
export function changedKeys(stored: Record<string, unknown>, edited: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(stored), ...Object.keys(edited)])
  return [...keys].filter((key) => JSON.stringify(stored[key]) !== JSON.stringify(edited[key]))
}

/** True when saving would change the stored element. An untouched form is not written. */
export function hasChanges(stored: Record<string, unknown>, edited: Record<string, unknown>): boolean {
  return changedKeys(stored, edited).length > 0
}

/**
 * How many references each content element has across the bot's flows: one per say action (node
 * actions and flow-wide actions), and one per choice skill flow that asks it as its question or
 * invalid-answer element. Elements missing from the map are used nowhere.
 */
export function contentUsageCounts(docs: readonly FlowDoc[]): Record<string, number> {
  const counts: Record<string, number> = {}
  const bump = (id: string) => {
    counts[id] = (counts[id] ?? 0) + 1
  }
  for (const doc of docs) {
    const actions = [
      ...doc.nodes.flatMap((n) => [...(n.onEnter ?? []), ...(n.onReceive ?? [])]),
      ...((doc.meta.catchAll as CatchAll | undefined)?.onReceive ?? []),
    ]
    for (const raw of actions) {
      const action = parseNodeAction(raw)
      if (action.kind === 'say') bump(action.contentId)
    }
    const skill = doc.meta.skillData as Partial<ChoiceSkillData> | undefined
    if (skill) {
      const ids = new Set([skill.contentId, skill.invalidContentId].filter((id): id is string => Boolean(id)))
      for (const id of ids) bump(id)
    }
  }
  return counts
}
