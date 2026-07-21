import { describe, it, expect } from 'vitest'
import {
  validateLoopGraph,
  emptyLoopGraph,
  nodesById,
  findStartNode,
  successors,
  interpolateSpec,
  loopNeedsTicket,
  type LoopGraph,
  type LoopNode,
  type LoopEdge,
} from './loop-graph'

function graphWith(data: Record<string, unknown>): LoopGraph {
  return { nodes: [{ id: 'ai', type: 'ai-step', position: { x: 0, y: 0 }, data }], edges: [], config: { maxIterations: 5, timeoutMinutes: 10 } }
}

describe('loopNeedsTicket', () => {
  it('true when a node references a {{spec.*}} token', () => {
    expect(loopNeedsTicket(graphWith({ prompt: 'Implement {{spec.title}}' }))).toBe(true)
    expect(loopNeedsTicket(graphWith({ goal: 'covers {{spec.ids}}' }))).toBe(true)
  })

  it('true when a node references a ticket command (implement/batch/freestyle)', () => {
    expect(loopNeedsTicket(graphWith({ prompt: '{{cmd:implement}}' }))).toBe(true)
    expect(loopNeedsTicket(graphWith({ prompt: '{{cmd:batch}}' }))).toBe(true)
    expect(loopNeedsTicket(graphWith({ prompt: '{{cmd:freestyle}}' }))).toBe(true)
  })

  it('false for standalone loops (no spec token, no ticket command)', () => {
    expect(loopNeedsTicket(graphWith({ prompt: 'Lint the whole repo until clean' }))).toBe(false)
    // non-ticket commands do NOT count as needing a spec
    expect(loopNeedsTicket(graphWith({ prompt: '{{cmd:test}} {{cmd:lint}}' }))).toBe(false)
  })

  it('false for an undefined graph', () => {
    expect(loopNeedsTicket(undefined)).toBe(false)
  })
})

// ── Builders ───────────────────────────────────────────────────────────────
function node(id: string, type: LoopNode['type']): LoopNode {
  return { id, type, position: { x: 0, y: 0 } }
}
function edge(id: string, source: string, target: string): LoopEdge {
  return { id, source, target }
}
function graph(nodes: LoopNode[], edges: LoopEdge[], config?: Partial<LoopGraph['config']>): LoopGraph {
  return { nodes, edges, config: { maxIterations: 10, timeoutMinutes: 30, ...config } }
}

/** A canonical valid loop: Start → AI → Shell → Decider →(cycle back to AI) + Decider → End. */
function validLoopGraph(): LoopGraph {
  return graph(
    [
      node('s', 'start'),
      node('ai', 'ai-step'),
      node('sh', 'shell'),
      node('d', 'decider'),
      node('e', 'end'),
    ],
    [
      edge('e1', 's', 'ai'),
      edge('e2', 'ai', 'sh'),
      edge('e3', 'sh', 'd'),
      edge('e4', 'd', 'ai'), // cycle back (continue)
      edge('e5', 'd', 'e'), // stop
    ]
  )
}

describe('emptyLoopGraph', () => {
  it('returns a structurally empty graph with sane default config', () => {
    const g = emptyLoopGraph()
    expect(g.nodes).toEqual([])
    expect(g.edges).toEqual([])
    expect(g.config.maxIterations).toBeGreaterThanOrEqual(1)
    expect(g.config.timeoutMinutes).toBeGreaterThanOrEqual(1)
  })
})

