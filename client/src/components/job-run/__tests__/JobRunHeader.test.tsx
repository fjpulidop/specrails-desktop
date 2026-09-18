import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '../../../test-utils'
import userEvent from '@testing-library/user-event'
import { JobRunHeader } from '../JobRunHeader'
import type { JobSummary, EventRow, PhaseDefinition } from '../../../types'

vi.mock('../../PipelineProgress', () => ({
  PipelineProgress: () => <div data-testid="pipeline-progress">PipelineProgress</div>,
}))

const completedJob: JobSummary = {
  id: 'job-1',
  command: '/specrails:implement --spec SPEA-001',
  started_at: '2024-03-21T10:00:00Z',
  finished_at: '2024-03-21T10:01:02Z', // 62s wall-clock
  status: 'completed',
  duration_ms: 62000,
  total_cost_usd: 0.0234,
  tokens_in: 5000,
  tokens_out: 3000,
  num_turns: 8,
}

const failedJob: JobSummary = {
  id: 'job-2',
  command: '/specrails:health-check',
  started_at: '2024-03-21T11:00:00Z',
  finished_at: null,
  status: 'failed',
  duration_ms: null,
  total_cost_usd: null,
  tokens_in: null,
  tokens_out: null,
  num_turns: null,
}

const runningJob: JobSummary = {
  id: 'job-running',
  command: '/specrails:implement #24',
  started_at: new Date(Date.now() - 65_000).toISOString(),
  finished_at: null,
  status: 'running',
  duration_ms: null,
  total_cost_usd: null,
  tokens_in: null,
  tokens_out: null,
  num_turns: null,
}

function assistantTool(seq: number, name: string, input: Record<string, unknown>, usage?: Record<string, unknown>): EventRow {
  return { id: seq, job_id: 'job-running', seq, event_type: 'assistant', payload: JSON.stringify({ message: { content: [{ type: 'tool_use', name, input }], ...(usage ? { usage } : {}) } }), timestamp: '' }
}
function assistantText(seq: number, usage?: Record<string, unknown>): EventRow {
  return { id: seq, job_id: 'job-running', seq, event_type: 'assistant', payload: JSON.stringify({ message: { content: [{ type: 'text', text: 'hello' }], ...(usage ? { usage } : {}) } }), timestamp: '' }
}

const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response
const run = (overrides = {}) => ({ runId: 'job-1', status: 'paused', nextStep: 'architect', canResume: true, canCancel: false, active: false, recoverableSteps: [], ...overrides })

function renderHeader(job: JobSummary, events: EventRow[] = [], extra: Partial<React.ComponentProps<typeof JobRunHeader>> = {}) {
  return render(<JobRunHeader job={job} events={events} phases={{}} phaseDefinitions={[]} variant="page" {...extra} />)
}

