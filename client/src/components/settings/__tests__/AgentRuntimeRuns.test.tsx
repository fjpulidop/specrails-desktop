import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, act } from '../../../test-utils'
import { AgentRuntimeRuns } from '../AgentRuntimeRuns'

const run = (overrides = {}) => ({ runId: 'run-1', status: 'paused', nextStep: 'archive', canResume: true, canCancel: false, active: false, recoverableSteps: [], ...overrides })
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response
beforeEach(() => { vi.clearAllMocks(); global.fetch = vi.fn().mockResolvedValue(response({ runs: [] })) })

describe('AgentRuntimeRuns', () => {
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
    await user.click(screen.getByRole('button', { name: 'Approve completion' }))
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
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load saved executions')
    vi.mocked(fetch).mockResolvedValueOnce(response({ runs: [run()] }))
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await screen.findByRole('button', { name: 'Resume' })
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: 'Original worktree is unavailable' }, false))
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Original worktree is unavailable')
    vi.mocked(fetch).mockResolvedValueOnce(response({}, false))
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update this execution')
  })

  it('recovers an interrupted approved archive before presenting another approval action', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ status: 'interrupted', recoverableSteps: ['archive'], pendingApproval: { stepId: 'archive', reason: 'Approval was already granted' } })] }))
    render(<AgentRuntimeRuns projectId="p1" />)
    await user.click(await screen.findByRole('button', { name: 'Recover interrupted phase' }))
    expect(screen.queryByRole('button', { name: 'Approve completion' })).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs/run-1/resume', expect.objectContaining({ method: 'POST', body: JSON.stringify({ recover: ['archive'] }) }))
  })

  it('shows the architect question and resumes only with a typed answer', async () => {
    const user = userEvent.setup()
    const question = { stepId: 'architect', requestedAt: '2026-09-12T00:00:00.000Z', question: 'Which cache backend should the design assume?' }
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ nextStep: 'architect', pendingQuestion: question })] }))
    render(<AgentRuntimeRuns projectId="p1" />)
    expect(await screen.findByText('Which cache backend should the design assume?')).toBeInTheDocument()
    expect(screen.getByText('The architect asks:')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
    const answer = screen.getByRole('button', { name: 'Answer and resume' })
    expect(answer).toBeDisabled()
    await user.type(screen.getByLabelText('Your answer'), '   ')
    expect(answer).toBeDisabled()
    await user.type(screen.getByLabelText('Your answer'), 'Redis, keep the schema ')
    await user.click(answer)
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/runs/run-1/resume', expect.objectContaining({ method: 'POST', body: JSON.stringify({ answer: 'Redis, keep the schema' }) }))
    await waitFor(() => expect(screen.getByLabelText('Your answer')).toHaveValue(''))
    // A rejected answer keeps the draft for correction.
    await user.type(screen.getByLabelText('Your answer'), 'Retry')
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: 'answer_required', message: 'Answer first' }, false))
    await user.click(screen.getByRole('button', { name: 'Answer and resume' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Answer first')
    expect(screen.getByLabelText('Your answer')).toHaveValue('Retry')
    // An interrupted answer step is recovered before asking again.
    vi.mocked(fetch).mockResolvedValue(response({ runs: [run({ status: 'interrupted', recoverableSteps: ['architect'], pendingQuestion: question })] }))
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await screen.findByRole('button', { name: 'Recover interrupted phase' })
    expect(screen.queryByLabelText('Your answer')).not.toBeInTheDocument()
  })

  it('ignores in-flight responses after a project pane unmounts and polls without overlapping reads', async () => {
    let finish!: (value: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const view = render(<AgentRuntimeRuns projectId="p1" />)
    expect(screen.getByText('No saved runtime executions.')).toBeInTheDocument()
    view.unmount()
    await act(async () => finish(response({ runs: [run()] })))
    render(<AgentRuntimeRuns projectId="p2" />)
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith('/api/projects/p2/agent-runtime/runs', { cache: 'no-store' }))
    expect(screen.queryByText('run-1')).not.toBeInTheDocument()
  })
})
