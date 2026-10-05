import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '../../../../../test-utils'
import { SharedWebSocketContext } from '../../../../../hooks/useSharedWebSocket'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('../../../lib/jira-api', () => ({ jiraApi: { listOutbox: vi.fn(), retryOutbox: vi.fn() } }))

import { JiraOutboxPanel } from '../JiraOutboxPanel'
import { jiraApi, type OutboxCounts, type OutboxOp } from '../../../lib/jira-api'

const api = vi.mocked(jiraApi)
const counts: OutboxCounts = { pending: 0, inflight: 0, done: 0, dead: 0, superseded: 0 }
const props = { projectId: 'p1', baseUrl: 'https://jira.example.test', apiBase: '/api/projects/p1', refreshToken: 0, initialCounts: counts }
function op(patch: Partial<OutboxOp> = {}): OutboxOp {
  return { id: 7, jiraIssueId: '10007', opType: 'transition', state: 'dead', attempts: 1, deadReason: 'No permitted transition', lastError: null, createdAt: '', updatedAt: '', ...patch }
}

describe('JiraOutboxPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.listOutbox.mockResolvedValue({ ops: [], counts })
    api.retryOutbox.mockResolvedValue({ ok: true })
  })

  it('shows issue IDs on older server responses and labels edits correctly', async () => {
    api.listOutbox.mockResolvedValue({ ops: [op({ opType: 'update' })], counts: { ...counts, dead: 1 } })
    render(<JiraOutboxPanel {...props} />)
    expect(await screen.findByText('Jira issue 10007')).toBeInTheDocument()
    expect(screen.getByText(/Issue update/)).toBeInTheDocument()
    expect(screen.queryByText(/Create issue/)).not.toBeInTheDocument()
  })

  it('keeps superseded history out of the actionable list and counts', async () => {
    api.listOutbox.mockResolvedValue({ ops: [op({ state: 'superseded' })], counts: { ...counts, superseded: 28 } })
    render(<JiraOutboxPanel {...props} />)
    await waitFor(() => expect(api.listOutbox).toHaveBeenCalled())
    expect(await screen.findByText('No pending Jira updates')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('loads authoritative rows again when the parent receives newer counts', async () => {
    const { rerender } = render(<JiraOutboxPanel {...props} />)
    await waitFor(() => expect(api.listOutbox).toHaveBeenCalledTimes(1))
    api.listOutbox.mockResolvedValue({ ops: [op({ jiraKey: 'OPS-7', logicalState: 'todo' })], counts: { ...counts, dead: 1 } })
    rerender(<JiraOutboxPanel {...props} initialCounts={{ ...counts, dead: 1 }} />)
    expect(await screen.findByRole('link', { name: 'OPS-7' })).toBeInTheDocument()
    expect(screen.getByText('Target: Backlog / To Do')).toBeInTheDocument()
    expect(api.listOutbox).toHaveBeenCalledTimes(2)
  })

  it('rejects an older outbox response that resolves after the refresh', async () => {
    let resolveOld!: (value: { ops: OutboxOp[]; counts: OutboxCounts }) => void
    api.listOutbox.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    const { rerender } = render(<JiraOutboxPanel {...props} />)
    api.listOutbox.mockResolvedValue({ ops: [op({ jiraKey: 'OPS-NEW' })], counts: { ...counts, dead: 1 } })
    rerender(<JiraOutboxPanel {...props} refreshToken={1} />)
    await screen.findByRole('link', { name: 'OPS-NEW' })
    await act(async () => { resolveOld({ ops: [op({ jiraKey: 'OPS-OLD' })], counts: { ...counts, dead: 9 } }) })
    expect(screen.queryByRole('link', { name: 'OPS-OLD' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'OPS-NEW' })).toBeInTheDocument()
  })

  it('shows a load error and retries instead of silently losing the failures', async () => {
    api.listOutbox.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({ ops: [op()], counts: { ...counts, dead: 1 } })
    render(<JiraOutboxPanel {...props} />)
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load pending Jira updates")
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Jira issue 10007')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not reload another project when an old retry completes after unmount', async () => {
    let completeRetry!: (value: { ok: true }) => void
    api.retryOutbox.mockImplementationOnce(() => new Promise((resolve) => { completeRetry = resolve }))
    api.listOutbox.mockResolvedValue({ ops: [op()], counts: { ...counts, dead: 1 } })
    const { unmount } = render(<JiraOutboxPanel {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled()
    unmount()
    await act(async () => { completeRetry({ ok: true }) })
    expect(api.listOutbox).toHaveBeenCalledTimes(1)
  })

  it('refreshes on outbox completion events for this project only and unregisters', async () => {
    const handlers = new Map<string, (message: unknown) => void>()
    const ws = { registerHandler: vi.fn((id: string, fn: (message: unknown) => void) => { handlers.set(id, fn) }), unregisterHandler: vi.fn((id: string) => { handlers.delete(id) }), connectionStatus: 'connected' as const }
    const { unmount } = render(<SharedWebSocketContext.Provider value={ws}><JiraOutboxPanel {...props} /></SharedWebSocketContext.Provider>)
    await waitFor(() => expect(api.listOutbox).toHaveBeenCalledTimes(1))
    await act(async () => { for (const handler of handlers.values()) handler({ type: 'jira.outbox_changed', projectId: 'other' }) })
    expect(api.listOutbox).toHaveBeenCalledTimes(1)
    api.listOutbox.mockResolvedValue({ ops: [op({ jiraKey: 'OPS-7' })], counts: { ...counts, dead: 1 } })
    await act(async () => { for (const handler of handlers.values()) handler({ type: 'jira.outbox_changed', projectId: 'p1' }) })
    expect(await screen.findByRole('link', { name: 'OPS-7' })).toBeInTheDocument()
    unmount()
    expect(handlers.size).toBe(0)
  })
})
