import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, act } from '../../../../test-utils'
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), toast), Toaster: () => null }))
import { AgentRuntimeRuns } from '../AgentRuntimeRuns'

const run = (overrides = {}) => ({ runId: 'run-1', status: 'paused', nextStep: 'archive', canResume: true, canCancel: false, active: false, recoverableSteps: [], ...overrides })
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response
beforeEach(() => { vi.clearAllMocks(); Object.values(toast).forEach((f) => f.mockClear()); global.fetch = vi.fn().mockResolvedValue(response({ runs: [] })) })

describe('AgentRuntimeRuns', () => {
  it('recovers v2 through the definition lifecycle with exact attempt IDs', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ engineVersion: 2, recoverableSteps: ['attempt-7'], status: 'interrupted' })] }))
    render(<AgentRuntimeRuns projectId="p1" />)
    await user.click(await screen.findByRole('checkbox', { name: 'attempt-7' }))
    await user.click(await screen.findByRole('button', { name: 'Recover interrupted phase' }))
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/loop-runs/run-1/resume', expect.objectContaining({ method: 'POST', body: JSON.stringify({ recover: ['attempt-7'] }) }))
  })

  it('retries v2 settlement through the original definition lifecycle', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ engineVersion: 2, status: 'succeeded', canResume: false, canSettle: true })] }))
    render(<AgentRuntimeRuns projectId="p1" />)
    await user.click(await screen.findByRole('button', { name: 'Prepare delivery' }))
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/loop-runs/run-1/resume', expect.objectContaining({ method: 'POST', body: '{}' }))
  })
  it('ignores a failed action response after switching projects', async () => {
    const user = userEvent.setup()
    let fail!: (value: Response) => void
    vi.mocked(fetch).mockImplementation(async (_url, options) => options?.method === 'POST'
      ? new Promise<Response>(resolve => { fail = resolve })
      : response({ runs: [run()] }))
    const view = render(<AgentRuntimeRuns projectId="p1" />)
    await user.click(await screen.findByRole('button', { name: 'Resume' }))
    view.rerender(<AgentRuntimeRuns projectId="p2" />)
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/p2/agent-runtime/runs', expect.anything()))
    await act(async () => fail(response({ message: 'Old project failure' }, false)))
    expect(screen.queryByText('Old project failure')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled()
  })

  it('cancels v2 through the definition lifecycle', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ engineVersion: 2, canResume: false, canCancel: true, active: true })] }))
    render(<AgentRuntimeRuns projectId="p1" />)
    await user.click(await screen.findByRole('button', { name: 'Cancel continuation' }))
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/loop-runs/run-1/cancel', expect.objectContaining({ method: 'POST', body: '{}' }))
  })

  it('prepares an already completed runtime delivery without resuming the agents', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ status: 'succeeded', nextStep: null, canResume: false, canSettle: true })] }))
    render(<AgentRuntimeRuns projectId="p1" jobId="run-1" contextual />)
    await user.click(await screen.findByRole('button', { name: 'Prepare delivery' }))
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs/run-1/settle', expect.objectContaining({ method: 'POST' }))
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
  })
  it('shows contextual continuation on the job and scopes its request to that execution', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ nextStep: 'developer', status: 'failed' })] }))
    render(<AgentRuntimeRuns projectId="p1" jobId="run-1" contextual />)
    expect(await screen.findByText('Implementation')).toBeInTheDocument()
    expect(screen.getByText(/preserving your existing work/)).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs/run-1', expect.anything())
    expect(screen.queryByRole('link', { name: 'View job log' })).not.toBeInTheDocument()
    expect(screen.queryByText('Saved executions')).not.toBeInTheDocument()
  })
  it('keeps legacy cards empty and looks up the original rail identity', async () => {
    const { container } = render(<AgentRuntimeRuns projectId="p1" railIndex={3} contextual />)
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs?railIndex=3', expect.anything()))
    expect(container).toBeEmptyDOMElement()
  })
  it('displays saved phase state and sends only the explicit approval step', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ pendingApproval: { stepId: 'archive', reason: 'Review before completion' } })] }))
    render(<AgentRuntimeRuns projectId="p1" />)
    expect(await screen.findByText('Next phase: Completion')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View job log' })).toHaveAttribute('href', '/jobs/run-1')
    expect(screen.getByText('Review before completion')).toBeInTheDocument()
    expect(screen.getByText(/original worktree/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs/run-1/resume', expect.objectContaining({ method: 'POST', body: JSON.stringify({ approve: ['archive'] }) }))
  })

  it('offers recovery for interrupted steps, ordinary resume for failures, and cancellation only for owned continuations', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ status: 'interrupted', nextStep: 'developer', recoverableSteps: ['developer'], error: 'Provider stopped' })] }))
    render(<AgentRuntimeRuns projectId="p1" />)
    await user.click(await screen.findByRole('button', { name: 'Recover interrupted phase' }))
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs/run-1/resume', expect.objectContaining({ body: JSON.stringify({ recover: ['developer'] }) }))
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ status: 'failed' })] }))
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await user.click(await screen.findByRole('button', { name: 'Resume' }))
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs/run-1/resume', expect.objectContaining({ body: '{}' }))
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ status: 'running', canResume: false, canCancel: true, active: true })] }))
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel continuation' }))
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs/run-1/cancel', expect.objectContaining({ method: 'POST', body: '{}' }))
  })

  it('reports list/action failures and refreshes without inventing success', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch).mockResolvedValueOnce(response({}, false))
    render(<AgentRuntimeRuns projectId="p1" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load saved runs')
    vi.mocked(fetch).mockResolvedValueOnce(response({ runs: [run()] }))
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await screen.findByRole('button', { name: 'Resume' })
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: 'Original worktree is unavailable' }, false))
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    // An action failure is a toast with a localized headline, never the load banner.
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(toast.error).toHaveBeenLastCalledWith('Could not update this run.', expect.objectContaining({ description: 'Original worktree is unavailable', action: expect.objectContaining({ label: 'Retry' }) }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // Retry repeats the ACTION (a second resume POST), not a list reload.
    const retry = toast.error.mock.calls[0][1].action.onClick as () => void
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockResolvedValueOnce(response({}, false))
    act(() => retry())
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs/run-1/resume', expect.objectContaining({ method: 'POST' })))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2))
    expect(toast.error).toHaveBeenLastCalledWith('Could not update this run.', expect.not.objectContaining({ description: expect.anything() }))
  })

  it('recovers an interrupted approved archive before presenting another approval action', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ status: 'interrupted', recoverableSteps: ['archive'], pendingApproval: { stepId: 'archive', reason: 'Approval was already granted' } })] }))
    render(<AgentRuntimeRuns projectId="p1" />)
    await user.click(await screen.findByRole('button', { name: 'Recover interrupted phase' }))
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs/run-1/resume', expect.objectContaining({ method: 'POST', body: JSON.stringify({ recover: ['archive'] }) }))
  })

  it('shows the question as its card, answers inline, keeps a refused draft and recovers an interrupted step first', async () => {
    const user = userEvent.setup()
    const question = { stepId: 'architect', requestedAt: '2026-09-12T00:00:00.000Z', question: 'Which cache backend should the design assume?' }
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ nextStep: 'architect', pendingQuestion: question })] }))
    render(<AgentRuntimeRuns projectId="p1" />)
    expect(await screen.findByTestId('run-question-card')).toHaveTextContent('Which cache backend should the design assume?')
    expect(screen.getByRole('heading', { name: 'The run needs your answer' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
    const send = screen.getByTestId('run-question-send')
    expect(send).toBeDisabled()
    await user.type(screen.getByTestId('run-question-input'), '   ')
    expect(send).toBeDisabled()
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: 'answer_required', message: 'Answer first' }, false))
    await user.type(screen.getByTestId('run-question-input'), 'Redis, keep the schema ')
    await user.click(send)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't send your answer", expect.objectContaining({ description: 'Answer first' })))
    expect(screen.getByTestId('run-question-input')).toHaveValue('   Redis, keep the schema ')
    await user.click(screen.getByTestId('run-question-send'))
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs/run-1/resume', expect.objectContaining({ method: 'POST', body: JSON.stringify({ answer: 'Redis, keep the schema' }) }))
    // An interrupted answer step is recovered before asking again.
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ status: 'interrupted', recoverableSteps: ['architect'], pendingQuestion: question })] }))
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await screen.findByRole('button', { name: 'Recover interrupted phase' })
    expect(screen.queryByTestId('run-question-input')).not.toBeInTheDocument()
  })

  it('ignores in-flight responses after a project pane unmounts and polls without overlapping reads', async () => {
    let finish!: (value: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const view = render(<AgentRuntimeRuns projectId="p1" />)
    expect(screen.getByText('No saved runtime runs.')).toBeInTheDocument()
    view.unmount()
    await act(async () => finish(response({ runs: [run()] })))
    render(<AgentRuntimeRuns projectId="p2" />)
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith('/api/projects/p2/agent-runtime/runs', { cache: 'no-store' }))
    expect(screen.queryByText('run-1')).not.toBeInTheDocument()
  })
})
