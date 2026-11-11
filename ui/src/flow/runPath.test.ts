import { describe, expect, it } from 'vitest'
import { docFromFiles } from './model'
import { runEdgeStates, runNodeIds } from './runPath'
import { parseStackEntries } from '@/emulator/session'
import type { FlowJson, UiJson } from '@/api/types'

const flow: FlowJson = {
  startNode: 'entry',
  nodes: [
    { id: 'e', name: 'entry', next: [{ condition: 'true', node: 'menu' }] },
    { id: 'm', name: 'menu', next: [{ condition: 'x', node: 'info' }, { condition: 'y', node: 'END' }] },
    { id: 'i', name: 'info', next: [{ condition: 'true', node: 'menu' }] },
  ],
}
const ui: UiJson = { nodes: [], links: [] }
const doc = docFromFiles('main.flow.json', flow, ui)

describe('run path edges', () => {
  it('marks taken transitions past, and the newest one recent', () => {
    const stack = parseStackEntries([
      { flow: 'main.flow.json', node: 'entry' },
      { flow: 'main.flow.json', node: 'menu' },
      { flow: 'main.flow.json', node: 'info' },
      { flow: 'main.flow.json', node: 'menu' },
    ])
    const states = runEdgeStates(doc, stack, 'main.flow.json')
    expect(Object.fromEntries(states)).toEqual({ 'e:0': 'past', 'm:0': 'past', 'i:0': 'recent' })
  })

  it('ignores steps in another flow and steps without a transition', () => {
    const stack = parseStackEntries([
      { flow: 'main.flow.json', node: 'entry' },
      { flow: 'produk.flow.json', node: 'start' },
      { flow: 'main.flow.json', node: 'info' },
    ])
    expect(runEdgeStates(doc, stack, 'main.flow.json').size).toBe(0)
    expect(runEdgeStates(doc, stack, 'produk.flow.json').size).toBe(0)
  })

  it('lists the nodes of this flow on the run path', () => {
    const stack = parseStackEntries(['main.flow.json#menu', 'other.flow.json#x', 'info'])
    expect([...runNodeIds(doc, stack, 'main.flow.json')].sort()).toEqual(['i', 'm'])
  })

  it('reads a stack given as a string and as objects', () => {
    expect(parseStackEntries('entry > menu').map((e) => e.node)).toEqual(['entry', 'menu'])
    expect(parseStackEntries([{ node: 'a' }, 'b#c', null])).toEqual([
      { flow: null, node: 'a' },
      { flow: 'b', node: 'c' },
    ])
  })
})
