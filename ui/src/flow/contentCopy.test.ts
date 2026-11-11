import { describe, expect, it } from 'vitest'
import type { FlowNodeJson } from '@/api/types'
import { contentIdsOf, remapContentIds, remapSkillContentIds, uniqueContentIds } from './contentCopy'
import type { ChoiceSkillData } from './skill'

const copies = new Map([
  ['builtin_text-aaa', 'builtin_text-new1'],
  ['builtin_single-choice-bbb', 'builtin_single-choice-new2'],
])

describe('paste copies the content a node refers to', () => {
  it('lists say action ids, with and without args, and skips code actions', () => {
    const node: FlowNodeJson = {
      id: 'n1',
      name: 'n',
      onEnter: ['say #!builtin_text-aaa', 'builtin/setVariable {"type":"temp"}'],
      onReceive: ['say #!builtin_single-choice-bbb {"skill":"choice"}'],
      next: [],
    }
    expect(contentIdsOf(node)).toEqual(['builtin_text-aaa', 'builtin_single-choice-bbb'])
  })

  it('remaps say actions to the copies and keeps their args', () => {
    const node: FlowNodeJson = {
      id: 'n1',
      name: 'n',
      onEnter: ['say #!builtin_text-aaa', 'builtin/setVariable {"type":"temp"}'],
      onReceive: ['say #!builtin_single-choice-bbb {"skill":"choice"}', 'say #!builtin_text-other'],
      next: [{ condition: 'true', node: 'x' }],
    }
    const out = remapContentIds(node, copies)
    expect(out.onEnter).toEqual(['say #!builtin_text-new1', 'builtin/setVariable {"type":"temp"}'])
    expect(out.onReceive).toEqual(['say #!builtin_single-choice-new2 {"skill":"choice"}', 'say #!builtin_text-other'])
    expect(out.next).toEqual(node.next)
 // The source node is not changed.
    expect(node.onEnter?.[0]).toBe('say #!builtin_text-aaa')
  })

  it('keeps null actions of skill-call nodes', () => {
    const node: FlowNodeJson = { id: 's', name: 's', type: 'skill-call', onEnter: null, onReceive: null, next: [] }
    expect(remapContentIds(node, copies).onEnter).toBeNull()
  })

  it('a choice skill counts its question and its invalid answer, and remaps both', () => {
    const skill: ChoiceSkillData = {
      randomId: 'r',
      contentId: 'builtin_single-choice-bbb',
      invalidContentId: 'builtin_text-aaa',
      keywords: {},
      config: { nbMaxRetries: 3, repeatChoicesOnInvalid: false, variableName: '' },
    }
    const node: FlowNodeJson = { id: 's', name: 's', type: 'skill-call', onEnter: null, onReceive: null, next: [] }
    expect(contentIdsOf(node, skill)).toEqual(['builtin_single-choice-bbb', 'builtin_text-aaa'])
    const out = remapSkillContentIds(skill, copies)
    expect(out.contentId).toBe('builtin_single-choice-new2')
    expect(out.invalidContentId).toBe('builtin_text-new1')
    expect(skill.contentId).toBe('builtin_single-choice-bbb')
  })

  it('duplicates each referenced element once, even when several nodes refer to it', () => {
    expect(uniqueContentIds(['builtin_text-aaa', 'builtin_text-aaa', 'builtin_single-choice-bbb'])).toEqual([
      'builtin_text-aaa',
      'builtin_single-choice-bbb',
    ])
  })

  it('leaves an invalid answer that is not set empty', () => {
    const skill: ChoiceSkillData = { randomId: 'r', contentId: 'builtin_single-choice-bbb', invalidContentId: '', keywords: {}, config: { nbMaxRetries: 3, repeatChoicesOnInvalid: false, variableName: '' } }
    expect(remapSkillContentIds(skill, copies).invalidContentId).toBe('')
  })
})