describe('validateLoopGraph', () => {
  it('accepts a canonical loop with a cycle back to an earlier node', () => {
    const result = validateLoopGraph(validLoopGraph())
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('accepts a simple linear pipeline (Start → AI → End, no cycle)', () => {
    const g = graph(
      [node('s', 'start'), node('ai', 'ai-step'), node('e', 'end')],
      [edge('e1', 's', 'ai'), edge('e2', 'ai', 'e')]
    )
    expect(validateLoopGraph(g).valid).toBe(true)
  })

  it('flags NO_START when there is no start node', () => {
    const g = graph([node('ai', 'ai-step'), node('e', 'end')], [edge('e1', 'ai', 'e')])
    const result = validateLoopGraph(g)
    expect(result.valid).toBe(false)
    expect(result.errors.map((e) => e.code)).toContain('NO_START')
  })

  it('flags MULTIPLE_START (one error per extra start) and points at the offender', () => {
    const g = graph(
      [node('s1', 'start'), node('s2', 'start'), node('e', 'end')],
      [edge('e1', 's1', 'e'), edge('e2', 's2', 'e')]
    )
    const result = validateLoopGraph(g)
    expect(result.valid).toBe(false)
    const multi = result.errors.filter((e) => e.code === 'MULTIPLE_START')
    expect(multi).toHaveLength(1)
    expect(multi[0].nodeId).toBe('s2')
  })

  it('flags NO_END when there is no end node', () => {
    const g = graph([node('s', 'start'), node('ai', 'ai-step')], [edge('e1', 's', 'ai')])
    expect(validateLoopGraph(g).errors.map((e) => e.code)).toContain('NO_END')
  })

  it('flags ORPHAN_NODE for a node not reachable from Start', () => {
    const g = graph(
      [node('s', 'start'), node('e', 'end'), node('lonely', 'ai-step')],
      [edge('e1', 's', 'e')] // 'lonely' has no connection
    )
    const result = validateLoopGraph(g)
    expect(result.valid).toBe(false)
    const orphans = result.errors.filter((e) => e.code === 'ORPHAN_NODE')
    expect(orphans).toHaveLength(1)
    expect(orphans[0].nodeId).toBe('lonely')
  })

  it('flags an unreachable subgraph (connected to each other but not to Start)', () => {
    const g = graph(
      [node('s', 'start'), node('e', 'end'), node('a', 'ai-step'), node('b', 'shell')],
      [edge('e1', 's', 'e'), edge('e2', 'a', 'b')] // a→b island
    )
    const orphanIds = validateLoopGraph(g)
      .errors.filter((e) => e.code === 'ORPHAN_NODE')
      .map((e) => e.nodeId)
      .sort()
    expect(orphanIds).toEqual(['a', 'b'])
  })

  it('flags DANGLING_EDGE when an edge references a missing node', () => {
    const g = graph(
      [node('s', 'start'), node('e', 'end')],
      [edge('e1', 's', 'e'), edge('bad', 's', 'ghost')]
    )
    const result = validateLoopGraph(g)
    const dangling = result.errors.filter((e) => e.code === 'DANGLING_EDGE')
    expect(dangling).toHaveLength(1)
    expect(dangling[0].edgeId).toBe('bad')
  })

  it('flags INVALID_CONFIG for non-positive maxIterations', () => {
    const g = graph(
      [node('s', 'start'), node('e', 'end')],
      [edge('e1', 's', 'e')],
      { maxIterations: 0 }
    )
    expect(validateLoopGraph(g).errors.map((e) => e.code)).toContain('INVALID_CONFIG')
  })

  it('flags INVALID_CONFIG for a negative timeout', () => {
    const g = graph(
      [node('s', 'start'), node('e', 'end')],
      [edge('e1', 's', 'e')],
      { timeoutMinutes: -1 }
    )
    expect(validateLoopGraph(g).errors.map((e) => e.code)).toContain('INVALID_CONFIG')
  })

  it('accepts timeoutMinutes 0 (no timeout — the factory-loop untimed sentinel)', () => {
    const g = graph(
      [node('s', 'start'), node('e', 'end')],
      [edge('e1', 's', 'e')],
      { timeoutMinutes: 0 }
    )
    expect(validateLoopGraph(g).valid).toBe(true)
  })

  it('reports multiple distinct problems at once (empty graph)', () => {
    const result = validateLoopGraph(emptyLoopGraph())
    const codes = result.errors.map((e) => e.code)
    expect(result.valid).toBe(false)
    expect(codes).toContain('NO_START')
    expect(codes).toContain('NO_END')
  })

  it('does not run reachability when start cardinality is wrong (no ORPHAN noise)', () => {
    const g = graph([node('ai', 'ai-step'), node('e', 'end')], [])
    const codes = validateLoopGraph(g).errors.map((e) => e.code)
    expect(codes).toContain('NO_START')
    expect(codes).not.toContain('ORPHAN_NODE')
  })
})

describe('traversal helpers', () => {
  it('findStartNode + nodesById', () => {
    const g = validLoopGraph()
    expect(findStartNode(g)?.id).toBe('s')
    expect(nodesById(g).get('ai')?.type).toBe('ai-step')
    expect(findStartNode(graph([node('e', 'end')], []))).toBeUndefined()
  })

  it('successors returns the targets of a node in edge order', () => {
    const g = validLoopGraph() // decider 'd' → 'ai' (continue) then 'e' (stop)
    expect(successors(g, 'd').map((n) => n.id)).toEqual(['ai', 'e'])
    expect(successors(g, 'e')).toEqual([])
  })
})

describe('interpolateSpec', () => {
  it('replaces spec.title and spec.description', () => {
    const out = interpolateSpec('Do {{spec.title}}:\n{{spec.description}}', { title: 'X', description: 'desc' })
    expect(out).toBe('Do X:\ndesc')
  })

  it('tolerates whitespace inside the token', () => {
    expect(interpolateSpec('{{ spec.title }}', { title: 'Y' })).toBe('Y')
  })

  it('collapses unknown tokens and missing fields to empty (never leaks the token)', () => {
    expect(interpolateSpec('a {{spec.bogus}} b', { title: 'T' })).toBe('a  b')
    expect(interpolateSpec('t={{spec.title}}', undefined)).toBe('t=')
  })

  it('resolves whitelisted spec fields', () => {
    expect(interpolateSpec('#{{spec.id}}', { id: 42 })).toBe('#42')
    expect(interpolateSpec('s={{spec.status}} p={{spec.priority}}', { status: 'todo', priority: 'high' })).toBe('s=todo p=high')
  })

  it('resolves whitelisted OpenSpec change names from direct field or metadata', () => {
    expect(interpolateSpec('{{spec.openspecChangeName}}', { openspecChangeName: ' add-sdd-quick-openspec ' })).toBe('add-sdd-quick-openspec')
    expect(interpolateSpec('{{spec.openspecChangeName}}', { metadata: { openspecChangeName: 'continue-this-change' } })).toBe('continue-this-change')
  })

  it('does not expose arbitrary metadata fields', () => {
    const spec = { metadata: { openspecChangeName: 'ok', secret: 'nope' }, secret: 'hidden' } as unknown as Parameters<typeof interpolateSpec>[1]
    expect(interpolateSpec('{{spec.metadata}}/{{spec.secret}}', spec)).toBe('/')
  })

  it('joins array fields (labels) with ", "', () => {
    expect(interpolateSpec('{{spec.labels}}', { labels: ['ui', 'bug'] })).toBe('ui, bug')
  })

  it('treats null fields as empty', () => {
    expect(interpolateSpec('[{{spec.priority}}]', { priority: null })).toBe('[]')
  })

  it('resolves {{spec.ids}} to all rail ticket ids as #a #b #c', () => {
    expect(interpolateSpec('{{spec.ids}}', { ticketIds: [1, 2, 3] })).toBe('#1 #2 #3')
  })

  it('{{spec.ids}} falls back to the single id, or empty', () => {
    expect(interpolateSpec('{{spec.ids}}', { id: 9 })).toBe('#9')
    expect(interpolateSpec('{{spec.ids}}', {})).toBe('')
  })
})
