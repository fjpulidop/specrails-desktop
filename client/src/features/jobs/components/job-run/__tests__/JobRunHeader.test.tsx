import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '../../../../../test-utils'
import userEvent from '@testing-library/user-event'
import { JobRunHeader as Header } from '../JobRunHeader'
import { RunDetailTabs } from '../RunDetailTabs'
import { notifyError } from '../../../../../lib/notify-error'
import type { JobSummary, EventRow, PhaseDefinition } from '../../../../../types'

vi.mock('../../../../../lib/notify-error', () => ({ notifyError: vi.fn() }))

function JobRunHeader(props: React.ComponentProps<typeof Header>) {
  return <Header {...props} renderRunDetails={context => <RunDetailTabs {...context} job={props.job} events={props.events} surface={props.variant === 'glass' ? 'modal' : 'page'} isLoop={props.job.command.startsWith('loop:')} onOpenLogs={props.onOpenLogs ?? (() => {})} logContent={<p>Log evidence</p>} />} />
}

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
    expect(screen.getByText('Completed')).toBeInTheDocument()
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
    expect(screen.queryByText('$0.42')).not.toBeInTheDocument()

    const completed: JobSummary = { ...runningJob, started_at: startedAt, finished_at: new Date().toISOString(), status: 'completed', total_cost_usd: 0.42, tokens_in: 100, tokens_out: 100, num_turns: 1 }
    rerender(<JobRunHeader job={completed} events={events} phases={{}} phaseDefinitions={[]} variant="page" />)
    expect(screen.getByText('Completed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getAllByText('$0.42')).toHaveLength(2) // outcome header + Details tile
    expect(screen.getByText('Turns').nextElementSibling).toHaveTextContent('1')
    expect(screen.getByText('Tokens').nextElementSibling).toHaveTextContent('0.2k')
  })

  it('prefixes ~ for an estimated (codex) cost and includes cache tokens in the total', () => {
    renderHeader({ ...completedJob, total_cost_usd_estimated: 1, tokens_cache_read: 90_000, tokens_cache_create: 2_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getAllByText('~$0.02').length).toBeGreaterThan(0)
    expect(screen.getByText('100.0k')).toBeInTheDocument()
  })

  it('leaves out Details when the run recorded no metrics, never showing empty tiles or a fake 0', () => {
    renderHeader(failedJob)
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument()
    expect(screen.queryByText('Not available')).not.toBeInTheDocument()
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument()
  })

  it('shows only the metrics a run recorded', () => {
    renderHeader({ ...failedJob, tokens_in: 900, tokens_out: 100 })
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('Tokens')).toBeInTheDocument()
    expect(screen.queryByText('Cost')).not.toBeInTheDocument()
    expect(screen.queryByText('Not available')).not.toBeInTheDocument()
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
    expect(screen.getByText('≥$28.00')).toBeInTheDocument()
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
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    expect(screen.queryByText('0.0k')).not.toBeInTheDocument()
  })

  // ── Details popover ───────────────────────────────────────────────────────

  it('opens Details as a popover beside the tabs instead of a block above the log', () => {
    renderHeader(completedJob)
    expect(screen.queryByTestId('job-run-details')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByRole('dialog', { name: 'Details' })).toContainElement(screen.getByTestId('job-run-details'))
    expect(localStorage.getItem('specrails-desktop:job-run-details')).toBeNull()
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
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument()
    view2.unmount()

    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ status: 'succeeded', nextStep: null, canResume: false, canSettle: true, canCancel: true })] }))
    renderHeader(completedJob, [], { projectId: 'p1' })
    expect(await screen.findByRole('button', { name: 'Prepare delivery' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel continuation' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
  })

  it('an answerable question has no place in the header or under Failure reasons: Answer goes to its card', async () => {
    const question = { stepId: 'architect', requestedAt: '2026-09-12T00:00:00.000Z', question: 'Which cache backend?' }
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ pendingQuestion: question })] }))
    renderHeader(failedJob, [], { projectId: 'p1' })
    expect(await screen.findByRole('button', { name: 'Answer' })).toBeInTheDocument()
    expect(screen.queryByText('Which cache backend?')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Failure reasons' })).not.toBeInTheDocument()
  })

  it('a run waiting on the person says Needs you, never the node id it paused at', async () => {
    const question = { stepId: 'clarify', requestedAt: '2026-09-12T00:00:00.000Z', question: 'Which cache backend?' }
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ engineVersion: 2, nextStep: 'clarify', pendingQuestion: question })] }))
    renderHeader(failedJob, [], { projectId: 'p1' })
    expect(await screen.findByText('Needs you')).toBeInTheDocument()
    expect(screen.queryByText(/clarify/)).not.toBeInTheDocument()
  })

  it('keeps chrome compact without an inline diagnosis or Details', () => {
    renderHeader(failedJob)
    const chrome = screen.getByTestId('run-detail-bar')
    expect(within(chrome).queryByRole('button', { name: 'Details' })).not.toBeInTheDocument()
    expect(within(chrome).queryByTestId('failure-diagnosis-card')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Log' })).toBeVisible()
  })

  it('renders the runtime metrics inside Details, without an evidence panel the run has no evidence for', async () => {
    const total = { attempts: 1, measuredAttempts: 1, durationMs: 12000, agentDurationMs: 8000, providerCalls: 1, toolCalls: 7, inputTokens: 100, outputTokens: 10, costUsd: 1.25, uncachedInputTokens: 20, cacheReadInputTokens: 80, cacheWriteInputTokens: 0 }
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ status: 'succeeded', nextStep: null, canResume: false, historical: true, metrics: { schemaVersion: 1, total, phases: [] } })] }))
    renderHeader(completedJob, [], { projectId: 'p1' })
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
    expect(await screen.findByRole('region', { name: 'Implementation' })).toBeInTheDocument()
    fireEvent.click(screen.getByText('Usage and time'))
    expect(screen.getByText('Agent time').nextElementSibling).toHaveTextContent('8s')
    expect(screen.queryByText('Verification evidence')).not.toBeInTheDocument()
  })
})

