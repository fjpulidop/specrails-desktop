import { describe, it, expect } from 'vitest'
import type { Node } from '@xyflow/react'
import { layoutLoop } from '../loop-layout'
import type { LoopNodeData } from '../loop-graph-rf'

function n(id: string, kind: LoopNodeData['kind'], x = 0, y = 0): Node<LoopNodeData> {
  return { id, type: 'loop', position: { x, y }, data: { kind } }
}

// start → a → decide →(stop) done ; decide →(continue) fix → a  (loop-back)
const nodes = [n('s', 'start'), n('a', 'ai-step'), n('d', 'decider'), n('fix', 'ai-step'), n('done', 'end')]
const edges = [
  { source: 's', target: 'a' },
  { source: 'a', target: 'd' },
  { source: 'd', target: 'fix' },
  { source: 'fix', target: 'a' }, // back-edge (ignored by ranking)
  { source: 'd', target: 'done' },
]
const pos = (out: Node<LoopNodeData>[], id: string) => out.find((x) => x.id === id)!.position

describe('layoutLoop', () => {
  it('vertical: ranks top→bottom from Start; same-rank siblings share y', () => {
    const out = layoutLoop(nodes, edges, 'vertical')
    // BFS ranks: s=0, a=1, d=2, fix=3, done=3.
    expect(pos(out, 's').y).toBeLessThan(pos(out, 'a').y)
    expect(pos(out, 'a').y).toBeLessThan(pos(out, 'd').y)
    expect(pos(out, 'd').y).toBeLessThan(pos(out, 'fix').y)
    // fix & done share the deepest rank → same y, different x.
    expect(pos(out, 'fix').y).toBe(pos(out, 'done').y)
    expect(pos(out, 'fix').x).not.toBe(pos(out, 'done').x)
  })

  it('horizontal: ranks left→right; same-rank siblings share x', () => {
    const out = layoutLoop(nodes, edges, 'horizontal')
    expect(pos(out, 's').x).toBeLessThan(pos(out, 'a').x)
    expect(pos(out, 'a').x).toBeLessThan(pos(out, 'd').x)
    expect(pos(out, 'fix').x).toBe(pos(out, 'done').x)
    expect(pos(out, 'fix').y).not.toBe(pos(out, 'done').y)
  })

  it('grid: snaps current positions to the 20px grid, preserving relative layout', () => {
    const messy = [n('a', 'ai-step', 37, 92), n('b', 'shell', 211, 5)]
    const out = layoutLoop(messy, [], 'grid')
    expect(pos(out, 'a')).toEqual({ x: 40, y: 100 })
    expect(pos(out, 'b')).toEqual({ x: 220, y: 0 })
  })

  it('preserves node identity + order (keys stable for React Flow)', () => {
    const out = layoutLoop(nodes, edges, 'vertical')
    expect(out.map((x) => x.id)).toEqual(nodes.map((x) => x.id))
  })
})
