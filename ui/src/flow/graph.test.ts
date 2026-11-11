import { describe, expect, it } from 'vitest'
import type { FlowJson, UiJson } from '@/api/types'
import { docFromFiles } from './model'
import { terminalId, toGraph } from './graph'
import { NODE_W, TERMINAL_OFFSET, transitionPortOffset } from './layout'

const flow: FlowJson = {
  startNode: 'entry',
  nodes: [
    { id: 'entry', name: 'entry', onEnter: ['say #!t1'], next: [{ condition: 'true', node: 'menu-utama' }] },
    {
      id: 'skill-4cd383',
      type: 'skill-call',
      skill: 'choice',
      name: 'menu-utama',
      next: [
        { condition: 'a', node: 'informasi' },
        { condition: 'otherwise', node: '#' },
        { condition: 'b', node: 'handover.flow.json#entry' },
      ],
    },
    { id: 'informasi', name: 'informasi', next: [{ condition: 'true', node: 'END' }] },
  ],
}
const ui: UiJson = {
  nodes: [
    { id: 'entry', position: { x: 100, y: 186 } },
    { id: 'skill-4cd383', position: { x: 400, y: 150 } },
    { id: 'informasi', position: { x: 760, y: 20 } },
  ],
  links: [],
}

describe('toGraph', () => {
  const { nodes, edges } = toGraph({
    doc: docFromFiles('main.flow.json', flow, ui),
    contentLabels: {},
    runPath: new Set(['entry', 'skill-4cd383']),
  })

  it('creates one React Flow node per flow node, using the skill type for skill-call nodes', () => {
    expect(nodes.find((n) => n.id === 'entry')?.type).toBe('standard')
    expect(nodes.find((n) => n.id === 'skill-4cd383')?.type).toBe('skill')
    expect(nodes.find((n) => n.id === 'entry')?.data.isStart).toBe(true)
  })

  it('maps each transition to an edge whose source handle is its port', () => {
    const fromSkill = edges.filter((e) => e.source === 'skill-4cd383')
    expect(fromSkill.map((e) => e.sourceHandle)).toEqual(['t0', 't1', 't2'])
    expect(edges.find((e) => e.source === 'entry')?.target).toBe('skill-4cd383')
  })

  it('draws transitions to nodes as edges and everything else as a terminal chip', () => {
    const terminals = nodes.filter((n) => n.type === 'terminal')
    expect(terminals.map((n) => n.id).sort()).toEqual(
      [terminalId('skill-4cd383', 1), terminalId('skill-4cd383', 2), terminalId('informasi', 0)].sort(),
    )
    expect(terminals.find((n) => n.id === terminalId('skill-4cd383', 1))?.data).toMatchObject({ label: 'Return', icon: 'return' })
    expect(terminals.find((n) => n.id === terminalId('skill-4cd383', 2))?.data).toMatchObject({
      label: 'handover.flow.json#entry',
    })
  });

  it('places terminal chips level with their pill, to the right of the node', () => {
    const counts = { onEnter: 0, onReceive: 0, transitions: 3 }
    const chip = nodes.find((n) => n.id === terminalId('skill-4cd383', 1))!
    const portY = 150 + transitionPortOffset(counts, 1)
    expect(chip.position.x).toBe(400 + NODE_W + TERMINAL_OFFSET)
    expect(chip.position.y + 14).toBe(portY)
  })

  it('marks edges between two nodes on the run path as run edges', () => {
    expect(edges.find((e) => e.source === 'entry')?.data?.onRun).toBe(true)
    expect(edges.find((e) => e.source === 'skill-4cd383' && e.sourceHandle === 't0')?.data?.onRun).toBe(false)
  })
})