describe('JobRunHeader outcome peak', () => {
  it('shows the final duration, cost and arrival mark only once completed', () => {
    const done: JobSummary = { ...runningJob, started_at: '2026-07-27T10:00:00Z', finished_at: '2026-07-27T10:01:02Z', status: 'completed', total_cost_usd: 0.42 }
    renderHeader(done, [])
    const outcome = screen.getByTestId('job-run-outcome')
    expect(outcome).toHaveTextContent('1m 2s')
    expect(outcome).toHaveTextContent('$0.42')
    expect(screen.getByTestId('rail-mark')).toHaveAttribute('data-state', 'arrive')
  })

  it('has no outcome block while running', () => {
    renderHeader({ ...runningJob, started_at: new Date().toISOString() }, [])
    expect(screen.queryByTestId('job-run-outcome')).toBeNull()
  })
})

describe('JobRunHeader failure diagnosis', () => {
  const diagnosed = (failureDiagnosis: unknown, status: JobSummary['status'] = 'failed'): JobSummary => ({ ...failedJob, status, finished_at: '2024-03-21T11:05:00Z', failureDiagnosis })
  const tests = { kind: 'tests_failed', confidence: 'high', phase: 'reviewer', rounds: 4, resetAt: null, detail: null, resumablePhase: 'fixer', blocker: null, source: 'core', remedies: ['resume', 'edit-spec', 'open-logs', 'retry'] }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    global.fetch = vi.fn().mockResolvedValue(response({ runs: [] }))
  })

  it('starts a failed job\'s terminal state with the diagnosis card, in plain words', () => {
    renderHeader(diagnosed(tests), [], { onOpenLogs: vi.fn() })
    expect(screen.getByRole('region', { name: 'Tests failed in the Reviewer phase after 4 fix rounds' })).toBeInTheDocument()
  })

  it('shows nothing for a job that did not fail or carries no diagnosis', () => {
    renderHeader({ ...completedJob, failureDiagnosis: tests })
    expect(screen.queryByTestId('failure-diagnosis-card')).toBeNull()
    renderHeader(diagnosed(null))
    expect(screen.queryByTestId('failure-diagnosis-card')).toBeNull()
    renderHeader({ ...failedJob, started_at: new Date().toISOString(), status: 'running', failureDiagnosis: tests })
    expect(screen.queryByTestId('failure-diagnosis-card')).toBeNull()
  })

  it('wires the surface\'s real actions: run again, edit spec and open logs', async () => {
    const user = userEvent.setup()
    const onRerun = vi.fn(), onEditSpec = vi.fn(), onOpenLogs = vi.fn()
    renderHeader(diagnosed({ ...tests, resumablePhase: null, remedies: ['edit-spec', 'open-logs', 'retry'] }), [], { onRerun, onEditSpec, onOpenLogs })
    const card = screen.getByTestId('failure-diagnosis-card')
    await user.click(within(card).getByRole('button', { name: 'Edit spec and relaunch' }))
    await user.click(within(card).getByRole('button', { name: 'Open logs at the failure' }))
    await waitFor(() => expect(onOpenLogs).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('tab', { name: 'Failure reasons' }))
    // Start over waits in the card's menu, with its warning.
    await user.click(within(card).getByTestId('failure-remedy-more'))
    await user.click(await screen.findByTestId('failure-remedy-retry'))
    expect(onEditSpec).toHaveBeenCalledTimes(1)
    expect(onOpenLogs).toHaveBeenCalledTimes(1)
    expect(onRerun).toHaveBeenCalledTimes(1)
  })

  it('tells the surface when the card already offers the retry, so it can drop its own duplicate button', () => {
    const seen: boolean[] = []
    const actions = ({ diagnosisOffersRetry }: { diagnosisOffersRetry: boolean }) => { seen.push(diagnosisOffersRetry); return null }
    // retry is a ranked remedy and the surface can rerun -> offered by the card
    renderHeader(diagnosed({ ...tests, resumablePhase: null, remedies: ['retry', 'open-logs'] }), [], { onRerun: vi.fn(), onOpenLogs: vi.fn(), actions })
    expect(seen[seen.length - 1]).toBe(true)
    // the surface cannot rerun (the modal): the card does not offer it, so the surface keeps nothing to hide
    seen.length = 0
    renderHeader(diagnosed({ ...tests, resumablePhase: null, remedies: ['retry', 'open-logs'] }), [], { onOpenLogs: vi.fn(), actions })
    expect(seen[seen.length - 1]).toBe(false)
    // no diagnosis at all
    seen.length = 0
    renderHeader(diagnosed(null), [], { onRerun: vi.fn(), actions })
    expect(seen[seen.length - 1]).toBe(false)
  })

  it('continues a run that is not a definition run through its in-place resume', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ status: 'failed', nextStep: 'fixer' })] }))
    renderHeader(diagnosed(tests), [], { projectId: 'p1', onOpenLogs: vi.fn() })
    const card = await screen.findByTestId('failure-diagnosis-card')
    await user.click(await within(card).findByRole('button', { name: 'Continue from Fixer' }))
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs/job-1/resume', expect.objectContaining({ method: 'POST', body: '{}' }))
  })

  it('continues a definition run through the Continue remedy, which keeps its work', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ engineVersion: 2, status: 'failed', nextStep: 'fixer', canResume: false })] }))
    renderHeader(diagnosed(tests), [], { projectId: 'p1', onOpenLogs: vi.fn() })
    const card = await screen.findByTestId('failure-diagnosis-card')
    await user.click(await within(card).findByRole('button', { name: 'Continue from Fixer' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/projects/p1/loop-runs/job-1/remedy'), expect.objectContaining({ method: 'POST', body: JSON.stringify({ remedy: 'continue' }) })))
  })

  it('offers Continue for a stopped run the runtime list no longer shows, from the run\'s own record', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => String(url).includes('/attempts') ? response({ chain: null, continuable: true }) : response({ runs: [] }))
    renderHeader({ ...failedJob, command: 'loop:factory:implement #16', status: 'canceled', failureDiagnosis: null }, [], { projectId: 'p1', onOpenLogs: vi.fn() })
    await screen.findByTestId('stopped-run-card')
    expect(screen.getByRole('tab', { name: 'Continue' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.setup().click(screen.getByTestId('failure-remedy-continue'))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/loop-runs/job-2/remedy'), expect.objectContaining({ method: 'POST' })))
  })

  it('offers Continue for a run the person stopped, with Start over apart', async () => {
    const user = userEvent.setup()
    const onRerun = vi.fn()
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ engineVersion: 2, status: 'cancelled', canResume: false })] }))
    renderHeader({ ...failedJob, status: 'canceled', failureDiagnosis: null }, [], { projectId: 'p1', onOpenLogs: vi.fn(), onRerun })
    const card = await screen.findByTestId('stopped-run-card')
    expect(card).toHaveTextContent('You stopped this run')
    expect(within(card).getByTestId('failure-remedy-consequence-continue')).toHaveTextContent('Picks it up where it stopped, in the same worktree')
    await user.click(within(card).getByTestId('failure-remedy-continue'))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/loop-runs/job-1/remedy'), expect.objectContaining({ body: JSON.stringify({ remedy: 'continue' }) })))
    expect(onRerun).not.toHaveBeenCalled()
  })

  it('offers no resume when the run cannot resume', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ status: 'failed', canResume: false })] }))
    renderHeader(diagnosed(tests), [], { projectId: 'p1', onOpenLogs: vi.fn() })
    const card = await screen.findByTestId('failure-diagnosis-card')
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(within(card).queryByRole('button', { name: /Continue/ })).toBeNull()
  })

  it('says "Unknown cause" with the raw tail of the log instead of inventing a diagnosis', () => {
    const events: EventRow[] = [{ id: 1, job_id: 'job-2', seq: 1, event_type: 'log', payload: JSON.stringify({ line: 'boom: segfault in worker\nexit 139' }), timestamp: '' }]
    renderHeader(diagnosed({ ...tests, kind: 'unknown', confidence: 'low', remedies: ['open-logs', 'retry'] }), events, { onOpenLogs: vi.fn() })
    expect(screen.getByTestId('failure-headline')).toHaveTextContent('Unknown cause')
    expect(screen.getByTestId('failure-log-tail')).toHaveTextContent('boom: segfault in worker')
  })

  it('shows the card for a stalled (canceled) job such as a provider limit', () => {
    renderHeader(diagnosed({ ...tests, kind: 'provider_limit', phase: null, rounds: null, resetAt: '3am (Europe/Madrid)', remedies: ['resume', 'retry', 'open-logs'] }, 'canceled'), [], { onOpenLogs: vi.fn() })
    expect(screen.getByTestId('failure-why')).toHaveTextContent('It resets 3am (Europe/Madrid).')
  })
})

