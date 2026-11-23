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
  it('shows authoritative consumption and keeps receipts on terminal runs as a read-only chip', async () => {
    const user = userEvent.setup()
    render(<RuntimeSteering projectId="p1" run={run({ status: 'succeeded', steering: { receipts: [{ id: 'm1', acceptedAt, preview: 'Keep compatibility', length: 18, status: 'consumed', consumedAttemptId: 'attempt-7', consumedAt: acceptedAt }], pending: 0, consumed: 1, consumptionReported: true, truncated: true } })} onAccepted={() => {}} />)
    expect(screen.queryByLabelText('Additional instructions')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send instructions' })).not.toBeInTheDocument()
    const chip = screen.getByRole('button', { name: 'Sent instructions: 1 applied' })
    await user.click(chip)
    const list = screen.getByRole('dialog', { name: 'Sent instructions' })
    expect(list).toHaveTextContent('Keep compatibility')
    expect(screen.getByText('Applied by the agent', { exact: false })).toHaveAttribute('title', 'attempt-7')
    expect(list).toHaveTextContent('Only the most recent receipts and pending messages are shown.')
  })
  it('hides the receipts chip while nothing was sent, then counts queued and applied in the run-state vocabulary', () => {
    const view = render(<RuntimeSteering projectId="p1" run={run()} onAccepted={() => {}} />)
    expect(screen.queryByTestId('run-steering-chip')).not.toBeInTheDocument()
    view.rerender(<RuntimeSteering projectId="p1" run={run({ steering: { receipts: [{ id: 'm1', acceptedAt, preview: 'A', length: 1, status: 'pending' }, { id: 'm2', acceptedAt, preview: 'B', length: 1, status: 'consumed' }], pending: 1, consumed: 1, consumptionReported: true } })} onAccepted={() => {}} />)
    const chip = screen.getByTestId('run-steering-chip')
    expect(chip).toHaveTextContent('1 queued · 1 applied')
    expect(chip.querySelector('[data-run-state]')).toHaveAttribute('data-run-state', 'queued')
  })
  it('sends on Cmd+Enter but not on a plain Enter, and ignores the shortcut while empty', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch).mockImplementation(async (_url, init) => response({ id: JSON.parse(String(init?.body)).requestId, acceptedAt }))
    render(<RuntimeSteering projectId="p1" run={run()} onAccepted={() => {}} />)
    const field = screen.getByLabelText('Additional instructions')
    await user.click(field)
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    expect(fetch).not.toHaveBeenCalled()
    await user.type(field, 'Line one{Enter}')
    expect(fetch).not.toHaveBeenCalled()
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).text).toBe('Line one\n')
    expect(screen.getByRole('status')).toHaveTextContent('Accepted by Core; awaiting consumption.')
    expect(screen.getByTestId('run-steering-chip')).toHaveTextContent('1 queued')
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
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(refresh).not.toHaveBeenCalled()
  })
  it('hides steering for old Core and never infers consumption from active state', async () => {
    const user = userEvent.setup()
    const view = render(<RuntimeSteering projectId="p1" run={run({ engineVersion: 1 })} onAccepted={() => {}} />)
    expect(view.container).toBeEmptyDOMElement()
    view.rerender(<RuntimeSteering projectId="p1" run={run({ steering: { receipts: [{ id: 'm1', acceptedAt, preview: 'Pending instruction', length: 19, status: 'consumed' }], pending: 1, consumed: 1, consumptionReported: false } })} onAccepted={() => {}} />)
    expect(screen.getByTestId('run-steering-chip')).toHaveTextContent('1 queued')
    await user.click(screen.getByTestId('run-steering-chip'))
    expect(screen.getByText('This Core version does not report consumption.')).toBeInTheDocument()
    expect(screen.getByText("Queued for the agent's next turn", { exact: false })).toBeInTheDocument()
  })
})
