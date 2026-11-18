import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { within } from '@testing-library/react'
import { render, screen } from '../../../../../test-utils'
import { RuntimeGraphExplorer } from '../RuntimeGraphExplorer'
import type { RuntimeTopology } from '../runtime-topology'
import type { LoopStepSegment } from '../loop-log-model'

vi.mock('@xyflow/react', () => ({
  MarkerType: { ArrowClosed: 'arrowclosed' }, Background: () => null, Controls: () => null,
  ReactFlow: ({ nodes, edges, onNodeClick, nodesDraggable, nodesConnectable }: { nodes: Array<{ id: string; data: { label: ReactNode }; style?: { borderColor?: string; boxShadow?: string; borderStyle?: string } }>; edges: Array<{ id: string; source: string; target: string }>; onNodeClick(event: unknown, node: { id: string }): void; nodesDraggable: boolean; nodesConnectable: boolean }) => <div data-testid="flow" data-draggable={nodesDraggable} data-connectable={nodesConnectable}>
    {nodes.map(node => <button key={node.id} data-testid={`node-${node.id}`} data-border={node.style?.borderColor} data-glow={node.style?.boxShadow} data-border-style={node.style?.borderStyle} onClick={() => onNodeClick(null, node)}>{node.data.label}</button>)}
    {edges.map(edge => <span key={edge.id}>{edge.source} → {edge.target}</span>)}
  </div>,
}))
const topology: RuntimeTopology = { entry: 'map', nodes: [{ id: 'map', kind: 'map', label: 'Review', component: 'review', ends: { next: 'end' } }, { id: 'end', kind: 'end', label: 'Done', ends: {} }], components: { review: { entry: 'read', nodes: [{ id: 'read', kind: 'prompt', label: 'Read', ends: { next: null } }] } } }
function segment(id: string, scope: string, status: 'failed' | 'ok'): LoopStepSegment {
  return { key: id, meta: { index: 1, kind: 'prompt', title: 'Read', nodeId: 'map/read', nodePath: 'map/read', scopeId: scope, attemptId: id, iteration: 1 }, lines: [], lastActivity: null, end: { index: 1, nodeId: 'map/read', status, exitCode: status === 'ok' ? 0 : 1, durationMs: null } }
}
it('explores component topology and selects exact branch attempts without editing the definition', async () => {
  const user = userEvent.setup(), focus = vi.fn(), fork = vi.fn()
  render(<RuntimeGraphExplorer topology={topology} segments={[segment('left-attempt', 'left', 'failed'), segment('right-attempt', 'right', 'ok')]} settled onFocus={focus} onFork={fork} />)
  expect(await screen.findByText('map → end')).toBeInTheDocument()
  expect(screen.getByTestId('flow')).toHaveAttribute('data-draggable', 'false')
  expect(screen.getByTestId('flow')).toHaveAttribute('data-connectable', 'false')
  await user.click(screen.getByTestId('node-map'))
  await user.click(screen.getByRole('button', { name: 'Open component' }))
  expect(screen.getByTestId('node-read')).toHaveTextContent('Failed')
  await user.click(screen.getByTestId('node-read'))
  const panel = screen.getByTestId('runtime-graph-node-panel')
  expect(panel).toHaveTextContent('Read')
  expect(panel).toHaveTextContent('2 attempts')
  await user.click(screen.getByRole('button', { name: 'Attempt 2 · Succeeded · right' }))
  expect(focus).toHaveBeenCalledWith('right-attempt')
  // Each branch forks its own attempt, not merely the latest one.
  await user.click(within(panel).getByRole('button', { name: 'Repeat from here: Attempt 1 · Failed · left' }))
  expect(fork).toHaveBeenCalledWith(expect.objectContaining({ key: 'left-attempt', meta: expect.objectContaining({ nodePath: 'map/read', scopeId: 'left', iteration: 1 }) }))
  await user.click(within(panel).getByRole('button', { name: 'Repeat from here: Attempt 2 · Succeeded · right' }))
  expect(fork).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'right-attempt', meta: expect.objectContaining({ scopeId: 'right' }) }))
  expect(screen.getByRole('button', { name: 'Attempt 1 · Failed · left' })).toBeInTheDocument()
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
  const { rerender } = render(<RuntimeGraphExplorer {...props} />)
  expect(await screen.findByTestId('node-map')).toHaveTextContent('Succeeded')
  expect(screen.getByTestId('node-map')).toHaveAttribute('data-border', 'var(--color-accent-success)')
  expect(screen.getByTestId('node-end')).toHaveTextContent('Running')
  // Lamp canon: running is the info lamp, a solid border and no halo.
  expect(screen.getByTestId('node-end')).toHaveAttribute('data-border', 'var(--color-accent-info)')
  expect(screen.getByTestId('node-end')).toHaveAttribute('data-border-style', 'solid')
  expect(screen.getByTestId('node-end')).not.toHaveAttribute('data-glow')
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
  const { rerender } = render(<RuntimeGraphExplorer {...props} />)
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
  render(<RuntimeGraphExplorer topology={topology} segments={[left, segment('right-attempt', 'right', 'ok')]} settled onFocus={vi.fn()} />)
  await user.click(await screen.findByTestId('node-map'))
  await user.click(screen.getByRole('button', { name: 'Open component' }))
  await user.click(screen.getByTestId('node-read'))
  // Correlation ids live in the collapsed Trace disclosure.
  const trace = screen.getByText('Trace').closest('details')!
  expect(trace).not.toHaveAttribute('open')
  const rows = within(trace).getAllByTestId('runtime-graph-trace')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toHaveTextContent('left-attempt: traceId: recorded-trace · spanId: recorded-span')
  expect(trace).not.toHaveTextContent('right-attempt')
})


