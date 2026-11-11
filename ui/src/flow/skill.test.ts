import { describe, expect, it } from 'vitest'
import { mergeSkillTransitions, orphanedSkillFlows, skillFlowDoc } from './skill'
import type { FlowDoc } from './model'

describe('skill helpers', () => {
  it('keeps the target of a transition whose condition or caption is unchanged (legacy updateSkill)', () => {
    const previous = [
      { condition: 'user.choice == "a"', caption: 'User picked [a]', node: 'after-a' },
      { condition: 'false', caption: 'On failure', node: 'retry' },
    ]
    const generated = [
      { condition: 'user.choice == "a"', caption: 'User picked [a]', node: '' },
      { condition: 'user.choice == "b"', caption: 'User picked [b]', node: '' },
      { condition: 'false', caption: 'On failure', node: '' },
    ]
    expect(mergeSkillTransitions(previous, generated).map((t) => t.node)).toEqual(['after-a', '', 'retry'])
  })

  it('a skill flow is orphaned when no other node references it', () => {
    const node = { id: 'skill-1', name: 'choice-1', type: 'skill-call', flow: 'skills/choice-x.flow.json', next: [] }
    const main: FlowDoc = { name: 'main.flow.json', meta: { startNode: 'entry' }, nodes: [node], positions: {}, links: [] }
    const flows = { 'main.flow.json': main }
    expect(orphanedSkillFlows(flows, 'skills/choice-x.flow.json', new Set(['skill-1']), 'main.flow.json')).toBe(true)
    const other: FlowDoc = { name: 'other.flow.json', meta: { startNode: 'a' }, nodes: [{ ...node, id: 'skill-2' }], positions: {}, links: [] }
    expect(orphanedSkillFlows({ ...flows, 'other.flow.json': other }, 'skills/choice-x.flow.json', new Set(['skill-1']), 'main.flow.json')).toBe(false)
  })

  it('builds the skill flow file with skillData and default row layout', () => {
    const doc = skillFlowDoc(
      'skills/choice-abc123.flow.json',
      { flow: { startNode: 'entry', nodes: [{ id: 'n1', name: 'n1', next: [] }, { id: 'n2', name: 'n2', next: [] }] }, transitions: [] },
      { randomId: 'r1', contentId: 'q', invalidContentId: '', keywords: {}, config: { nbMaxRetries: 3, repeatChoicesOnInvalid: false, variableName: '' } },
    )
    expect(doc.meta.skillData).toMatchObject({ randomId: 'r1' })
    expect(doc.positions).toEqual({ n1: { x: 100, y: 120 }, n2: { x: 360, y: 120 } })
  })
})
