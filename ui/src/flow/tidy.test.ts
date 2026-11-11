import { describe, expect, it } from 'vitest'
import type { FlowJson } from '@/api/types'
import { toGraph, type FlowRFEdge, type FlowRFNode } from './graph'
import { docFromFiles, moveNodes, toFlowJson, toUiJson, type FlowDoc } from './model'
import { MIN_GAP, fixOverlaps, objectsOf, overlappingIds, sizesOf, snapNearest, tidyPositions, type Obj } from './tidy'

/** Seeded, dense flow: every node has 1-3 transitions, some back edges, END and flow pills. */
function denseFlow(count: number, seed: number): FlowJson {
  let s = seed
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  const name = (i: number) => (i === 0 ? 'entry' : `n${i}`)
  const nodes = Array.from({ length: count }, (_, i) => {
    const outs = 1 + Math.floor(rnd() * 3)
    const next = Array.from({ length: outs }, (_, k) => {
      const r = rnd()
      const target = r < 0.1 ? 'END' : r < 0.15 ? 'handover.flow.json#entry' : name(Math.floor(rnd() * count))
      return { condition: `c${k}`, node: target }
    })
    return {
      id: `id${i}`,
      name: name(i),
      onEnter: i % 2 === 0 ? ['say #!t1', 'say #!t2'] : [],
      onReceive: i % 3 === 0 ? [] : null,
      next,
    }
  })
  return { startNode: 'entry', nodes } as unknown as FlowJson
}

function docOf(flow: FlowJson, at?: (i: number) => { x: number; y: number }): FlowDoc {
  const ui = at ? { nodes: flow.nodes.map((n, i) => ({ id: n.id, position: at(i) })) } : undefined
  return docFromFiles('main.flow.json', flow, ui as never)
}

/** The rendered graph of a document, the way the canvas derives it (pills follow their node). */
function graphOf(doc: FlowDoc): { nodes: FlowRFNode[]; edges: FlowRFEdge[] } {
  return toGraph({ doc, contentLabels: {}, runPath: new Set() })
}

/** Writes positions into the document and re-derives the graph, as an edit does. */
function relayout(doc: FlowDoc, positions: Record<string, { x: number; y: number }>) {
  return graphOf(moveNodes(doc, positions))
}

function overlapsOf(doc: FlowDoc, gap = 0): string[] {
  const { nodes, edges } = graphOf(doc)
  return overlappingIds(objectsOf(nodes, edges, sizesOf(nodes)), gap)
}

const box = (id: string, x: number, y: number, h = 100, w = 240): Obj => ({ id, x, y, parts: [{ dx: 0, dy: 0, w, h }] })
const apply = (objs: Obj[], positions: Record<string, { x: number; y: number }>): Obj[] =>
  objs.map((o) => ({ ...o, ...positions[o.id] }))

describe('overlap detection', () => {
  it('finds overlapping boxes and boxes closer than the gap', () => {
    const a = box('a', 0, 0)
    expect(overlappingIds([a, box('b', 200, 50)])).toEqual(['a', 'b'])
    // 10px apart horizontally, vertically overlapping: fine at gap 0, crowded at the min gap.
    const near = [a, box('c', 250, 50)]
    expect(overlappingIds(near)).toEqual([])
    expect(overlappingIds(near, MIN_GAP)).toEqual(['a', 'c'])
    // 30px apart: clear of the min gap.
    expect(overlappingIds([a, box('d', 270, 50)], MIN_GAP)).toEqual([])
  })

  it('counts terminal pills as parts of their node', () => {
    const owner: Obj = { id: 'a', x: 0, y: 0, parts: [{ dx: 0, dy: 0, w: 240, h: 100 }, { dx: 320, dy: 20, w: 160, h: 28 }] }
    // A node in the next column sits under the pill: a real overlap.
    expect(overlappingIds([owner, box('b', 360, 10)])).toEqual(['a', 'b'])
    expect(overlappingIds([owner, box('b', 360, 200)])).toEqual([])
  })
})

describe('fixOverlaps', () => {
  it('separates overlapping nodes, moves only one of them and leaves clear nodes alone', () => {
    const objs = [box('a', 0, 0), box('b', 40, 60), box('far', 1000, 0)]
    const { positions, remaining } = fixOverlaps(objs)
    expect(remaining).toBe(0)
    expect(Object.keys(positions)).toEqual(['b'])
    expect(overlappingIds(apply(objs, positions), MIN_GAP)).toEqual([])
    // Minimal movement: b only needs to clear a's bottom (100 + 24 gap) or its right side.
    expect(Math.hypot(positions.b.x - 40, positions.b.y - 60)).toBeLessThanOrEqual(170)
  })

  it('keeps the order of a crowded column and resolves it fully', () => {
    const column = Array.from({ length: 6 }, (_, i) => box(`n${i}`, 100, 120 + i * 30))
    const { positions, remaining } = fixOverlaps(column)
    expect(remaining).toBe(0)
    const out = apply(column, positions)
    expect(overlappingIds(out, MIN_GAP)).toEqual([])
    const ys = out.map((o) => o.y)
    expect([...ys].sort((p, q) => p - q)).toEqual(ys)
    for (const p of Object.values(positions)) {
      expect(p.x % 5).toBe(0)
      expect(p.y % 5).toBe(0)
    }
  })

  it('never moves objects outside the movable set', () => {
    const objs = [box('fixed', 0, 0), box('free', 40, 60)]
    const { positions } = fixOverlaps(objs, { movable: new Set(['free']) })
    expect(positions.fixed).toBeUndefined()
    expect(positions.free).toBeDefined()
    expect(overlappingIds(apply(objs, positions), MIN_GAP)).toEqual([])
  })

  it('returns nothing to write for a layout that is already clear', () => {
    expect(fixOverlaps([box('a', 0, 0), box('b', 400, 0)]).positions).toEqual({})
  })

  it('fixes a crowded 41-node flow with no overlap left, moving little', () => {
    const flow = denseFlow(41, 7)
    const doc = docOf(flow, (i) => ({ x: 100 + (i % 3) * 200, y: 120 + i * 40 }))
    expect(overlapsOf(doc)).not.toHaveLength(0)
    const { nodes, edges } = graphOf(doc)
    const { positions, remaining } = fixOverlaps(objectsOf(nodes, edges, sizesOf(nodes)))
    expect(remaining).toBe(0)
    const next = relayout(doc, positions)
    expect(overlappingIds(objectsOf(next.nodes, next.edges, sizesOf(next.nodes)), MIN_GAP)).toEqual([])
  })
})

