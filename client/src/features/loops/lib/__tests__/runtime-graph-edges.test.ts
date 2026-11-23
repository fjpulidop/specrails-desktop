import { describe, expect, it } from 'vitest'
import { edgeLabelLanes, outcomeLabelKey } from '../runtime-graph-edges'

describe('runtime graph edge labels', () => {
  it('maps known Core outcome ids to translation keys and leaves unknown ones alone', () => {
    expect(outcomeLabelKey('next')).toBe('loopExplorer.graphOutcome.next')
    expect(outcomeLabelKey('true')).toBe('loopExplorer.graphOutcome.true')
    expect(outcomeLabelKey('my-own-way')).toBeNull()
  })

  it('staggers labels that share a gap and keeps far-apart ones on the first lane', () => {
    const nodes = [
      { id: 'a', position: { x: 0, y: 0 } }, { id: 'b', position: { x: 0, y: 150 } },
      { id: 'c', position: { x: 40, y: 150 } }, { id: 'd', position: { x: 600, y: 150 } },
    ]
    const edges = [
      { id: 'a:1', source: 'a', target: 'b', label: 'One' },
      { id: 'a:2', source: 'a', target: 'c', label: 'Two' },
      { id: 'a:3', source: 'a', target: 'd', label: 'Three' },
      { id: 'a:4', source: 'a', target: 'd' },
    ]
    const lanes = edgeLabelLanes(edges, nodes, 200).map((edge) => (edge.data as { lane?: number } | undefined)?.lane)
    expect(lanes).toEqual([0, 1, 0, undefined])
  })
})
