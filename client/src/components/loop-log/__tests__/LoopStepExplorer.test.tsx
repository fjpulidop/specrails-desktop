import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../test-utils'
import userEvent from '@testing-library/user-event'

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <span>{children}</span>,
}))
vi.mock('remark-gfm', () => ({ default: () => {} }))
vi.mock('rehype-highlight', () => ({ default: () => {} }))
vi.mock('../../../lib/markdown-detect', () => ({ hasMarkdownSyntax: () => false }))

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

import { LoopStepExplorer } from '../LoopStepExplorer'
import type { EventRow } from '../../../types'
import type { LoopGraph } from '../../../lib/loops-api'

let nextId = 1
function ev(event_type: string, payload: unknown, source = 'stdout'): EventRow {
  return {
    id: nextId++,
    job_id: 'run-1',
    seq: nextId,
    event_type,
    source,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    timestamp: '2026-07-04T10:00:00Z',
  }
}
const logEv = (line: string) => ev('log', { line })
const stepEv = (index: number, kind: string, title: string, extra: Record<string, unknown> = {}) =>
  ev('loop_step', { index, kind, title, ...extra })
const endEv = (index: number, extra: Record<string, unknown> = {}) =>
  ev('loop_step_end', { index, nodeId: null, status: 'ok', exitCode: 0, durationMs: 1500, ...extra })

const GRAPH: LoopGraph = {
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 } },
    { id: 'ai1', type: 'ai-step', position: { x: 0, y: 100 }, data: { label: 'Implement' } },
    { id: 'dec', type: 'decider', position: { x: 0, y: 200 } },
    { id: 'end', type: 'end', position: { x: 0, y: 300 } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'ai1' },
    { id: 'e2', source: 'ai1', target: 'dec' },
    { id: 'e3', source: 'dec', target: 'ai1', branch: 'continue' },
    { id: 'e4', source: 'dec', target: 'end', branch: 'stop' },
  ],
  config: { maxIterations: 5, timeoutMinutes: 60 },
}
const graphEv = () =>
  ev('loop_graph', { graph: GRAPH, loopId: 'l1', loopName: 'My Loop', provider: 'claude', model: 'sonnet', iterationLimit: 5 })

/** A live run: setup + step 1 (ended ok) + step 2 (running, no end). */
function liveRunEvents(): EventRow[] {
  return [
    graphEv(),
    logEv('▶ Loop "My Loop" started'),
    stepEv(1, 'ai-step', '🤖 Implement (claude/sonnet)', { nodeId: 'ai1', iteration: 0 }),
    logEv('first step output'),
    endEv(1, { nodeId: 'ai1' }),
    stepEv(2, 'decider', '🔍 Loop Decider (iteration 1)', { nodeId: 'dec', iteration: 1 }),
    logEv('decider is thinking'),
  ]
}

beforeEach(() => {
  nextId = 1
  toastSuccess.mockClear()
  toastError.mockClear()
})