describe('JobRunHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    global.fetch = vi.fn().mockResolvedValue(response({ runs: [] }))
  })
  afterEach(() => { localStorage.clear() })

  // ── Row 1 ──────────────────────────────────────────────────────────────────

  it('renders the status pill and the final duration once for a completed job', () => {
    renderHeader(completedJob)
    expect(screen.getByText('completed')).toBeInTheDocument()
    expect(screen.getAllByText('1m 2s')).toHaveLength(1)
  })

  it('renders exactly one pipeline chip row', () => {
    const phaseDefinitions: PhaseDefinition[] = [{ key: 'arch', label: 'Architect', description: '' }]
    renderHeader(completedJob, [], { phaseDefinitions, phases: { arch: 'done' } })
    expect(screen.getAllByTestId('pipeline-progress')).toHaveLength(1)
  })

  it('omits the pipeline row when there are no phase definitions', () => {
    renderHeader(completedJob)
    expect(screen.queryByTestId('pipeline-progress')).not.toBeInTheDocument()
  })

  it('renders surface-owned actions on row 1', () => {
    renderHeader(runningJob, [], { actions: <button>Cancel job</button> })
    expect(screen.getByRole('button', { name: 'Cancel job' })).toBeInTheDocument()
  })

  it('ticks the live elapsed every second while running', () => {
    vi.useFakeTimers()
    try {
      const startedAt = new Date(Date.now() - 5_000).toISOString()
      renderHeader({ ...runningJob, started_at: startedAt })
      expect(screen.getByText('5s')).toBeInTheDocument()
      act(() => { vi.advanceTimersByTime(3_000) })
      expect(screen.getByText('8s')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the connecting activity before any frame arrives', () => {
    renderHeader(runningJob)
    expect(screen.getByTestId('job-run-activity')).toHaveTextContent('Connecting to the agent…')
  })

  it('composes phase · activity from the running pipeline phase and the last tool action', () => {
    const phaseDefinitions: PhaseDefinition[] = [
      { key: 'arch', label: 'Architect', description: '' },
      { key: 'dev', label: 'Developer', description: '' },
    ]
    renderHeader(runningJob, [assistantTool(1, 'Read', { file_path: 'README.md' })], { phaseDefinitions, phases: { arch: 'done', dev: 'running' } })
    expect(screen.getByTestId('job-run-activity')).toHaveTextContent('Developer · Reading README.md')
  })

  it('labels a bare assistant text frame as Thinking, Bash as Running and unknown tools as Working', () => {
    const v1 = renderHeader(runningJob, [assistantText(1)])
    expect(screen.getByTestId('job-run-activity')).toHaveTextContent('Thinking…')
    v1.unmount()
    const v2 = renderHeader(runningJob, [assistantTool(1, 'Bash', { command: 'npm test --silent' })])
    expect(screen.getByTestId('job-run-activity')).toHaveTextContent('Running: npm')
    v2.unmount()
    renderHeader(runningJob, [assistantTool(1, 'SomeMcpTool', {})])
    expect(screen.getByTestId('job-run-activity')).toHaveTextContent('Working…')
  })

  it('shows the step count once, only for loop jobs', () => {
    const events = [assistantTool(1, 'Read', { file_path: 'a.ts' }), assistantTool(2, 'Edit', { file_path: 'b.ts' })]
    const { rerender } = renderHeader({ ...runningJob, command: 'loop: Implement' }, events)
    expect(screen.getAllByText('2 steps')).toHaveLength(1)
    rerender(<JobRunHeader job={runningJob} events={events} phases={{}} phaseDefinitions={[]} variant="page" />)
    expect(screen.queryByText('2 steps')).not.toBeInTheDocument()
  })

  it('resets the activity accumulator when the job id changes', () => {
    const loop = { ...runningJob, command: 'loop: x' }
    const { rerender } = renderHeader(loop, [assistantText(1), assistantText(2)])
    expect(screen.getByText('2 steps')).toBeInTheDocument()
    rerender(<JobRunHeader job={{ ...loop, id: 'job-other' }} events={[assistantText(1)]} phases={{}} phaseDefinitions={[]} variant="page" />)
    expect(screen.getByText('1 step')).toBeInTheDocument()
  })

  // ── HONEST metrics ─────────────────────────────────────────────────────────

  it('NEVER shows a cost, placeholder or approximate number while running', () => {
    renderHeader(runningJob, [assistantTool(1, 'Edit', { file_path: 'a.ts' })])
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^~/)).not.toBeInTheDocument()
    expect(screen.queryByText(/calculated when finished/i)).not.toBeInTheDocument()
    // Nothing real to disclose ⇒ no Details toggle at all.
    expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument()
  })

  it('discloses live turns/tokens ONLY when the stream reports usage, with the honest caption', () => {
    const events = [
      assistantText(1, { input_tokens: 1000, output_tokens: 200 }),
      assistantTool(2, 'Read', { file_path: 'a.ts' }), // no usage — a step, never a turn
      assistantText(3, { input_tokens: 500, output_tokens: 300, cache_read_input_tokens: 4000 }),
    ]
    renderHeader(runningJob, events)
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('Turns').nextElementSibling).toHaveTextContent('2')
    expect(screen.getByText('Tokens').nextElementSibling).toHaveTextContent('6.0k')
    expect(screen.getByText(/reported by the provider so far/i)).toBeInTheDocument()
    expect(screen.queryByText('Cost')).not.toBeInTheDocument()
  })

  it('reveals cost, turns and tokens behind Details after exit (cost — until authoritative)', () => {
    const startedAt = new Date(Date.now() - 5000).toISOString()
    const events = [assistantTool(1, 'Edit', { file_path: 'a.ts' })]
    const { rerender } = renderHeader({ ...runningJob, started_at: startedAt }, events)
    expect(screen.queryByText('$0.4200')).not.toBeInTheDocument()

    const completed: JobSummary = { ...runningJob, started_at: startedAt, finished_at: new Date().toISOString(), status: 'completed', total_cost_usd: 0.42, tokens_in: 100, tokens_out: 100, num_turns: 1 }
    rerender(<JobRunHeader job={completed} events={events} phases={{}} phaseDefinitions={[]} variant="page" />)
    expect(screen.getByText('completed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('$0.4200')).toBeInTheDocument()
    expect(screen.getByText('Turns').nextElementSibling).toHaveTextContent('1')
    expect(screen.getByText('Tokens').nextElementSibling).toHaveTextContent('0.2k')
  })

  it('prefixes ~ for an estimated (codex) cost and includes cache tokens in the total', () => {
    renderHeader({ ...completedJob, total_cost_usd_estimated: 1, tokens_cache_read: 90_000, tokens_cache_create: 2_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('~$0.0234')).toBeInTheDocument()
    expect(screen.getByText('100.0k')).toBeInTheDocument()
  })

  it('shows em-dash + "Not available" for null terminal metrics, never a fake 0', () => {
    renderHeader(failedJob)
    expect(screen.getByText('failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3) // duration + cost + turns + tokens
    expect(screen.getAllByText('Not available')).toHaveLength(3)
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument()
  })

  it('captions a null cost on a local engine as "cost unknown (local engine)" with a tooltip', () => {
    renderHeader({ ...failedJob, provider: 'lan-box' })
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    const caption = screen.getByText('Cost unknown (local engine)')
    expect(caption.closest('[title]')).toHaveAttribute('title', expect.stringContaining('Add rates'))
    expect(screen.getAllByText('Not available')).toHaveLength(2)
  })

  it('lists modified files and the pipeline totals (≥ lower bound + partial hint) in Details', () => {
    const events: EventRow[] = [
      { id: 1, job_id: 'job-1', seq: 1, event_type: 'log', payload: JSON.stringify({ line: 'Writing file: src/components/MyComponent.tsx' }), timestamp: '' },
    ]
    renderHeader(completedJob, events, {
      pipelineTotals: { totalCostUsd: 28, hasNullCost: true, costEstimated: false, nullCostCount: 1, totalTokensIn: 1000, totalTokensOut: 500, totalTokensCacheRead: 0, totalTokensCacheCreate: 0, nullTokenCount: 1, jobCount: 3 },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('src/components/MyComponent.tsx')).toBeInTheDocument()
    expect(screen.getByText('Pipeline total (3 phases)')).toBeInTheDocument()
    expect(screen.getByText('≥$28.0000')).toBeInTheDocument()
    expect(screen.getByText('≥1.5k')).toBeInTheDocument()
    expect(screen.getByTestId('pipeline-partial-hint')).toBeInTheDocument()
    expect(screen.getByTestId('pipeline-usage-coverage-hint')).toHaveTextContent(/1 phase/i)
  })

  it('renders unavailable instead of $0/0k for an all-Kimi pipeline', () => {
    renderHeader(completedJob, [], {
      pipelineTotals: { totalCostUsd: 0, hasNullCost: true, nullCostCount: 3, costUnavailable: true, totalTokensIn: 0, totalTokensOut: 0, totalTokensCacheRead: 0, totalTokensCacheCreate: 0, nullTokenCount: 3, tokensUnavailable: true, jobCount: 3 },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByTestId('pipeline-cost-unavailable')).toBeInTheDocument()
    expect(screen.queryByText('$0.0000')).not.toBeInTheDocument()
    expect(screen.queryByText('0.0k')).not.toBeInTheDocument()
  })

  // ── Details memory ─────────────────────────────────────────────────────────

  it('remembers the Details state per surface in localStorage', () => {
    const { unmount } = renderHeader(completedJob)
    expect(screen.queryByTestId('job-run-details')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByTestId('job-run-details')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('specrails-desktop:job-run-details')!)).toEqual({ page: true })
    unmount()
    renderHeader(completedJob, [], { variant: 'glass' })
    expect(screen.queryByTestId('job-run-details')).not.toBeInTheDocument()
  })

  // ── Runtime continuation ───────────────────────────────────────────────────

  it('does not poll the runtime without a project', () => {
    renderHeader(completedJob)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows the paused continuation on row 1 and resumes it from a compact action', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ status: 'failed', nextStep: 'developer' })] }))
    renderHeader(failedJob, [], { projectId: 'p1' })
    expect(await screen.findByTestId('job-run-activity')).toHaveTextContent('Failed · Next phase: Developer')
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs/job-2', expect.anything())
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs/job-1/resume', expect.objectContaining({ method: 'POST', body: '{}' }))
  })

  it('offers recover / approve / prepare delivery / cancel only when the run exposes them', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ status: 'interrupted', recoverableSteps: ['developer'], error: 'Provider stopped' })] }))
    const { unmount } = renderHeader(failedJob, [], { projectId: 'p1' })
    expect(await screen.findByRole('button', { name: 'Recover interrupted phase' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('Provider stopped')).toBeInTheDocument()
    unmount()

    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ pendingApproval: { stepId: 'archive', reason: 'Review before completion' }, nextStep: 'archive' })] }))
    const view2 = renderHeader(failedJob, [], { projectId: 'p1' })
    expect(await screen.findByRole('button', { name: 'Approve completion' })).toBeInTheDocument()
    view2.unmount()

    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ status: 'succeeded', nextStep: null, canResume: false, canSettle: true, canCancel: true })] }))
    renderHeader(completedJob, [], { projectId: 'p1' })
    expect(await screen.findByRole('button', { name: 'Prepare delivery' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel continuation' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
  })

  it('surfaces a pending architect question: row-1 opens Details, the answer submits from there', async () => {
    const user = userEvent.setup()
    const question = { stepId: 'architect', requestedAt: '2026-09-12T00:00:00.000Z', question: 'Which cache backend?' }
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ pendingQuestion: question })] }))
    renderHeader(failedJob, [], { projectId: 'p1' })
    await user.click(await screen.findByRole('button', { name: 'Answer the question' }))
    expect(screen.getByText('Which cache backend?')).toBeInTheDocument()
    const answer = screen.getByRole('button', { name: 'Answer and resume' })
    expect(answer).toBeDisabled()
    await user.type(screen.getByLabelText('Your answer'), 'Redis')
    await user.click(answer)
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs/job-1/resume', expect.objectContaining({ method: 'POST', body: JSON.stringify({ answer: 'Redis' }) }))
    await waitFor(() => expect(screen.getByLabelText('Your answer')).toHaveValue(''))
  })

  it('renders the runtime metrics and evidence disclosures inside Details', async () => {
    const total = { attempts: 1, measuredAttempts: 1, durationMs: 12000, agentDurationMs: 8000, providerCalls: 1, toolCalls: 7, inputTokens: 100, outputTokens: 10, costUsd: 1.25, uncachedInputTokens: 20, cacheReadInputTokens: 80, cacheWriteInputTokens: 0 }
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ status: 'succeeded', nextStep: null, canResume: false, historical: true, metrics: { schemaVersion: 1, total, phases: [] } })] }))
    renderHeader(completedJob, [], { projectId: 'p1' })
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
    expect(await screen.findByRole('region', { name: 'Implementation' })).toBeInTheDocument()
    fireEvent.click(screen.getByText('Usage and time'))
    expect(screen.getByText('Agent time').nextElementSibling).toHaveTextContent('8s')
    expect(screen.getByText('Verification evidence')).toBeInTheDocument()
  })
})
