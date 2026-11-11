import { describe, expect, it } from 'vitest'
import type { FlowJson, UiJson } from '@/api/types'
import { docFromFiles } from './model'
import { toGraph, type FlowRFNode } from './graph'
import { EDGE_APPROACH, EDGE_LEAD, NODE_W, TERMINAL_OFFSET, nodeHeight, routeEdge } from './layout'

// Real skill flows store `position: {}`; some nodes have no ui entry at all.
const flow: FlowJson = {
  startNode: 'entry',
  nodes: [
    {
      id: 'entry',
      name: 'entry',
      onEnter: ['say #!t1'],
      next: [
        { condition: 'a', node: 'menu' },
        { condition: 'b', node: 'END' },
      ],
    },
    {
      id: 'menu',
      type: 'skill-call',
      skill: 'choice',
      name: 'menu',
      next: [
        { condition: 'x', node: 'info' },
        { condition: 'y', node: '#' },
        { condition: 'z', node: 'handover.flow.json#entry' },
        { condition: 'w', node: 'entry' },
      ],
    },
    { id: 'info', name: 'info', onEnter: ['say #!t2', 'say #!t3'], next: [{ condition: 'true', node: 'menu' }] },
    { id: 'loose', name: 'loose', next: [{ condition: 'true', node: 'info' }] },
  ],
}
const ui: UiJson = {
  nodes: [
    { id: 'entry', position: { x: 100, y: 120 } },
    { id: 'menu', position: {} as { x: number; y: number } },
    { id: 'info', position: {} as { x: number; y: number } },
  ],
  links: [],
}

function build() {
  return toGraph({ doc: docFromFiles('main.flow.json', flow, ui), contentLabels: {}, runPath: new Set() })
}

describe('toGraph endpoints and positions', () => {
  it('every edge ends at a real node port or a terminal pill, with finite geometry', () => {
    const { nodes, edges } = build()
    const ids = new Set(nodes.map((n) => n.id))
    expect(edges.length).toBe(4 + 2 + 1 + 1) // entry 2, menu 4, info 1, loose 1 (all transitions)
    for (const e of edges) {
      expect(e.type).toBe('step')
      expect(ids.has(e.source), `source of ${e.id}`).toBe(true)
      expect(ids.has(e.target), `target of ${e.id}`).toBe(true)
      expect(Number.isFinite(e.data!.routeY)).toBe(true)
    }
    for (const n of nodes) {
      expect(Number.isFinite(n.position.x) && Number.isFinite(n.position.y), `position of ${n.id}`).toBe(true)
    }
  })

  it('never moves a node that has a stored position', () => {
    const { nodes } = build()
    expect(nodes.find((n) => n.id === 'entry')!.position).toEqual({ x: 100, y: 120 })
  })

  it('auto-laid-out nodes do not overlap', () => {
    const { nodes } = build()
    const boxes = nodes
      .filter((n): n is FlowRFNode & { data: { node: FlowJson['nodes'][number] } } => n.type !== 'terminal')
      .map((n) => {
        const node = (n.data as { node: FlowJson['nodes'][number] }).node
        const h = nodeHeight({
          onEnter: node.onEnter?.length ?? 0,
          onReceive: node.onReceive?.length ?? 0,
          transitions: node.next.length,
        })
        return { id: n.id, x: n.position.x, y: n.position.y, w: NODE_W, h }
      })
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false)
      }
    }
  })

  it('a terminal pill sits right of its source port, next to it', () => {
    const { nodes } = build()
    const entry = nodes.find((n) => n.id === 'entry')!
    const pill = nodes.find((n) => n.type === 'terminal' && n.id.startsWith('end:entry:'))!
    expect(pill.position.x).toBe(entry.position.x + NODE_W + TERMINAL_OFFSET)
  })
})

describe('routeEdge', () => {
  const numbers = (d: string) => d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []

  it('forward route stays between source and target', () => {
    const r = routeEdge({ sx: 340, sy: 200, tx: 760, ty: 80, lane: 1 })
    expect(r.d).not.toMatch(/NaN|Infinity/)
    const xs = numbers(r.d).filter((_, i) => i % 2 === 0)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(340)
    expect(Math.max(...xs)).toBeLessThanOrEqual(760)
  })

  it('terminal pill close to the source still routes forward (no backwards curve)', () => {
    const sx = 340
    const r = routeEdge({ sx, sy: 200, tx: sx + TERMINAL_OFFSET, ty: 200 })
    const xs = numbers(r.d).filter((_, i) => i % 2 === 0)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(sx)
    expect(Math.max(...xs)).toBeLessThanOrEqual(sx + TERMINAL_OFFSET)
  })

  it('backward route detours below both ends and never leaves a bounded box', () => {
    const sx = 700
    const tx = 340
    const routeY = 420
    const r = routeEdge({ sx, sy: 200, tx, ty: 100, lane: 0, routeY })
    expect(r.d).not.toMatch(/NaN|Infinity/)
    const xs = numbers(r.d).filter((_, i) => i % 2 === 0)
    const ys = numbers(r.d).filter((_, i) => i % 2 === 1)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(tx - EDGE_APPROACH - 1)
    expect(Math.max(...xs)).toBeLessThanOrEqual(sx + EDGE_LEAD + 1)
    expect(Math.max(...ys)).toBeLessThanOrEqual(routeY + 1)
  })
})
