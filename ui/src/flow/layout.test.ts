import { describe, expect, it } from 'vitest'
import { HEAD_H, NODE_W, arrowPath, nodeHeight, orthogonalPath, transitionPortOffset } from './layout'

describe('transition ports', () => {
  it('places the first pill of the Transitions section below the header and the other sections', () => {
 // header 48 + On enter (1 + 10+16+32+12 = 71) + On receive empty row (1 + 71) + Transitions separator 1 + label block 10+16+6 = 32, pill centre +13
    const y = transitionPortOffset({ onEnter: 1, onReceive: 0, transitions: 2 }, 0)
    expect(y).toBe(HEAD_H + 71 + 71 + 1 + 10 + 16 + 6 + 13)
  })

  it('moves each following port down by one pill row', () => {
    const counts = { onEnter: 0, onReceive: 0, transitions: 3 }
    const step = transitionPortOffset(counts, 1) - transitionPortOffset(counts, 0)
    expect(step).toBe(32)
  })

  it('grows the On receive section by its rows (an empty section keeps one row)', () => {
    const empty = transitionPortOffset({ onEnter: 0, onReceive: 0, transitions: 1 }, 0)
    const two = transitionPortOffset({ onEnter: 0, onReceive: 2, transitions: 1 }, 0)
    expect(two - empty).toBe(32)
  })

  it('makes the node height end below the last transition pill', () => {
    const counts = { onEnter: 2, onReceive: 1, transitions: 3 }
    expect(nodeHeight(counts)).toBeGreaterThan(transitionPortOffset(counts, 2))
  })
})

describe('orthogonal edges', () => {
  it('draws a straight segment when source and target are level', () => {
    const { d } = orthogonalPath(100, 50, 400, 50)
    expect(d.startsWith('M100 50 L')).toBe(true)
    expect(d).not.toContain('Q')
  })

  it('routes through a vertical lane placed after the source with rounded corners', () => {
    const { midX, d } = orthogonalPath(100 + NODE_W, 50, 700, 200, 0)
    expect(midX).toBe(100 + NODE_W + 28)
    expect(d.match(/Q/g)?.length).toBe(2)
  })

  it('staggers the vertical lane per transition index so edges from one node do not overlap', () => {
    const a = orthogonalPath(340, 50, 700, 200, 0).midX
    const b = orthogonalPath(340, 50, 700, 220, 1).midX
    expect(b - a).toBe(18)
  })

  it('gives an arrow tip on the target handle', () => {
    expect(arrowPath(700, 200)).toMatch(/^M\d/)
  })
})
