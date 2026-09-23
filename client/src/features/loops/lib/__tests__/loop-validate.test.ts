import { describe, it, expect } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import { validateBuilderGraph, severityByNode } from '../loop-validate'
import type { LoopNodeData } from '../loop-graph-rf'

function n(id: string, kind: LoopNodeData['kind'], data: Partial<LoopNodeData> = {}): Node<LoopNodeData> {
  return { id, type: 'loop', position: { x: 0, y: 0 }, data: { kind, ...data } }
}
const codes = (nodes: Node<LoopNodeData>[], edges: Edge[]) => validateBuilderGraph(nodes, edges).map((i) => i.code)

describe('validateBuilderGraph', () => {
  it('flags missing/duplicate Start and missing End', () => {
    expect(codes([n('a', 'ai-step', { prompt: 'x' })], [])).toContain('NO_START')
    expect(codes([n('s', 'start'), n('e', 'end')], [{ id: 'x', source: 's', target: 'e' } as Edge])).not.toContain('NO_START')
    const dup = validateBuilderGraph([n('s1', 'start'), n('s2', 'start'), n('e', 'end')], [])
    expect(dup.find((i) => i.code === 'MULTIPLE_START')?.nodeId).toBe('s2')
    expect(codes([n('s', 'start')], [])).toContain('NO_END')
  })

  it('flags an orphan node unreachable from Start', () => {
    const nodes = [n('s', 'start'), n('a', 'ai-step', { prompt: 'x' }), n('e', 'end'), n('orphan', 'shell', { command: 'x' })]
    const edges = [{ id: 'e1', source: 's', target: 'a' }, { id: 'e2', source: 'a', target: 'e' }] as Edge[]
    const orphan = validateBuilderGraph(nodes, edges).find((i) => i.code === 'ORPHAN')
    expect(orphan?.nodeId).toBe('orphan')
  })

  it('errors when a Decider lacks a continue or stop branch', () => {
    const nodes = [n('s', 'start'), n('d', 'decider', { goal: 'g' }), n('e', 'end')]
    const onlyStop = [
      { id: 'a', source: 's', target: 'd' },
      { id: 'b', source: 'd', target: 'e', sourceHandle: 'stop' },
    ] as Edge[]
    expect(codes(nodes, onlyStop)).toContain('DECIDER_BRANCHES')
    const both = [...onlyStop, { id: 'c', source: 'd', target: 's', sourceHandle: 'continue' } as Edge]
    expect(validateBuilderGraph(nodes, both).filter((i) => i.code === 'DECIDER_BRANCHES')).toHaveLength(0)
  })

  it('warns on empty prompt/command/goal and dead-ends', () => {
    const c = codes([n('s', 'start'), n('ai', 'ai-step', { prompt: '' }), n('sh', 'shell', { command: '' }), n('d', 'decider', { goal: '' })], [])
    expect(c).toContain('EMPTY_PROMPT')
    expect(c).toContain('EMPTY_COMMAND')
    expect(c).toContain('EMPTY_GOAL')
    expect(c).toContain('DEAD_END') // the ai/shell/start with no outgoing edge
  })

  it('severityByNode keeps the worst severity per node', () => {
    const issues = [
      { severity: 'warning' as const, code: 'EMPTY_GOAL' as const, nodeId: 'd' },
      { severity: 'error' as const, code: 'DECIDER_BRANCHES' as const, nodeId: 'd' },
    ]
    expect(severityByNode(issues).get('d')).toBe('error')
  })
})
