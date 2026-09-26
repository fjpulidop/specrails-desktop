import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { act, render, screen, waitFor } from '../../../../test-utils'
import { RuntimeSteering } from '../RuntimeSteering'
import type { RuntimeRun } from '../../lib/agent-runtime'

const run = (overrides: Partial<RuntimeRun> = {}): RuntimeRun => ({ runId: 'r1', engineVersion: 2, status: 'running', nextStep: 'build', active: true, canCancel: false, canResume: false, recoverableSteps: [], steering: { receipts: [], pending: 0, consumed: 0, consumptionReported: true }, ...overrides })
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response
const acceptedAt = '2026-09-26T12:00:00.000Z'
beforeEach(() => { vi.clearAllMocks(); global.fetch = vi.fn() })

describe('durable runtime steering', () => {
  it('reuses the request identity after an uncertain response and only claims acceptance', async () => {
    const user = userEvent.setup(), refresh = vi.fn()
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Connection lost')).mockImplementation(async (_url, init) => response({ id: JSON.parse(String(init?.body)).requestId, acceptedAt }))
    render(<RuntimeSteering projectId="p1" run={run()} onAccepted={refresh} />)
    await user.type(screen.getByLabelText('Additional instructions'), 'Keep the existing API')
    await user.click(screen.getByRole('button', { name: 'Send instructions' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost')
    await user.click(screen.getByRole('button', { name: 'Send instructions' }))
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    const calls = vi.mocked(fetch).mock.calls
    expect(calls[0][0]).toBe('/api/projects/p1/agent-runtime/runs/r1/steer')
    expect(calls[0][1]?.body).toBe(calls[1][1]?.body)
    expect(screen.getByRole('status')).toHaveTextContent('Accepted by Core; awaiting consumption.')
    expect(screen.getByLabelText('Additional instructions')).toHaveValue('')
    expect(screen.queryByText('Consumed by an agent')).not.toBeInTheDocument()
  })
  it('allocates a new identity for edited text and preserves a rejected draft', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch).mockResolvedValue(response({ message: 'Inbox full' }, false))
    render(<RuntimeSteering projectId="p1" run={run()} onAccepted={() => {}} />)
    const draft = screen.getByLabelText('Additional instructions')
    await user.type(draft, 'First')
    await user.click(screen.getByRole('button', { name: 'Send instructions' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Inbox full')
    expect(draft).toHaveValue('First')
    await user.type(draft, ' revised')
    await user.click(screen.getByRole('button', { name: 'Send instructions' }))
    const bodies = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies[0].requestId).not.toBe(bodies[1].requestId)
    expect(bodies[1].text).toBe('First revised')
  })
  it('shows authoritative consumption and keeps receipts on terminal runs without a send action', () => {
    render(<RuntimeSteering projectId="p1" run={run({ status: 'succeeded', steering: { receipts: [{ id: 'm1', acceptedAt, preview: 'Keep compatibility', length: 18, status: 'consumed', consumedAttemptId: 'attempt-7', consumedAt: acceptedAt }], pending: 0, consumed: 1, consumptionReported: true, truncated: true } })} onAccepted={() => {}} />)
    expect(screen.getByText('Consumed by an agent', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('attempt-7')).toBeInTheDocument()
    expect(screen.getByText('Pending: 0 · Consumed: 1')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('does not leak a draft or a late acceptance across project switches', async () => {
    const user = userEvent.setup(), refresh = vi.fn()
    let finish!: (value: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<RuntimeSteering projectId="p1" run={run()} onAccepted={refresh} />)
    await user.type(screen.getByLabelText('Additional instructions'), 'Private project note')
    await user.click(screen.getByRole('button', { name: 'Send instructions' }))
    const id = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).requestId
    view.rerender(<RuntimeSteering projectId="p2" run={run()} onAccepted={refresh} />)
    await act(async () => { finish(response({ id, acceptedAt })) })
    expect(screen.getByLabelText('Additional instructions')).toHaveValue('')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })
  it('hides steering for old Core and never infers consumption from active state', () => {
    const view = render(<RuntimeSteering projectId="p1" run={run({ engineVersion: 1 })} onAccepted={() => {}} />)
    expect(view.container).toBeEmptyDOMElement()
    view.rerender(<RuntimeSteering projectId="p1" run={run({ steering: { receipts: [{ id: 'm1', acceptedAt, preview: 'Pending instruction', length: 19, status: 'pending' }], pending: 1, consumed: 0, consumptionReported: false } })} onAccepted={() => {}} />)
    expect(screen.getByText('This Core version does not report consumption.')).toBeInTheDocument()
    expect(screen.getByText('Awaiting an agent turn', { exact: false })).toBeInTheDocument()
  })
})