describe('auto-arrange', () => {
  const flow = denseFlow(41, 11)
  const withLoose = {
    ...flow,
    nodes: [...flow.nodes, { id: 'loose', name: 'loose', onEnter: [], onReceive: null, next: [{ condition: 'true', node: '' }] }],
  } as unknown as FlowJson

  it('lays out a dense flow with no overlap, start node first, on the grid', async () => {
    const doc = docOf(withLoose, (i) => ({ x: 100 + (i % 3) * 200, y: 120 + i * 40 }))
    const { nodes, edges } = graphOf(doc)
    const pos = await tidyPositions(nodes, edges, 'arrange', null)
    expect(Object.keys(pos).length).toBeGreaterThan(0)
    for (const p of Object.values(pos)) {
      expect(p.x % 5).toBe(0)
      expect(p.y % 5).toBe(0)
    }
    const next = relayout(doc, pos)
    expect(overlappingIds(objectsOf(next.nodes, next.edges, sizesOf(next.nodes)), MIN_GAP)).toEqual([])

    const real = next.nodes.filter((n) => n.type !== 'terminal')
    const start = real.find((n) => n.id === 'id0')!
    expect(start.position.x).toBe(Math.min(...real.map((n) => n.position.x)))
    expect(real.filter((n) => n.position.x === start.position.x).every((n) => n.position.y >= start.position.y)).toBe(true)
  })

  it('places a disconnected node after the connected flow', async () => {
    const doc = docOf(withLoose)
    const { nodes, edges } = graphOf(doc)
    const pos = await tidyPositions(nodes, edges, 'arrange', null)
    const next = relayout(doc, pos)
    const sizes = sizesOf(next.nodes)
    const loose = next.nodes.find((n) => n.id === 'loose')!
    // Connected = reachable from the start node. The unreachable nodes form their own block below.
    const byName = new Map(doc.nodes.map((n) => [n.name, n.id]))
    const reach = new Set(['id0'])
    const queue = ['id0']
    for (const id of queue) {
      for (const t of doc.nodes.find((n) => n.id === id)!.next) {
        const target = byName.get(t.node)
        if (target !== undefined && !reach.has(target)) {
          reach.add(target)
          queue.push(target)
        }
      }
    }
    const connectedBottom = next.nodes
      .filter((n) => reach.has(n.id))
      .reduce((m, n) => Math.max(m, n.position.y + (sizes[n.id]?.h ?? 0)), -Infinity)
    expect(loose.position.y).toBeGreaterThan(connectedBottom)
  })

  it('is deterministic', async () => {
    const { nodes, edges } = graphOf(docOf(withLoose))
    const a = await tidyPositions(nodes, edges, 'arrange', null)
    const b = await tidyPositions(nodes, edges, 'arrange', null)
    expect(b).toEqual(a)
  })

  it('arranges only the selected subset and leaves the rest where they are', async () => {
    // A clean full arrangement, then four nodes pulled onto their neighbours.
    const full = graphOf(docOf(withLoose))
    const base = await tidyPositions(full.nodes, full.edges, 'arrange', null)
    const doc = moveNodes(docOf(withLoose), base)
    const subset = new Set(['id1', 'id2', 'id3', 'id4'])
    const at = new Map(graphOf(doc).nodes.map((n) => [n.id, n.position]))
    const pulled = Object.fromEntries([...subset].map((id) => [id, { x: at.get(id)!.x + 40, y: at.get(id)!.y + 30 }]))
    const pulledDoc = moveNodes(doc, pulled)
    const pulledGraph = graphOf(pulledDoc)
    const pos = await tidyPositions(pulledGraph.nodes, pulledGraph.edges, 'arrange', subset)
    expect(Object.keys(pos).length).toBeGreaterThan(0)
    for (const id of Object.keys(pos)) expect(subset.has(id)).toBe(true)
    const next = relayout(pulledDoc, pos)
    expect(overlappingIds(objectsOf(next.nodes, next.edges, sizesOf(next.nodes)), MIN_GAP)).toEqual([])
  })
})

describe('snap and file contents', () => {
  it('snaps to the 5-unit grid', () => {
    expect([snapNearest(0), snapNearest(2), snapNearest(3), snapNearest(-3), snapNearest(122.4)]).toEqual([0, 0, 5, -5, 120])
  })

  it('a tidy edit changes ui positions only, never the flow content', () => {
    const flow = denseFlow(12, 3)
    const doc = docFromFiles('main.flow.json', flow, undefined)
    const moved = moveNodes(doc, { id0: { x: 500, y: 300 }, id3: { x: 700, y: 40 } })
    expect(JSON.stringify(toFlowJson(moved))).toBe(JSON.stringify(toFlowJson(doc)))
    expect(toUiJson(moved).nodes.find((n) => n.id === 'id0')?.position).toEqual({ x: 500, y: 300 })
  })
})
