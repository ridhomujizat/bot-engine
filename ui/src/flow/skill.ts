import type { Point, SkillChoiceFlowResult, Transition } from '@/api/types'
import type { FlowDoc } from './model'
import { docFromFiles } from './model'

/** The `skillData` a choice skill keeps in its own flow file (legacy choice skill data shape). */
export interface ChoiceSkillData {
  randomId: string
  contentId: string
  invalidContentId: string
  keywords: Record<string, string[]>
  config: { nbMaxRetries: number; repeatChoicesOnInvalid: boolean; variableName: string }
}

export function choiceSkillData(
  randomId: string,
  values: { contentId: string; invalidContentId?: string; maxAttempts: number },
  keywords: Record<string, string[]>,
): ChoiceSkillData {
  return {
    randomId,
    contentId: values.contentId,
    invalidContentId: values.invalidContentId ?? '',
    keywords,
    config: { nbMaxRetries: values.maxAttempts, repeatChoicesOnInvalid: false, variableName: '' },
  }
}

/**
 * The skill flow file generated for a choice. The generator returns nodes without positions and
 * adds name/location; the file keeps the flow and skillData. New nodes are laid out in a row.
 */
export function skillFlowDoc(name: string, result: SkillChoiceFlowResult, skillData: ChoiceSkillData, positions?: Record<string, Point>): FlowDoc {
  const { name: _name, location: _location, ...flow } = result.flow
  const laid: Record<string, Point> = {}
  flow.nodes.forEach((n, i) => {
    laid[n.id] = positions?.[n.id] ?? { x: 100 + i * 260, y: 120 }
  })
 // legacy saves every flow through toFlowDto, which stamps version 0.0.1 (the generator's 0.0 is replaced).
  return docFromFiles(name, { ...flow, version: '0.0.1', skillData }, {
    nodes: flow.nodes.map((n) => ({ id: n.id, position: laid[n.id] })),
    links: [],
  })
}

/**
 * Transitions of a skill node after its skill was regenerated (legacy requestUpdateSkill): a
 * transition keeps the target of the old transition with the same condition, or else the same
 * caption. Transitions with no match start unlinked.
 */
export function mergeSkillTransitions(previous: readonly Transition[], generated: readonly Transition[]): Transition[] {
  return generated.map((t) => {
    const old = previous.find((p) => p.condition === t.condition) ?? previous.find((p) => p.caption === t.caption)
    return { ...t, node: old?.node || '' }
  })
}

/** Skill flow files that no node references any more once `removed` nodes are gone (legacy findNodesThatReferenceFlow). */
export function orphanedSkillFlows(flows: Record<string, FlowDoc>, removedFlow: string, removedNodeIds: ReadonlySet<string>, fromFlow: string): boolean {
  let refs = 0
  for (const [name, doc] of Object.entries(flows)) {
    for (const node of doc.nodes) {
      if (name === fromFlow && removedNodeIds.has(node.id)) continue
      if (node.flow === removedFlow) refs++
    }
  }
  return refs === 0
}
