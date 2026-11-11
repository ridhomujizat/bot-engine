import { describe, expect, it } from 'vitest'
import { flowTargetLabel, parseFlowTarget, resolveFlowTarget } from './navigation'

describe('parseFlowTarget', () => {
  it('reads a flow file and a flow file with a node', () => {
    expect(parseFlowTarget('produk.flow.json')).toEqual({ flow: 'produk.flow.json' })
    expect(parseFlowTarget('main.flow.json#menu')).toEqual({ flow: 'main.flow.json', node: 'menu' })
    expect(parseFlowTarget('skills/choice-abc.flow.json#entry')).toEqual({ flow: 'skills/choice-abc.flow.json', node: 'entry' })
  })

  it('has no fixed target for return, END, empty and a bare node name', () => {
    expect(parseFlowTarget('#')).toBeNull()
    expect(parseFlowTarget('END')).toBeNull()
    expect(parseFlowTarget('')).toBeNull()
    expect(parseFlowTarget('  ')).toBeNull()
    expect(parseFlowTarget('#menu')).toBeNull()
  })

  it('drops an empty node part', () => {
    expect(parseFlowTarget('main.flow.json#')).toEqual({ flow: 'main.flow.json' })
  })
})

describe('resolveFlowTarget', () => {
  const names = ['main.flow.json', 'produk.flow.json']
  it('resolves only flows the bot has', () => {
    expect(resolveFlowTarget('produk.flow.json', names)).toEqual({ flow: 'produk.flow.json' })
    expect(resolveFlowTarget('main.flow.json#menu', names)).toEqual({ flow: 'main.flow.json', node: 'menu' })
    expect(resolveFlowTarget('tagihan.flow.json', names)).toBeNull()
    expect(resolveFlowTarget('END', names)).toBeNull()
  })

  it('labels a target the way the pill shows it', () => {
    expect(flowTargetLabel({ flow: 'main.flow.json', node: 'menu' })).toBe('main.flow.json#menu')
    expect(flowTargetLabel({ flow: 'produk.flow.json' })).toBe('produk.flow.json')
  })
})