describe('JobRunHeader evidence chip and run instructions', () => {
  const summary = { schemaVersion: 1, runId: 'job-1', workflowVersion: '1', technicalAcceptance: 'validated', archive: 'a', delivery: 'd', currentEvidenceIds: [], planHash: null, candidateHash: null, roles: [], invocations: { total: 2, complete: true, byKind: {}, promptBytes: null, contextBytes: null, handoffBytes: null, fullContexts: 1, incrementalContexts: 1 }, checks: { available: true, executed: 2, reused: 1, notRun: 0, durationMs: null } }
  const steering = (overrides = {}) => ({ receipts: [], pending: 0, consumed: 0, consumptionReported: true, ...overrides })
  const live = (overrides = {}) => run({ engineVersion: 2, status: 'running', active: true, canResume: false, canCancel: true, steering: steering(), ...overrides })
  const loopRunning: JobSummary = { ...runningJob, id: 'job-1', command: 'loop: Implement' }
  const acceptedAt = '2026-11-18T10:00:00.000Z'

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('shows no evidence chip without recorded evidence', async () => {
    global.fetch = vi.fn().mockResolvedValue(response({ runs: [live()] }))
    renderHeader(loopRunning, [], { projectId: 'p1' })
    await screen.findByTestId('run-steering')
    expect(screen.queryByTestId('run-evidence-chip')).not.toBeInTheDocument()
    expect(screen.queryByText('Verification evidence')).not.toBeInTheDocument()
  })

  it('[spec:job-run-detail-navigation/failure-information-cannot-displace-navigation] shows the evidence chip in the header row and opens the evidence in a popover', async () => {
    const user = userEvent.setup()
    global.fetch = vi.fn(async (url: RequestInfo | URL) => String(url).includes('/evidence')
      ? response({ schemaVersion: 1, available: true, items: [{ id: 'c1', label: 'npm test', repositoryId: 'repo', status: 'passed', disposition: 'executed', planHash: 'p', candidateHash: 'c', sources: [] }] })
      : response({ runs: [live({ efficiencySummary: summary })] })) as typeof fetch
    renderHeader(loopRunning, [], { projectId: 'p1' })
    const chip = await screen.findByTestId('run-evidence-chip')
    expect(screen.getByTestId('run-detail-meta')).toContainElement(chip)
    expect(chip).toHaveAccessibleName('Verification evidence: Validated · 3 checks')
    expect(chip.querySelector('[data-run-state]')).toHaveAttribute('data-run-state', 'done')
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/evidence'), expect.anything())
    await user.click(chip)
    const popover = screen.getByRole('dialog', { name: 'Verification evidence' })
    expect(await within(popover).findByText('repo · npm test')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Verification evidence' })).not.toBeInTheDocument()
    expect(chip).toHaveFocus()
  })

  it('[spec:job-run-detail-navigation/run-instructions-dock-under-the-log] docks the composer under the log only while the run accepts instructions', async () => {
    global.fetch = vi.fn().mockResolvedValue(response({ runs: [live()] }))
    const view = renderHeader(loopRunning, [], { projectId: 'p1' })
    const composer = await screen.findByTestId('run-steering')
    expect(screen.getByTestId('run-composer-dock')).toContainElement(composer)
    expect(screen.getByLabelText('Additional instructions')).toHaveAttribute('placeholder', 'Tell the agent something for its next step…')
    expect(screen.getByLabelText('Additional instructions')).toHaveAccessibleDescription("Applied at the agent's next compatible turn; it doesn't answer questions or grant approvals.")
    expect(screen.queryByTestId('run-steering-chip')).not.toBeInTheDocument()
    view.unmount()

    // Old Core: no steering contract, no composer.
    global.fetch = vi.fn().mockResolvedValue(response({ runs: [live({ engineVersion: 1 })] }))
    const old = renderHeader(loopRunning, [], { projectId: 'p1' })
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByTestId('run-steering')).not.toBeInTheDocument()
    old.unmount()

    // Settled without instructions: nothing at all.
    global.fetch = vi.fn().mockResolvedValue(response({ runs: [live({ status: 'succeeded', active: false, canCancel: false })] }))
    renderHeader(completedJob, [], { projectId: 'p1' })
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByTestId('run-composer-dock')).not.toBeInTheDocument()
    expect(screen.queryByTestId('run-steering-chip')).not.toBeInTheDocument()
  })

  it('sends with Cmd/Ctrl+Enter (Enter alone adds a line) and shows the queued chip', async () => {
    const user = userEvent.setup()
    let runs = [live()]
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const { requestId, text } = JSON.parse(String(init.body))
        runs = [live({ steering: steering({ pending: 1, receipts: [{ id: requestId, acceptedAt, preview: text, length: text.length, status: 'pending' }] }) })]
        return response({ id: requestId, acceptedAt })
      }
      return response({ runs })
    }) as typeof fetch
    renderHeader(loopRunning, [], { projectId: 'p1' })
    const field = await screen.findByLabelText('Additional instructions')
    await user.type(field, 'Keep the API{Enter}stable')
    expect(field).toHaveValue('Keep the API\nstable')
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/steer'), expect.anything())
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs/job-1/steer', expect.objectContaining({ method: 'POST' })))
    await waitFor(() => expect(field).toHaveValue(''))
    const chip = await screen.findByTestId('run-steering-chip')
    expect(chip).toHaveTextContent('1 queued')
    expect(chip.querySelector('[data-run-state]')).toHaveAttribute('data-run-state', 'queued')
    await user.click(chip)
    const list = screen.getByRole('dialog', { name: 'Sent instructions' })
    expect(list).toHaveTextContent('Keep the API')
    expect(list).toHaveTextContent("Queued for the agent's next turn")
  })

  it('shows a settled run\'s instructions as a read-only applied chip beside the tabs', async () => {
    const user = userEvent.setup()
    global.fetch = vi.fn().mockResolvedValue(response({ runs: [live({ status: 'succeeded', active: false, canCancel: false, steering: steering({ consumed: 1, receipts: [{ id: 'm1', acceptedAt, preview: 'Keep compatibility', length: 18, status: 'consumed', consumedAttemptId: 'a7' }] }) })] }))
    renderHeader(completedJob, [], { projectId: 'p1' })
    const chip = await screen.findByTestId('run-steering-chip')
    expect(screen.getByTestId('run-detail-meta')).toContainElement(chip)
    expect(chip).toHaveTextContent('1 applied')
    expect(chip.querySelector('[data-run-state]')).toHaveAttribute('data-run-state', 'done')
    expect(screen.queryByLabelText('Additional instructions')).not.toBeInTheDocument()
    await user.click(chip)
    expect(screen.getByRole('dialog', { name: 'Sent instructions' })).toHaveTextContent('Applied by the agent')
  })
})