it('portals the full screen graph and backdrop above the log modal and consumes Escape', async () => {
  const user = userEvent.setup()
  const escape = vi.fn()
  window.addEventListener('keydown', escape)
  try {
    const { container } = render(<div className="fixed z-[65]" data-testid="log-modal">
      <RuntimeGraphExplorer topology={topology} segments={[]} settled onFocus={vi.fn()} />
    </div>)
    await user.click(await screen.findByRole('button', { name: 'Full screen' }))
    const dialog = screen.getByRole('dialog', { name: 'Run graph' })
    // Capture layer (z-80): above the entity log modal (z-65) and the dock.
    expect(dialog).toHaveClass('z-[80]')
    expect(dialog).toHaveAttribute('data-dialog-layer', 'capture')
    expect(dialog).toHaveAttribute('data-dialog-size', 'fullscreen')
    expect(container).not.toContainElement(dialog)
    const backdrop = dialog.previousElementSibling!
    expect(backdrop).toHaveClass('z-[80]')
    await user.keyboard('{Escape}')
    expect(escape).toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape', defaultPrevented: true }))
    expect(screen.queryByRole('dialog', { name: 'Run graph' })).not.toBeInTheDocument()
    expect(screen.getByTestId('log-modal')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Full screen' })).toHaveFocus()
  } finally {
    window.removeEventListener('keydown', escape)
  }
})

it('opens on the failed step with "Repeat from here" beside the always-expanded graph', async () => {
  const fork = vi.fn()
  const failed = segment('dev-attempt', 'root', 'failed')
  failed.meta.nodePath = failed.meta.nodeId = 'map'; failed.end!.nodeId = 'map'
  render(<RuntimeGraphExplorer topology={topology} segments={[failed]} settled onFocus={vi.fn()} onFork={fork} />)
  const panel = await screen.findByTestId('runtime-graph-node-panel')
  // Beside the canvas, never over it: the graph stays fully visible.
  expect(screen.getByTestId('flow').parentElement).not.toContainElement(panel)
  expect(panel).toHaveTextContent('map')
  await userEvent.setup().click(within(panel).getByRole('button', { name: /^Repeat from here/ }))
  expect(fork).toHaveBeenCalledWith(expect.objectContaining({ key: 'dev-attempt' }))
})

it('keeps the full graph by default, mutes unvisited steps and offers "Only the path taken"', async () => {
  localStorage.clear()
  const user = userEvent.setup()
  const wide: RuntimeTopology = { entry: 'a', nodes: [
    { id: 'a', kind: 'prompt', label: 'A', ends: { next: 'b' } },
    { id: 'b', kind: 'prompt', label: 'B', ends: { next: 'c' } },
    { id: 'c', kind: 'prompt', label: 'C', ends: { next: 'd' } },
    { id: 'd', kind: 'end', label: 'D', ends: {} },
  ], components: {} }
  const ran = segment('a-run', 'root', 'ok')
  ran.meta.nodePath = ran.meta.nodeId = 'a'
  const view = render(<RuntimeGraphExplorer topology={wide} segments={[ran]} settled onFocus={vi.fn()} />)
  for (const id of ['a', 'b', 'c', 'd']) expect(await screen.findByTestId(`node-${id}`)).toBeInTheDocument()
  expect(screen.getByTestId('node-c')).toHaveAttribute('data-border-style', 'dashed')
  expect(screen.getByTestId('node-a')).toHaveAttribute('data-border-style', 'solid')
  expect(within(screen.getByRole('list', { name: 'Graph legend' })).queryByText('Pending')).not.toBeInTheDocument()
  const toggle = screen.getByTestId('runtime-graph-path-only')
  expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await user.click(toggle)
  // The path taken plus one hop.
  expect(screen.getByTestId('node-a')).toBeInTheDocument()
  expect(screen.getByTestId('node-b')).toBeInTheDocument()
  expect(screen.queryByTestId('node-c')).not.toBeInTheDocument()
  expect(screen.queryByTestId('node-d')).not.toBeInTheDocument()
  expect(localStorage.getItem('specrails-desktop:runtime-graph-path-only')).toBe('true')
  view.unmount()
  render(<RuntimeGraphExplorer topology={wide} segments={[ran]} settled onFocus={vi.fn()} />)
  expect(screen.getByTestId('runtime-graph-path-only')).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByTestId('node-d')).not.toBeInTheDocument()
  localStorage.clear()
})
