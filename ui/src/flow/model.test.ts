import { describe, expect, it } from 'vitest'
import type { FlowJson, UiJson } from '@/api/types'
import {
  addNode,
  connectTransition,
  syncLinks,
  unlinkTransitions,
  copyName,
  pasteNodes,
  docFromFiles,
  docFromView,
  removeNodes,
  toFlowJson,
  toFlowView,
  toUiJson,
} from './model'

const flow: FlowJson = {
  version: '0.0.1',
  catchAll: { onReceive: [], next: [] },
  startNode: 'entry',
  nodes: [
    {
      id: 'entry',
      name: 'entry',
      onEnter: ['builtin/setVariable {"type":"session","name":"sid","value":"{{event.payload.metadata.sid}}"}', 'say #!builtin_text-Xk29aQ'],
      onReceive: null,
      next: [{ condition: 'true', node: 'menu-utama' }],
    },
    {
      id: 'skill-4cd383',
      type: 'skill-call',
      skill: 'choice',
      name: 'menu-utama',
      flow: 'skills/choice-4cd383.flow.json',
      next: [
        { condition: "temp['skill-choice-ret-4cd383'] == 'info'", node: 'informasi' },
        { condition: 'true', node: '#', caption: 'return' },
      ],
      customField: { keep: [1, 2, 3] },
    },
    {
      id: 'informasi',
      name: 'informasi',
      onEnter: ['say #!builtin_text-abc'],
      next: [{ condition: 'true', node: 'END' }],
    },
  ],
}

const ui: UiJson = {
  nodes: [
    { id: 'entry', position: { x: 100, y: 186 } },
    { id: 'skill-4cd383', position: { x: 400, y: 150 } },
    { id: 'informasi', position: { x: 760, y: 20 } },
  ],
 // One link per transition to a node of this flow (legacy draws none for END, return or other flows).
  links: [
    { source: 'entry', sourcePort: 'out0', target: 'skill-4cd383', points: [{ x: 1, y: 2 }] },
    { source: 'skill-4cd383', sourcePort: 'out0', target: 'informasi', points: [] },
  ],
}

describe('flow document round trip', () => {
  it('keeps the flow JSON identical after reading it into a document', () => {
    const doc = docFromFiles('main.flow.json', flow, ui)
    expect(toFlowJson(doc)).toEqual(flow)
  })

  it('keeps the UI JSON identical', () => {
    const doc = docFromFiles('main.flow.json', flow, ui)
    expect(toUiJson(doc)).toEqual(ui)
  })

  it('round trips through the GET /flows view and the save body', () => {
    const view = {
      ...flow,
      name: 'main.flow.json',
      location: 'main.flow.json',
      nodes: flow.nodes.map((n) => ({ ...n, ...ui.nodes.find((u) => u.id === n.id)!.position, lastModified: '2026-11-11' })),
      links: ui.links,
    }
    const doc = docFromView(view)
    expect(toFlowJson(doc)).toEqual(flow)
    const save = toFlowView(doc)
    expect(save.nodes[0]).toMatchObject({ id: 'entry', x: 100, y: 186 })
    expect(save.name).toBe('main.flow.json')
  })

  it('keeps unknown fields on nodes and transitions', () => {
    const doc = docFromFiles('main.flow.json', flow, ui)
    expect(toFlowJson(doc).nodes[1]).toMatchObject({ customField: { keep: [1, 2, 3] } })
    expect(toFlowJson(doc).nodes[1].next[1]).toMatchObject({ caption: 'return' })
  })
})

describe('flow document edits', () => {
  it('re-points a transition without touching other fields', () => {
    const doc = connectTransition(docFromFiles('main.flow.json', flow, ui), 'entry', 0, 'informasi')
    expect(toFlowJson(doc).nodes[0].next).toEqual([{ condition: 'true', node: 'informasi' }])
    expect(toFlowJson(doc).nodes[1]).toEqual(flow.nodes[1])
  })

  it('removes nodes and keeps transitions that name them (legacy leaves dangling targets)', () => {
    const doc = removeNodes(docFromFiles('main.flow.json', flow, ui), new Set(['informasi']))
    expect(doc.nodes.map((n) => n.id)).toEqual(['entry', 'skill-4cd383'])
    expect(doc.nodes[0].next.map((t) => t.node)).toEqual(['menu-utama'])
    expect(doc.positions.informasi).toBeUndefined()
  })

  it('adds a node with a position', () => {
    const doc = addNode(docFromFiles('main.flow.json', flow, ui), { id: 'new', name: 'new', next: [] }, { x: 5, y: 6 })
    expect(toUiJson(doc).nodes).toContainEqual({ id: 'new', position: { x: 5, y: 6 } })
  })

  it('pastes copies with copyName and re-points transitions between copies', () => {
    const doc = docFromFiles('main.flow.json', flow, ui)
    const items = ['entry', 'skill-4cd383'].map((id) => ({ node: doc.nodes.find((n) => n.id === id)!, position: doc.positions[id] }))
    let n = 0
    const { doc: next, newIds } = pasteNodes(doc, items, { x: 40, y: 40 }, () => `new${++n}`)
    expect(newIds).toEqual(['new1', 'new2'])
    const entryCopy = next.nodes.find((x) => x.id === 'new1')!
    expect(entryCopy.name).toBe('entry-copy')
 // menu-utama is copied too, so the copy points at the copy.
    expect(entryCopy.next[0].node).toBe('menu-utama-copy')
    expect(next.nodes.find((x) => x.id === 'entry')!.next[0].node).toBe('menu-utama')
  })

  it('unlinks transitions to nodes that are not part of the paste', () => {
    const doc = docFromFiles('main.flow.json', flow, ui)
    const items = [{ node: doc.nodes.find((n) => n.id === 'entry')!, position: { x: 0, y: 0 } }]
    const { doc: next } = pasteNodes(doc, items, { x: 0, y: 0 }, () => 'c1')
    expect(next.nodes.find((x) => x.id === 'c1')!.next[0].node).toBe('')
  })

  it('names copies x-copy, x-copy-1, x-copy-2 like legacy copyName', () => {
    expect(copyName(['a'], 'a')).toBe('a-copy')
    expect(copyName(['a', 'a-copy'], 'a')).toBe('a-copy-1')
    expect(copyName(['a', 'a-copy', 'a-copy-1'], 'a')).toBe('a-copy-2')
  })
})

describe('ui links follow the transitions', () => {
  it('appends a link when a transition is connected and drops it when unlinked', () => {
    const doc = docFromFiles('main.flow.json', flow, ui)
    const linked = connectTransition(doc, 'informasi', 0, 'entry')
    expect(syncLinks(linked).at(-1)).toEqual({ source: 'informasi', sourcePort: 'out0', target: 'entry', points: [] })
    const unlinked = unlinkTransitions(linked, [{ nodeId: 'entry', index: 0 }])
    expect(syncLinks(unlinked).some((l) => l.source === 'entry')).toBe(false)
    expect(toUiJson(unlinked).links.length).toBe(2)
  })
})
