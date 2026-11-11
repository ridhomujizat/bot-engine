import { describe, expect, it } from 'vitest'
import { DEFAULT_EDGE_STYLE, EDGE_STYLE_KEY, parseEdgeStyle, readEdgeStyle, writeEdgeStyle } from './edgeStyle'
import { straightRoute } from './layout'

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial))
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
  } as Storage
}

describe('edge style persistence', () => {
  it('defaults to orthogonal when nothing is saved', () => {
    expect(DEFAULT_EDGE_STYLE).toBe('orthogonal')
    expect(readEdgeStyle(memoryStorage())).toBe('orthogonal')
  })

  it('remembers the choice per browser', () => {
    const storage = memoryStorage()
    writeEdgeStyle('straight', storage)
    expect(storage.getItem(EDGE_STYLE_KEY)).toBe('straight')
    expect(readEdgeStyle(storage)).toBe('straight')
    writeEdgeStyle('orthogonal', storage)
    expect(readEdgeStyle(storage)).toBe('orthogonal')
  })

  it('treats unknown stored values as the default', () => {
    expect(readEdgeStyle(memoryStorage({ [EDGE_STYLE_KEY]: 'curvy' }))).toBe('orthogonal')
    expect(parseEdgeStyle(null)).toBe('orthogonal')
  })

  it('does not throw when storage is unavailable or refuses writes', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      },
    } as unknown as Storage
    expect(readEdgeStyle(broken)).toBe('orthogonal')
    expect(() => writeEdgeStyle('straight', broken)).not.toThrow()
    expect(() => writeEdgeStyle('straight', null)).not.toThrow()
    expect(readEdgeStyle(null)).toBe('orthogonal')
  })
})

describe('straightRoute', () => {
  it('draws one line from source port to the arrow base, arrow tip on the target', () => {
    const r = straightRoute(100, 50, 400, 250)
    expect(r.d.startsWith('M100 50 L')).toBe(true)
    expect(r.d).not.toMatch(/NaN|Infinity/)
    expect(r.arrow).not.toMatch(/NaN|Infinity/)
    expect(r.arrow).toContain('L399') // tip one pixel before the target port along the direction
    expect(r.midX).toBe(250)
    expect(r.midY).toBe(150)
  })

  it('is a single segment: no corners, no quadratic curves', () => {
    const r = straightRoute(340, 300, 120, 40) // backward edge: still straight, like legacy
    expect(r.d.match(/[LQMC]/g)?.length).toBe(2)
    expect(r.d).not.toContain('Q')
  })

  it('handles zero length without NaN', () => {
    const r = straightRoute(10, 10, 10, 10)
    expect(r.d).not.toMatch(/NaN/)
    expect(r.arrow).toBe('')
  })
})
