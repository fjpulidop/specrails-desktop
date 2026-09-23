import { describe, it, expect } from 'vitest'
import {
  defaultNodeData,
  makeNode,
  graphToReactFlow,
  reactFlowToGraph,
} from '../loop-graph-rf'
import type { LoopGraph } from '../loops-api'

function graph(): LoopGraph {
  return {
    nodes: [
      { id: 's', type: 'start', position: { x: 0, y: 0 } },
      { id: 'ai', type: 'ai-step', position: { x: 0, y: 100 }, data: { prompt: 'do it', model: 'sonnet' } },
      { id: 'e', type: 'end', position: { x: 0, y: 200 }, data: { outcome: 'success' } },
    ],
    edges: [
      { id: 'e1', source: 's', target: 'ai' },
      { id: 'e2', source: 'ai', target: 'e', join: 'AND' },
    ],
    config: { maxIterations: 7, timeoutMinutes: 25 },
  }
}

describe('defaultNodeData', () => {
  it('seeds kind-specific defaults', () => {
    expect(defaultNodeData('ai-step')).toMatchObject({ kind: 'ai-step', prompt: '', effort: 'medium' })
    expect(defaultNodeData('shell')).toMatchObject({ kind: 'shell', command: '' })
    expect(defaultNodeData('decider')).toMatchObject({ kind: 'decider', goal: '' })
    expect(defaultNodeData('end')).toMatchObject({ kind: 'end', outcome: 'success' })
    expect(defaultNodeData('start')).toEqual({ kind: 'start' })
  })
})

describe('makeNode', () => {
  it('creates a React Flow node with a unique id and the loop type', () => {
    const a = makeNode('shell', { x: 10, y: 20 })
    const b = makeNode('shell', { x: 10, y: 20 })
    expect(a.type).toBe('loop')
    expect(a.data.kind).toBe('shell')
    expect(a.position).toEqual({ x: 10, y: 20 })
    expect(a.id).not.toBe(b.id)
  })
})

describe('graph ⇄ react-flow round-trip', () => {
  it('graphToReactFlow maps node.type → data.kind and keeps positions/config-free', () => {
    const { nodes, edges } = graphToReactFlow(graph())
    expect(nodes.every((n) => n.type === 'loop')).toBe(true)
    expect(nodes.find((n) => n.id === 'ai')!.data).toMatchObject({ kind: 'ai-step', prompt: 'do it', model: 'sonnet' })
    expect(edges.find((e) => e.id === 'e2')!.data).toEqual({ join: 'AND' })
  })

  it('reactFlowToGraph is the inverse (round-trips the graph)', () => {
    const { nodes, edges } = graphToReactFlow(graph())
    const back = reactFlowToGraph(nodes, edges, { maxIterations: 7, timeoutMinutes: 25 })
    expect(back).toEqual(graph())
  })

  it('drops the kind key out of node.data on the way back', () => {
    const { nodes, edges } = graphToReactFlow(graph())
    const back = reactFlowToGraph(nodes, edges, { maxIterations: 1, timeoutMinutes: 1 })
    const start = back.nodes.find((n) => n.id === 's')!
    expect(start.data).toBeUndefined() // start had no data → stays clean
    const ai = back.nodes.find((n) => n.id === 'ai')!
    expect(ai.data).not.toHaveProperty('kind')
  })

  it('passes the optional cost cap (config.maxCostUsd) straight through on save', () => {
    const back = reactFlowToGraph([], [], { maxIterations: 1, timeoutMinutes: 1, maxCostUsd: 2.5 })
    expect(back.config.maxCostUsd).toBe(2.5)
    // omitted → stays undefined (no cap)
    expect(reactFlowToGraph([], [], { maxIterations: 1, timeoutMinutes: 1 }).config.maxCostUsd).toBeUndefined()
  })

  it('maps a Decider edge.branch ↔ React Flow sourceHandle (round-trip)', () => {
    const g: LoopGraph = {
      nodes: [
        { id: 'd', type: 'decider', position: { x: 0, y: 0 }, data: { goal: 'g' } },
        { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 } },
        { id: 'e', type: 'end', position: { x: 1, y: 1 } },
      ],
      edges: [
        { id: 'ec', source: 'd', target: 'ai', branch: 'continue' },
        { id: 'es', source: 'd', target: 'e', branch: 'stop' },
      ],
      config: { maxIterations: 5, timeoutMinutes: 10 },
    }
    const { edges } = graphToReactFlow(g)
    // branch becomes the React Flow sourceHandle (so the edge attaches to the
    // correct named Decider handle) and is colour-coded.
    expect(edges.find((e) => e.id === 'ec')!.sourceHandle).toBe('continue')
    expect(edges.find((e) => e.id === 'es')!.sourceHandle).toBe('stop')
    // Colour must reference the REAL Tailwind v4 theme var (`--color-accent-*`),
    // not `--accent-*` — the latter doesn't resolve and the edge renders colourless.
    expect((edges.find((e) => e.id === 'es')!.style as { stroke?: string }).stroke).toBe('var(--color-accent-success)')
    expect((edges.find((e) => e.id === 'ec')!.style as { stroke?: string }).stroke).toBe('var(--color-accent-highlight)')
    // round-trip preserves branch
    const back = reactFlowToGraph(graphToReactFlow(g).nodes, edges, g.config)
    expect(back.edges.find((e) => e.id === 'ec')!.branch).toBe('continue')
    expect(back.edges.find((e) => e.id === 'es')!.branch).toBe('stop')
  })

  it('infers the Decider sourceHandle for legacy edges with no branch (so they still attach)', () => {
    // A Decider renders ONLY named source handles; an edge with no sourceHandle
    // would float off the node. graphToReactFlow back-fills: edge→End = stop,
    // otherwise = continue.
    const g: LoopGraph = {
      nodes: [
        { id: 'd', type: 'decider', position: { x: 0, y: 0 }, data: { goal: 'g' } },
        { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 } },
        { id: 'e', type: 'end', position: { x: 0, y: 2 } },
      ],
      edges: [
        { id: 'a', source: 'd', target: 'ai' }, // no branch → continue (non-end target)
        { id: 'b', source: 'd', target: 'e' },   // no branch → stop (End target)
      ],
      config: { maxIterations: 1, timeoutMinutes: 1 },
    }
    const { edges } = graphToReactFlow(g)
    expect(edges.find((e) => e.id === 'a')!.sourceHandle).toBe('continue')
    expect(edges.find((e) => e.id === 'b')!.sourceHandle).toBe('stop')
  })

  it('reads branch from a connection drawn from a handle (sourceHandle only, no data)', () => {
    // Simulates a freshly drawn edge: React Flow puts the handle id on
    // sourceHandle; reactFlowToGraph must persist it as branch.
    const back = reactFlowToGraph(
      [{ id: 'd', type: 'loop', position: { x: 0, y: 0 }, data: { kind: 'decider' } }],
      [{ id: 'x', source: 'd', target: 'ai', sourceHandle: 'stop' }],
      { maxIterations: 1, timeoutMinutes: 1 }
    )
    expect(back.edges[0].branch).toBe('stop')
  })
})