describe('LoopStepExplorer', () => {
  it('renders setup + step boxes; follow mode expands ONLY the running step', () => {
    render(<LoopStepExplorer events={liveRunEvents()} jobStatus="running" />)
    expect(screen.getByTestId('loop-step-explorer')).toBeInTheDocument()
    // Setup section collapsed (its line hidden), running step expanded
    expect(screen.getByTestId('loop-setup-section')).toBeInTheDocument()
    expect(screen.queryByText('▶ Loop "My Loop" started')).not.toBeInTheDocument()
    expect(screen.queryByText('first step output')).not.toBeInTheDocument()
    expect(screen.getByText('decider is thinking')).toBeInTheDocument()
    // Running section flagged
    const sections = screen.getAllByTestId('loop-step-section')
    expect(sections[1].getAttribute('data-status')).toBe('running')
    expect(sections[0].getAttribute('data-status')).toBe('ok')
  })

  it('clicking a previous step focuses it, pauses follow, and shows the Resume pill', async () => {
    const user = userEvent.setup()
    render(<LoopStepExplorer events={liveRunEvents()} jobStatus="running" />)
    expect(screen.queryByTestId('resume-follow-pill')).not.toBeInTheDocument()

    await user.click(screen.getByText('Implement (claude/sonnet)'))
    // Focused step is now expanded alongside the running one
    expect(screen.getByText('first step output')).toBeInTheDocument()
    expect(screen.getByText('decider is thinking')).toBeInTheDocument()
    expect(screen.getByTestId('resume-follow-pill')).toBeInTheDocument()
  })

  it('Resume follow re-enters follow mode (pill gone, previous steps re-collapse)', async () => {
    const user = userEvent.setup()
    render(<LoopStepExplorer events={liveRunEvents()} jobStatus="running" />)
    await user.click(screen.getByText('Implement (claude/sonnet)'))
    await user.click(screen.getByTestId('resume-follow-pill'))
    expect(screen.queryByTestId('resume-follow-pill')).not.toBeInTheDocument()
    expect(screen.queryByText('first step output')).not.toBeInTheDocument()
    expect(screen.getByText('decider is thinking')).toBeInTheDocument()
  })

  it('Expand all / Collapse all override follow', async () => {
    const user = userEvent.setup()
    render(<LoopStepExplorer events={liveRunEvents()} jobStatus="running" />)
    await user.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(screen.getByText('▶ Loop "My Loop" started')).toBeInTheDocument()
    expect(screen.getByText('first step output')).toBeInTheDocument()
    expect(screen.getByText('decider is thinking')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(screen.queryByText('▶ Loop "My Loop" started')).not.toBeInTheDocument()
    expect(screen.queryByText('first step output')).not.toBeInTheDocument()
    expect(screen.queryByText('decider is thinking')).not.toBeInTheDocument()
  })

  it('copy per step writes ONLY that step\'s lines to the clipboard', async () => {
    // fireEvent (not userEvent) — userEvent.setup() installs its own clipboard
    // stub that would shadow this spy (same idiom as LogViewer.test).
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, writable: true, configurable: true })
    render(<LoopStepExplorer events={liveRunEvents()} jobStatus="running" />)

    const copyButtons = screen.getAllByRole('button', { name: 'Copy step' })
    fireEvent.click(copyButtons[0])
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('first step output'))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Step copied to clipboard'))
  })

  it('whole-log copy copies setup + every step with headers', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, writable: true, configurable: true })
    render(<LoopStepExplorer events={liveRunEvents()} jobStatus="running" />)

    const copyAll = screen.getByRole('button', { name: 'Log copied to clipboard' })
    fireEvent.click(copyAll)
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const text = writeText.mock.calls[0][0] as string
    expect(text).toContain('▶ Loop "My Loop" started')
    expect(text).toContain('── Step 1 · Implement (claude/sonnet) ──')
    expect(text).toContain('first step output')
    expect(text).toContain('── Step 2 · Loop Decider (iteration 1) ──')
    expect(text).toContain('decider is thinking')
  })

  it('overview strip: states matrix (ok / running / pending) + iteration chip', () => {
    render(<LoopStepExplorer events={liveRunEvents()} jobStatus="running" />)
    const chips = screen.getAllByTestId('loop-node-chip')
    const byKind = (kind: string) => chips.find((c) => c.getAttribute('data-kind') === kind)!
    expect(byKind('start').getAttribute('data-state')).toBe('ok')
    expect(byKind('ai-step').getAttribute('data-state')).toBe('ok')
    expect(byKind('decider').getAttribute('data-state')).toBe('running')
    expect(byKind('end').getAttribute('data-state')).toBe('pending')
    expect(screen.getByTestId('loop-iteration-chip')).toHaveTextContent('Iteration 1/5')
  })

  it('overview strip: failed and interrupted states on a settled run', () => {
    const events = [
      graphEv(),
      stepEv(1, 'ai-step', '🤖 Implement', { nodeId: 'ai1', iteration: 0 }),
      endEv(1, { nodeId: 'ai1', status: 'failed', exitCode: 3 }),
      stepEv(2, 'decider', '🔍 Loop Decider (iteration 1)', { nodeId: 'dec', iteration: 1 }),
      logEv('killed mid-flight'),
    ]
    render(<LoopStepExplorer events={events} jobStatus="failed" />)
    const chips = screen.getAllByTestId('loop-node-chip')
    const byKind = (kind: string) => chips.find((c) => c.getAttribute('data-kind') === kind)!
    expect(byKind('ai-step').getAttribute('data-state')).toBe('failed')
    expect(byKind('decider').getAttribute('data-state')).toBe('interrupted')
    expect(byKind('end').getAttribute('data-state')).toBe('failed')
    // The interrupted badge renders on the step box too
    expect(screen.getByText('Interrupted')).toBeInTheDocument()
    // Exit code surfaces on the failed step header
    expect(screen.getByText('exit 3')).toBeInTheDocument()
    // No resume pill on a settled run
    expect(screen.queryByTestId('resume-follow-pill')).not.toBeInTheDocument()
  })

  it('decider chip shows the verdict arrow when decided', () => {
    const events = [
      graphEv(),
      stepEv(1, 'decider', '🔍 Loop Decider (iteration 1)', { nodeId: 'dec', iteration: 1 }),
      endEv(1, { nodeId: 'dec', decision: 'continue' }),
      stepEv(2, 'ai-step', '🤖 Implement', { nodeId: 'ai1', iteration: 1 }),
    ]
    render(<LoopStepExplorer events={events} jobStatus="running" />)
    const decider = screen
      .getAllByTestId('loop-node-chip')
      .find((c) => c.getAttribute('data-kind') === 'decider')!
    expect(decider.getAttribute('data-decision')).toBe('continue')
  })

  it('clicking a chip focuses that node\'s LATEST step box (pauses follow)', async () => {
    const user = userEvent.setup()
    const events = [
      graphEv(),
      stepEv(1, 'ai-step', '🤖 Implement', { nodeId: 'ai1', iteration: 0 }),
      logEv('iteration zero output'),
      endEv(1, { nodeId: 'ai1' }),
      stepEv(2, 'decider', '🔍 Loop Decider (iteration 1)', { nodeId: 'dec', iteration: 1 }),
      endEv(2, { nodeId: 'dec', decision: 'continue' }),
      stepEv(3, 'ai-step', '🤖 Implement', { nodeId: 'ai1', iteration: 1 }),
      logEv('iteration one output'),
      endEv(3, { nodeId: 'ai1' }),
      stepEv(4, 'decider', '🔍 Loop Decider (iteration 2)', { nodeId: 'dec', iteration: 2 }),
      logEv('deciding again'),
    ]
    render(<LoopStepExplorer events={events} jobStatus="running" />)
    const aiChip = screen
      .getAllByTestId('loop-node-chip')
      .find((c) => c.getAttribute('data-kind') === 'ai-step')!
    await user.click(aiChip)
    // The LATEST ai1 box (iteration 1) opens — not the first one
    expect(screen.getByText('iteration one output')).toBeInTheDocument()
    expect(screen.queryByText('iteration zero output')).not.toBeInTheDocument()
    expect(screen.getByTestId('resume-follow-pill')).toBeInTheDocument()
  })

  it('LEGACY run without loop_graph derives a linear strip from seen steps', () => {
    const events = [
      logEv('▶ Loop "Old" started'),
      stepEv(1, 'ai-step', '🤖 Fix bug'), // legacy: no nodeId, no iteration
      logEv('working'),
      stepEv(2, 'decider', '🔍 Loop Decider (iteration 1)'),
      logEv('deciding'),
    ]
    render(<LoopStepExplorer events={events} jobStatus="running" />)
    const chips = screen.getAllByTestId('loop-node-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0].getAttribute('data-kind')).toBe('ai-step')
    expect(chips[1].getAttribute('data-kind')).toBe('decider')
    // Fully-legacy steps carry no iteration → the iteration chip is hidden
    expect(screen.queryByTestId('loop-iteration-chip')).not.toBeInTheDocument()
  })

  it('iteration chip without a known limit falls back to the badge form', () => {
    const events = [
      // New-style steps (iteration present) but no loop_graph snapshot
      stepEv(1, 'decider', '🔍 Loop Decider (iteration 1)', { iteration: 1 }),
      logEv('deciding'),
    ]
    render(<LoopStepExplorer events={events} jobStatus="running" />)
    expect(screen.getByTestId('loop-iteration-chip')).toHaveTextContent('iter 1')
  })

  it('shows the waiting row between steps (last step ended, run alive)', () => {
    const events = [
      graphEv(),
      stepEv(1, 'ai-step', '🤖 Implement', { nodeId: 'ai1', iteration: 0 }),
      logEv('done here'),
      endEv(1, { nodeId: 'ai1' }),
    ]
    render(<LoopStepExplorer events={events} jobStatus="running" />)
    expect(screen.getByTestId('loop-waiting-row')).toHaveTextContent('Waiting for the next step…')
  })

  it('step header shows duration and iteration badge when ended', () => {
    const events = [
      graphEv(),
      stepEv(1, 'decider', '🔍 Loop Decider (iteration 2)', { nodeId: 'dec', iteration: 2 }),
      endEv(1, { nodeId: 'dec', durationMs: 2500, decision: 'stop' }),
    ]
    render(<LoopStepExplorer events={events} jobStatus="completed" />)
    expect(screen.getByText('2.5s')).toBeInTheDocument()
    expect(screen.getByText('iter 2')).toBeInTheDocument()
    // Title deduped: "(iteration 2)" folded into the badge. The bare name shows
    // on BOTH the strip chip and the step header.
    expect(screen.getAllByText('Loop Decider').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('Loop Decider (iteration 2)')).not.toBeInTheDocument()
  })

  it('live activity label renders on the running step', () => {
    const events = [
      graphEv(),
      stepEv(1, 'ai-step', '🤖 Implement', { nodeId: 'ai1', iteration: 0 }),
      ev('assistant', {
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x/app.ts' } }] },
      }),
    ]
    render(<LoopStepExplorer events={events} jobStatus="running" />)
    expect(screen.getByText('Editing app.ts')).toBeInTheDocument()
  })

  it('filter searches EVERY section and shows the filtered count', async () => {
    const user = userEvent.setup()
    render(<LoopStepExplorer events={liveRunEvents()} jobStatus="running" />)
    const input = screen.getByPlaceholderText(/Filter logs/i)
    await user.type(input, 'first step')
    // Collapsed sections are searched too (filter overrides collapse)
    expect(screen.getByText('first step output')).toBeInTheDocument()
    expect(screen.queryByText('decider is thinking')).not.toBeInTheDocument()
    expect(screen.getByText(/1 \/ 3 lines/i)).toBeInTheDocument()
  })

  it('step detail disclosure: ⓘ expands Template + Command from the payload (collapsed by default)', async () => {
    const user = userEvent.setup()
    const events = [
      graphEv(),
      stepEv(1, 'ai-step', '🤖 Implement', {
        nodeId: 'ai1',
        iteration: 1,
        template: '{{cmd:implement}}',
        command: '/specrails:implement #42 --yes',
      }),
      logEv('real output line'),
    ]
    render(<LoopStepExplorer events={events} jobStatus="running" />)
    // Collapsed by default — the detail block is not mounted
    expect(screen.queryByTestId('loop-step-detail')).not.toBeInTheDocument()
    expect(screen.queryByText('{{cmd:implement}}')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Step details' }))
    expect(screen.getByTestId('loop-step-detail')).toBeInTheDocument()
    expect(screen.getByText('Template')).toBeInTheDocument()
    expect(screen.getByText('{{cmd:implement}}')).toBeInTheDocument()
    expect(screen.getByText('Command')).toBeInTheDocument()
    expect(screen.getByText('/specrails:implement #42 --yes')).toBeInTheDocument()
    // The step body still shows the real transcript alongside
    expect(screen.getByText('real output line')).toBeInTheDocument()

    // Toggle back off
    await user.click(screen.getByRole('button', { name: 'Step details' }))
    expect(screen.queryByTestId('loop-step-detail')).not.toBeInTheDocument()
  })

  it('step detail: copy control writes the field value to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, writable: true, configurable: true })
    const events = [
      graphEv(),
      stepEv(1, 'ai-step', '🤖 Implement', { nodeId: 'ai1', iteration: 1, command: '/specrails:implement #42 --yes' }),
    ]
    render(<LoopStepExplorer events={events} jobStatus="running" />)
    fireEvent.click(screen.getByRole('button', { name: 'Step details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy — Command' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/specrails:implement #42 --yes'))
  })

  it('no ⓘ disclosure on steps without payload detail (legacy runs, shell/decider)', () => {
    render(<LoopStepExplorer events={liveRunEvents()} jobStatus="running" />)
    expect(screen.queryByRole('button', { name: 'Step details' })).not.toBeInTheDocument()
  })

  it('empty state: waiting message for a live run with no events yet', () => {
    render(<LoopStepExplorer events={[]} jobStatus="running" />)
    expect(screen.getByText('Waiting for the next step…')).toBeInTheDocument()
  })

  it('loading state mirrors LogViewer', () => {
    render(<LoopStepExplorer events={[]} jobStatus="running" isLoading />)
    expect(screen.getByText(/Loading logs/i)).toBeInTheDocument()
  })
})
