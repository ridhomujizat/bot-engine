import { describe, expect, it } from 'vitest'
import type { FlowJson } from '@/api/types'
import { changedKeys, contentUsageCounts, hasChanges, mergeFormData, prefillDraft } from './contentEdit'
import { docFromFiles } from './model'

// A single-choice element as the legacy engine stores it, with keys the form does not render.
const stored = {
  'text$en': 'Ada yang bisa kami bantu?',
  'choices$en': [
    { title: 'Tagihan', value: 'bill' },
    { title: 'Paket', value: 'pkg' },
  ],
  'isDropdown$en': false,
  'dropdownPlaceholder$en': 'Pilih',
  'variations$en': ['Ada yang bisa?'],
  'custom$fr': { note: 'kept' },
}

describe('prefill and round trip', () => {
  it('copies the stored formData, every key included', () => {
    const draft = prefillDraft({ contentType: 'builtin_single-choice', formData: stored })
    expect(draft.contentType).toBe('builtin_single-choice')
    expect(draft.formData).toEqual(stored)
  })

  it('is a deep copy: editing the draft never touches the loaded element', () => {
    const element = { contentType: 'builtin_single-choice', formData: structuredClone(stored) }
    const draft = prefillDraft(element)
    ;(draft.formData['choices$en'] as { title: string }[])[0].title = 'Changed'
    expect(element.formData).toEqual(stored)
  })

  it('an untouched form is not a change and round-trips to the stored formData', () => {
    const draft = prefillDraft({ contentType: 'builtin_single-choice', formData: stored })
    expect(hasChanges(stored, draft.formData)).toBe(false)
    expect(mergeFormData(stored, draft.formData)).toEqual(stored)
  })

  it('editing the question changes only that key; unrendered keys survive the save', () => {
    const draft = prefillDraft({ contentType: 'builtin_single-choice', formData: stored })
    // What ContentForm does on a keystroke: spread the form data, set one key.
    const edited = { ...draft.formData, 'text$en': 'Ada yang bisa kami bantu, Kak?' }
    expect(changedKeys(stored, edited)).toEqual(['text$en'])
    const saved = mergeFormData(stored, edited)
    expect(saved).toEqual({ ...stored, 'text$en': 'Ada yang bisa kami bantu, Kak?' })
    expect(saved['variations$en']).toEqual(['Ada yang bisa?'])
    expect(saved['custom$fr']).toEqual({ note: 'kept' })
  })

  it('editing one choice title changes only choices$en, other choices and keys stay', () => {
    const draft = prefillDraft({ contentType: 'builtin_single-choice', formData: stored })
    const choices = [{ title: 'Tagihan & pembayaran', value: 'bill' }, { title: 'Paket', value: 'pkg' }]
    const edited = { ...draft.formData, 'choices$en': choices }
    expect(changedKeys(stored, edited)).toEqual(['choices$en'])
    const saved = mergeFormData(stored, edited)
    expect(saved['choices$en']).toEqual(choices)
    expect(saved['text$en']).toBe(stored['text$en'])
    expect(saved['dropdownPlaceholder$en']).toBe('Pilih')
  })

  it('a key added by the form counts as a change', () => {
    expect(changedKeys({ 'text$en': 'a' }, { 'text$en': 'a', 'typing$en': true })).toEqual(['typing$en'])
  })
})

function flow(name: string, body: Partial<FlowJson> & { nodes: FlowJson['nodes'] }) {
  return docFromFiles(name, { startNode: 'entry', ...body } as FlowJson, undefined)
}

describe('usage counting', () => {
  it('counts each say action and each choice skill question or invalid answer', () => {
    const main = flow('main.flow.json', {
      nodes: [
        { id: '1', name: 'entry', onEnter: ['say #!A'], next: [] },
        { id: '2', name: 'ask', onEnter: ['say #!A {"skill":"choice"}', 'builtin/setVariable {"name":"x"}'], onReceive: ['say #!B'], next: [] },
        { id: '3', name: 'skill', type: 'skill-call', skill: 'choice', flow: 'skills/choice-1.flow.json', next: [] },
      ],
      catchAll: { onReceive: ['say #!C'], next: [] },
    })
    const skillFlow = flow('skills/choice-1.flow.json', {
      nodes: [{ id: 's', name: 'start', onEnter: ['say #!D'], next: [] }],
      skillData: { contentId: 'A', invalidContentId: 'E', randomId: 'r' },
    })
    expect(contentUsageCounts([main, skillFlow])).toEqual({
      A: 3, // entry, ask, and the choice skill question
      B: 1,
      C: 1,
      E: 1, // the skill's invalid-answer element
      D: 1,
    })
  })

  it('a skill whose question and invalid answer are the same element counts it once', () => {
    const skillFlow = flow('skills/choice-2.flow.json', {
      nodes: [],
      skillData: { contentId: 'Q', invalidContentId: 'Q', randomId: 'r' },
    })
    expect(contentUsageCounts([skillFlow])).toEqual({ Q: 1 })
  })

  it('elements no flow names are absent, so the count reads as zero', () => {
    const main = flow('main.flow.json', { nodes: [{ id: '1', name: 'entry', onEnter: ['builtin/setVariable'], next: [] }] })
    expect(contentUsageCounts([main])['builtin_text-x'] ?? 0).toBe(0)
  })
})
