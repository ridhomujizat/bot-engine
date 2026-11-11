import type { FlowNodeJson } from '@/api/types'
import type { ChoiceSkillData } from './skill'

// Pasting copies the content a node refers to (owner decision, 2026-11-11): legacy keeps the same element
// id, so editing the copy's text would change the original. Ours duplicates each referenced element once
// per paste and points the copy at the duplicate. Pure helpers; the editor does the element writes.

/** `say #!<id>` with any args after the id, e.g. `say #!builtin_single-choice-x {"skill":"choice"}`. */
const SAY = /^(say #!)(\S+)(.*)$/s

/** Element ids a node refers to: its say actions, and for a choice skill its question and invalid answer. */
export function contentIdsOf(node: FlowNodeJson, skill?: ChoiceSkillData): string[] {
  const ids: string[] = []
  for (const action of [...(node.onEnter ?? []), ...(node.onReceive ?? [])]) {
    const m = SAY.exec(action)
    if (m) ids.push(m[2])
  }
  if (skill?.contentId) ids.push(skill.contentId)
  if (skill?.invalidContentId) ids.push(skill.invalidContentId)
  return ids
}

/** The distinct ids in first-seen order: each element is duplicated once per paste. */
export function uniqueContentIds(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

/** The node with each say action pointing at its copy (ids without a copy stay as they are). */
export function remapContentIds(node: FlowNodeJson, copies: ReadonlyMap<string, string>): FlowNodeJson {
  const remap = (action: string) => {
    const m = SAY.exec(action)
    if (!m || !copies.has(m[2])) return action
    return `${m[1]}${copies.get(m[2])}${m[3]}`
  }
  return {
    ...node,
    onEnter: node.onEnter ? node.onEnter.map(remap) : node.onEnter,
    onReceive: node.onReceive ? node.onReceive.map(remap) : node.onReceive,
  }
}

/** The choice skill data with its question and invalid answer pointing at their copies. */
export function remapSkillContentIds(skill: ChoiceSkillData, copies: ReadonlyMap<string, string>): ChoiceSkillData {
  return {
    ...skill,
    contentId: copies.get(skill.contentId) ?? skill.contentId,
    invalidContentId: skill.invalidContentId ? (copies.get(skill.invalidContentId) ?? skill.invalidContentId) : skill.invalidContentId,
  }
}
