import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, fireEvent } from '../../../../../test-utils'
import { RuntimeGraphExplorer } from '../RuntimeGraphExplorer'
import type { RuntimeTopology } from '../runtime-topology'
import type { LoopStepSegment } from '../loop-log-model'

vi.mock('@xyflow/react', () => ({
  MarkerType: { ArrowClosed: 'arrowclosed' }, Background: () => null, Controls: () => null,
  ReactFlow: ({ nodes, edges, onNodeClick, nodesDraggable, nodesConnectable }: { nodes: Array<{ id: string; data: { label: ReactNode } }>; edges: Array<{ id: string; source: string; target: string }>; onNodeClick(event: unknown, node: { id: string }): void; nodesDraggable: boolean; nodesConnectable: boolean }) => <div data-testid="flow" data-draggable={nodesDraggable} data-connectable={nodesConnectable}>
    {nodes.map(node => <button key={node.id} data-testid={`node-${node.id}`} onClick={() => onNodeClick(null, node)}>{node.data.label}</button>)}
    {edges.map(edge => <span key={edge.id}>{edge.source} → {edge.target}</span>)}
  </div>,
}))
const topology: RuntimeTopology = { entry: 'map', nodes: [{ id: 'map', kind: 'map', label: 'Review', component: 'review', ends: { next: 'end' } }, { id: 'end', kind: 'end', label: 'Done', ends: {} }], components: { review: { entry: 'read', nodes: [{ id: 'read', kind: 'prompt', label: 'Read', ends: { next: null } }] } } }
function segment(id: string, scope: string, status: 'failed' | 'ok'): LoopStepSegment {
  return { key: id, meta: { index: 1, kind: 'prompt', title: 'Read', nodeId: 'map/read', nodePath: 'map/read', scopeId: scope, attemptId: id, iteration: 1 }, lines: [], lastActivity: null, end: { index: 1, nodeId: 'map/read', status, exitCode: status === 'ok' ? 0 : 1, durationMs: null } }
}
it('explores component topology and selects exact branch attempts without editing the definition', async () => {
  const user = userEvent.setup(), focus = vi.fn()
  const { container } = render(<RuntimeGraphExplorer topology={topology} segments={[segment('left-attempt', 'left', 'failed'), segment('right-attempt', 'right', 'ok')]} settled onFocus={focus} />)
  const details = container.querySelector('details')!
  details.open = true; fireEvent(details, new Event('toggle'))
  expect(await screen.findByText('map → end')).toBeInTheDocument()
  expect(screen.getByTestId('flow')).toHaveAttribute('data-draggable', 'false')
  expect(screen.getByTestId('flow')).toHaveAttribute('data-connectable', 'false')
  await user.click(screen.getByTestId('node-map'))
  await user.click(screen.getByRole('button', { name: 'Open component' }))
  expect(screen.getByTestId('node-read')).toHaveTextContent('Failed')
  await user.click(screen.getByTestId('node-read'))
  await user.click(screen.getByRole('button', { name: 'right · right-attempt · Succeeded' }))
  expect(focus).toHaveBeenCalledWith('right-attempt')
  expect(screen.getByRole('button', { name: 'left · left-attempt · Failed' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Back' }))
  expect(screen.getByTestId('node-map')).toBeInTheDocument()
})
