import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { within } from '@testing-library/react'
import { render, screen, fireEvent } from '../../../../../test-utils'
import { RuntimeGraphExplorer } from '../RuntimeGraphExplorer'
import type { RuntimeTopology } from '../runtime-topology'
import type { LoopStepSegment } from '../loop-log-model'

vi.mock('@xyflow/react', () => ({
  MarkerType: { ArrowClosed: 'arrowclosed' }, Background: () => null, Controls: () => null,
  ReactFlow: ({ nodes, edges, onNodeClick, nodesDraggable, nodesConnectable }: { nodes: Array<{ id: string; data: { label: ReactNode }; style?: { borderColor?: string; boxShadow?: string } }>; edges: Array<{ id: string; source: string; target: string }>; onNodeClick(event: unknown, node: { id: string }): void; nodesDraggable: boolean; nodesConnectable: boolean }) => <div data-testid="flow" data-draggable={nodesDraggable} data-connectable={nodesConnectable}>
    {nodes.map(node => <button key={node.id} data-testid={`node-${node.id}`} data-border={node.style?.borderColor} data-glow={node.style?.boxShadow} onClick={() => onNodeClick(null, node)}>{node.data.label}</button>)}
    {edges.map(edge => <span key={edge.id}>{edge.source} → {edge.target}</span>)}
  </div>,
}))
const topology: RuntimeTopology = { entry: 'map', nodes: [{ id: 'map', kind: 'map', label: 'Review', component: 'review', ends: { next: 'end' } }, { id: 'end', kind: 'end', label: 'Done', ends: {} }], components: { review: { entry: 'read', nodes: [{ id: 'read', kind: 'prompt', label: 'Read', ends: { next: null } }] } } }
function segment(id: string, scope: string, status: 'failed' | 'ok'): LoopStepSegment {
  return { key: id, meta: { index: 1, kind: 'prompt', title: 'Read', nodeId: 'map/read', nodePath: 'map/read', scopeId: scope, attemptId: id, iteration: 1 }, lines: [], lastActivity: null, end: { index: 1, nodeId: 'map/read', status, exitCode: status === 'ok' ? 0 : 1, durationMs: null } }
}
it('explores component topology and selects exact branch attempts without editing the definition', async () => {
  const user = userEvent.setup(), focus = vi.fn(), fork = vi.fn()
  const { container } = render(<RuntimeGraphExplorer topology={topology} segments={[segment('left-attempt', 'left', 'failed'), segment('right-attempt', 'right', 'ok')]} settled onFocus={focus} onFork={fork} />)
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
  const right = screen.getByRole('button', { name: 'right · right-attempt · Succeeded' }).closest('li')!
  await user.click(within(right).getByRole('button', { name: 'Repeat from here' }))
  expect(fork).toHaveBeenCalledWith(expect.objectContaining({ key: 'right-attempt', meta: expect.objectContaining({ nodePath: 'map/read', scopeId: 'right', iteration: 1 }) }))
  expect(screen.getByRole('button', { name: 'left · left-attempt · Failed' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Back' }))
  expect(screen.getByTestId('node-map')).toBeInTheDocument()
})

it('highlights live steps, marks completed steps and retains live updates in full screen', async () => {
  const user = userEvent.setup()
  const done = segment('map-done', 'root', 'ok')
  done.meta.nodePath = done.meta.nodeId = 'map'; done.end!.nodeId = 'map'
  const active = segment('end-active', 'root', 'ok')
  active.meta.nodePath = active.meta.nodeId = 'end'; delete active.end
  const props = { topology, segments: [done, active], settled: false, onFocus: vi.fn() }
  const { container, rerender } = render(<RuntimeGraphExplorer {...props} />)
  const details = container.querySelector('details')!
  details.open = true; fireEvent(details, new Event('toggle'))
  expect(await screen.findByTestId('node-map')).toHaveTextContent('Succeeded')
  expect(screen.getByTestId('node-map')).toHaveAttribute('data-border', 'var(--color-accent-success)')
  expect(screen.getByTestId('node-end')).toHaveTextContent('Running')
  expect(screen.getByTestId('node-end')).toHaveAttribute('data-border', 'var(--color-accent-primary)')
  expect(screen.getByTestId('node-end').getAttribute('data-glow')).toContain('22px')
  await user.click(screen.getByRole('button', { name: 'Full screen' }))
  const dialog = screen.getByRole('dialog', { name: 'Run graph' })
  expect(within(dialog).getByTestId('node-end')).toHaveTextContent('Running')
  const completed = { ...active, end: { ...done.end!, nodeId: 'end' } }
  rerender(<RuntimeGraphExplorer {...props} segments={[done, completed]} />)
  expect(within(dialog).getByTestId('node-end')).toHaveTextContent('Succeeded')
  expect(within(dialog).getByTestId('node-end')).not.toHaveAttribute('data-glow')
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: 'Run graph' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Full screen' })).toHaveFocus()
  expect(screen.getByTestId('node-end')).toHaveTextContent('Succeeded')
})

it('does not mark unvisited or interrupted steps as completed and highlights a retried node', async () => {
  const done = segment('map-done', 'root', 'ok')
  done.meta.nodePath = done.meta.nodeId = 'map'
  const retry = { ...done, key: 'map-retry', meta: { ...done.meta, attemptId: 'retry' }, end: undefined }
  const props = { topology, segments: [done, retry], settled: false, onFocus: vi.fn() }
  const { container, rerender } = render(<RuntimeGraphExplorer {...props} />)
  const details = container.querySelector('details')!
  details.open = true; fireEvent(details, new Event('toggle'))
  expect(await screen.findByTestId('node-map')).toHaveTextContent('Running')
  expect(screen.getByTestId('node-end')).toHaveTextContent('Pending')
  rerender(<RuntimeGraphExplorer {...props} settled />)
  expect(screen.getByTestId('node-map')).toHaveTextContent('Interrupted')
  expect(screen.getByTestId('node-map')).not.toHaveAttribute('data-glow')
})

it('shows recorded trace and event-span correlation only for the owning attempt', async () => {
  const user = userEvent.setup()
  const left = segment('left-attempt', 'left', 'failed')
  left.meta.traceId = 'recorded-trace'
  left.meta.spanId = 'recorded-span'
  const { container } = render(<RuntimeGraphExplorer topology={topology} segments={[left, segment('right-attempt', 'right', 'ok')]} settled onFocus={vi.fn()} />)
  const details = container.querySelector('details')!
  details.open = true; fireEvent(details, new Event('toggle'))
  await user.click(await screen.findByTestId('node-map'))
  await user.click(screen.getByRole('button', { name: 'Open component' }))
  await user.click(screen.getByTestId('node-read'))
  const leftRow = screen.getByRole('button', { name: 'left · left-attempt · Failed' }).closest('li')!
  const rightRow = screen.getByRole('button', { name: 'right · right-attempt · Succeeded' }).closest('li')!
  expect(leftRow).toHaveTextContent('traceId: recorded-trace · spanId: recorded-span')
  expect(rightRow).not.toHaveTextContent('traceId:')
  expect(rightRow).not.toHaveTextContent('spanId:')
})


it('portals the full screen graph and backdrop above the log modal and consumes Escape', async () => {
  const user = userEvent.setup()
  const escape = vi.fn()
  window.addEventListener('keydown', escape)
  try {
    const { container } = render(<div className="fixed z-[65]" data-testid="log-modal">
      <RuntimeGraphExplorer topology={topology} segments={[]} settled onFocus={vi.fn()} />
    </div>)
    const details = container.querySelector('details')!
    details.open = true; fireEvent(details, new Event('toggle'))
    await user.click(await screen.findByRole('button', { name: 'Full screen' }))
    const dialog = screen.getByRole('dialog', { name: 'Run graph' })
    expect(dialog).toHaveClass('z-[2147483647]')
    expect(container).not.toContainElement(dialog)
    const backdrop = dialog.previousElementSibling!
    expect(backdrop).toHaveClass('z-[2147483646]')
    await user.keyboard('{Escape}')
    expect(escape).toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape', defaultPrevented: true }))
    expect(screen.queryByRole('dialog', { name: 'Run graph' })).not.toBeInTheDocument()
    expect(screen.getByTestId('log-modal')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Full screen' })).toHaveFocus()
  } finally {
    window.removeEventListener('keydown', escape)
  }
})
