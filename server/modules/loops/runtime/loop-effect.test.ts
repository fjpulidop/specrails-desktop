import { describe, it, expect } from 'vitest'
import { classifyLoopEffect, loopIsMutating } from './loop-effect'
import type { LoopGraph, LoopNodeType } from './loop-graph'

function graph(types: LoopNodeType[]): LoopGraph {
  return {
    nodes: types.map((type, i) => ({ id: `n${i}`, type, position: { x: 0, y: 0 } })),
    edges: [],
    config: { maxIterations: 10, timeoutMinutes: 30 },
  }
}

describe('classifyLoopEffect', () => {
  it('is mutating when any ai-step is present', () => {
    expect(classifyLoopEffect(graph(['start', 'ai-step', 'decider', 'end']))).toBe('mutating')
    expect(loopIsMutating(graph(['start', 'ai-step', 'end']))).toBe(true)
  })

  it('is mutating when any shell node is present', () => {
    expect(classifyLoopEffect(graph(['start', 'shell', 'end']))).toBe('mutating')
  })

  it('is read-only when no ai-step and no shell node', () => {
    expect(classifyLoopEffect(graph(['start', 'decider', 'condition', 'end']))).toBe('read-only')
    expect(loopIsMutating(graph(['start', 'end']))).toBe(false)
  })

  it('is read-only for an empty node list', () => {
    expect(classifyLoopEffect(graph([]))).toBe('read-only')
  })
})
