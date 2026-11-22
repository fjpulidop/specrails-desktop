import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { render, screen } from '../../../../../test-utils'
import { RuntimeGraphExplorer } from '../RuntimeGraphExplorer'
import type { RuntimeTopology } from '../runtime-topology'
import type { LoopStepSegment } from '../loop-log-model'

vi.mock('@xyflow/react', () => ({
  MarkerType: { ArrowClosed: 'arrowclosed' }, Background: () => null, Controls: () => null, BaseEdge: () => null, EdgeLabelRenderer: () => null,
  getSmoothStepPath: () => ['', 0, 0],
  ReactFlow: ({ nodes, edges }: { nodes: Array<{ id: string; data: { label: ReactNode } }>; edges: Array<{ id: string; label?: string; type?: string; data?: { lane?: number } }> }) => <div>
    {nodes.map(node => <div key={node.id} data-testid={`node-${node.id}`}>{node.data.label}</div>)}
    {edges.map(edge => <span key={edge.id} data-testid={`edge-${edge.id}`} data-type={edge.type} data-lane={edge.data?.lane ?? ''}>{edge.label ?? ''}</span>)}
  </div>,
}))

const topology: RuntimeTopology = { entry: 'plan', components: {}, nodes: [
  { id: 'plan', kind: 'set', label: 'Plan', ends: { next: 'architect' } },
  { id: 'architect', kind: 'ai-step', label: 'Architect', ends: { next: 'done', failed: 'stop', 'custom-way': 'done' } },
  { id: 'done', kind: 'end', label: 'Done', ends: {} },
  { id: 'stop', kind: 'end', label: 'Stopped', ends: {} },
] }
const step = (id: string, index: number, status: 'ok' | 'failed'): LoopStepSegment => ({ key: id, lastActivity: null, lines: [],
  meta: { index, kind: 'core', title: id, nodeId: id, nodePath: id, scopeId: 'root', attemptId: `${id}-1`, attempt: 1, iteration: 1 },
  end: { index, nodeId: id, status, exitCode: null, durationMs: 1000 } } as LoopStepSegment)

it('a held run reads its stopped step as the hold (a usage limit), never as a failure', () => {
  render(<RuntimeGraphExplorer topology={topology} segments={[step('plan', 1, 'ok'), step('architect', 2, 'failed')]} settled hold={{ state: 'blocked', label: 'Usage limit' }} onFocus={vi.fn()} />)
  expect(screen.getByTestId('node-architect')).toHaveTextContent('Usage limit')
  expect(screen.getByTestId('node-architect')).not.toHaveTextContent('Failed')
  expect(screen.getByTestId('node-architect').querySelector('[data-state="held"]')).not.toBeNull()
})

it('without a hold the same step stays failed', () => {
  render(<RuntimeGraphExplorer topology={topology} segments={[step('plan', 1, 'ok'), step('architect', 2, 'failed')]} settled onFocus={vi.fn()} />)
  expect(screen.getByTestId('node-architect')).toHaveTextContent('Failed')
})

it('names only the ways out of a branch, in the person\'s language, through the label-aware edge', () => {
  render(<RuntimeGraphExplorer topology={topology} segments={[]} settled={false} onFocus={vi.fn()} />)
  // A single way out needs no label.
  expect(screen.getByTestId('edge-plan:next')).toHaveTextContent('')
  expect(screen.getByTestId('edge-architect:next')).toHaveTextContent('Next')
  expect(screen.getByTestId('edge-architect:failed')).toHaveTextContent('Failed')
  // An outcome without a translation reads as words, never as a raw id.
  expect(screen.getByTestId('edge-architect:custom-way')).toHaveTextContent('custom way')
  expect(screen.getByTestId('edge-architect:next')).toHaveAttribute('data-type', 'runtime')
})
