import { describe, expect, it } from 'vitest'
import { indexOfId, moveItem, sortableIdsOf } from './reorder'
import { catchAllOf, moveCatchAllItem, moveNodeItem, docFromFiles } from './model'
import type { FlowJson, UiJson } from '@/api/types'

describe('moveItem', () => {
  it('moves an item to the target index and leaves the others in order', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b'])
  })

  it('returns a copy unchanged for a move onto itself or an index outside the list', () => {
    const list = ['a', 'b']
    expect(moveItem(list, 1, 1)).toEqual(['a', 'b'])
    expect(moveItem(list, -1, 0)).toEqual(['a', 'b'])
    expect(moveItem(list, 0, 5)).toEqual(['a', 'b'])
    expect(moveItem(list, 0, 1)).not.toBe(list)
  })

  it('does not mutate the input', () => {
    const list = [1, 2, 3]
    moveItem(list, 0, 2)
    expect(list).toEqual([1, 2, 3])
  })
})

describe('sortable ids', () => {
  it('keeps equal rows distinct through the index', () => {
    const ids = sortableIdsOf(['say #!x', 'say #!x'])
    expect(new Set(ids).size).toBe(2)
    expect(indexOfId(ids, ids[1])).toBe(1)
    expect(indexOfId(ids, 'missing')).toBe(-1)
    expect(indexOfId(ids, undefined)).toBe(-1)
  })
})

const flow: FlowJson = {
  startNode: 'entry',
  catchAll: { onReceive: ['a1', 'a2'], next: [{ condition: 'true', node: 'entry' }, { condition: 'x', node: 'END' }] },
  nodes: [
    {
      id: 'entry',
      name: 'entry',
      onEnter: ['say #!t1', 'say #!t2', 'builtin/setVariable {"name":"x"}'],
      onReceive: ['r1', 'r2'],
      next: [
        { condition: 'a', node: 'END' },
        { condition: 'b', node: '#' },
        { condition: 'true', node: 'entry' },
      ],
    },
  ],
}
const ui: UiJson = { nodes: [{ id: 'entry', position: { x: 100, y: 120 } }], links: [] }

describe('reorder model moves', () => {
  it('moves transitions and actions of one node', () => {
    const doc = docFromFiles('main.flow.json', flow, ui)
    const moved = moveNodeItem(doc, 'entry', 'next', 2, 0)
    expect(moved.nodes[0].next.map((t) => t.condition)).toEqual(['true', 'a', 'b'])
    const enter = moveNodeItem(doc, 'entry', 'onEnter', 0, 2)
    expect(enter.nodes[0].onEnter).toEqual(['say #!t2', 'builtin/setVariable {"name":"x"}', 'say #!t1'])
    const receive = moveNodeItem(doc, 'entry', 'onReceive', 1, 0)
    expect(receive.nodes[0].onReceive).toEqual(['r2', 'r1'])
  })

  it('returns the same document for a move that changes nothing (no undo step)', () => {
    const doc = docFromFiles('main.flow.json', flow, ui)
    expect(moveNodeItem(doc, 'entry', 'next', 1, 1)).toBe(doc)
    expect(moveNodeItem(doc, 'missing', 'next', 0, 1)).toBe(doc)
  })

  it('moves flow-wide actions and transitions', () => {
    const doc = docFromFiles('main.flow.json', flow, ui)
    expect(catchAllOf(moveCatchAllItem(doc, 'onReceive', 0, 1)).onReceive).toEqual(['a2', 'a1'])
    expect(catchAllOf(moveCatchAllItem(doc, 'next', 1, 0)).next.map((t) => t.condition)).toEqual(['x', 'true'])
  })
})
