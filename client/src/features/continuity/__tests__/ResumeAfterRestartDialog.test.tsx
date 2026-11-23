import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../test-utils'
import type { InboxItem } from '../../inbox/lib/inbox-model'

const fetchOffers = vi.fn()
const settle = vi.fn()
const send = vi.fn()
const runPrimary = vi.fn()
let inboxItems: InboxItem[] = []

vi.mock('../../../lib/continuity-api', () => ({
  fetchResumeOffers: (...args: unknown[]) => fetchOffers(...args),
  settleResumeOffers: (...args: unknown[]) => settle(...args),
}))
vi.mock('../../missions/lib/agent-api', () => ({ sendAgentMessage: (...args: unknown[]) => send(...args) }))
vi.mock('../../inbox/context/InboxContext', () => ({
  useInbox: () => ({ status: 'ready', items: inboxItems, runPrimary: (...args: unknown[]) => runPrimary(...args) }),
}))

import { ResumeAfterRestartDialog } from '../components/ResumeAfterRestartDialog'
import { interruptedRunItems, resumeQueueId } from '../lib/continuity-model'
import { decideTour, resetStartupQueueForTests, startupQueue } from '../../../lib/startup-queue'

const run = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: 'p1:blocked:r1', projectId: 'p1', projectName: 'Shop', kind: 'blocked', title: 'Implement · #12', detail: 'interrupted',
  at: '2026-11-18T08:00:00Z', version: 'v', action: 'resume-run', subjectId: 'r1', conversationId: null, diagnosis: null, cap: null, ...overrides,
})

const offer = { conversationId: 'c1', title: 'Fix login', startedAt: '2026-11-18T09:00:00Z', stoppedAt: '2026-11-18T09:05:00Z', provider: 'claude', trigger: 'update' as const }

beforeEach(() => {
  fetchOffers.mockReset(); settle.mockReset(); send.mockReset(); runPrimary.mockReset()
  settle.mockResolvedValue(undefined)
  send.mockResolvedValue({ accepted: true, queued: false })
  runPrimary.mockResolvedValue(undefined)
  inboxItems = [run(), run({ id: 'p1:blocked:old', subjectId: 'old' })]
  resetStartupQueueForTests()
})

describe('ResumeAfterRestartDialog in the startup queue', () => {
  it('nothing to resume: reports a clean launch, so the tour may open', async () => {
    fetchOffers.mockResolvedValue({ offers: [], runs: [], bootedAt: null })
    startupQueue.report('crash', false)
    render(<ResumeAfterRestartDialog />)
    await waitFor(() => expect(decideTour(startupQueue.getSnapshot())).toBe('show'))
  })

  it('offers: the only modal at launch holds the queue and defers the tour; attention toasts wait for it', async () => {
    fetchOffers.mockResolvedValue({ offers: [offer], runs: [], bootedAt: null })
    startupQueue.report('crash', false)
    render(<ResumeAfterRestartDialog />)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(decideTour(startupQueue.getSnapshot())).toBe('defer')
    expect(startupQueue.held()).toBe(true)
    const toast = vi.fn()
    startupQueue.deliver(toast)
    expect(toast).not.toHaveBeenCalled()
    // Esc only hides it (the offers stay for the next start) and releases the queue.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(settle).not.toHaveBeenCalled()
    expect(startupQueue.held()).toBe(false)
    expect(toast).toHaveBeenCalledTimes(1)
  })
})

describe('ResumeAfterRestartDialog', () => {
  it('stays closed when nothing was interrupted', async () => {
    fetchOffers.mockResolvedValue({ offers: [], runs: [], bootedAt: null })
    render(<ResumeAfterRestartDialog />)
    await waitFor(() => expect(fetchOffers).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists interrupted missions and runs; resumes only what is ticked, on click', async () => {
    fetchOffers.mockResolvedValue({ offers: [offer], runs: [{ projectId: 'p1', runId: 'r1' }], bootedAt: '2026-11-18T10:00:00Z' })
    render(<ResumeAfterRestartDialog />)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Fix login')).toBeInTheDocument()
    expect(screen.getByText(/Update installed/)).toBeInTheDocument()
    expect(screen.getByText('Implement · #12')).toBeInTheDocument()
    // A run paused by an earlier restart is not part of this one.
    expect(screen.queryAllByText('Implement · #12')).toHaveLength(1)
    expect(send).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox', { name: /Implement/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Resume 1' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith('c1', expect.stringContaining('restarted to install an update'), { queueId: resumeQueueId(offer) }))
    expect(runPrimary).not.toHaveBeenCalled()
    await waitFor(() => expect(settle).toHaveBeenCalledWith([], { runs: true }))
    expect(settle).toHaveBeenCalledWith(['c1'])
  })

  it('Not now dismisses the offers without resuming anything', async () => {
    fetchOffers.mockResolvedValue({ offers: [offer], runs: [], bootedAt: null })
    render(<ResumeAfterRestartDialog />)
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(settle).toHaveBeenCalledWith(['c1'], { runs: true }))
    expect(send).not.toHaveBeenCalled()
  })

  it('Esc only hides it: the offers are not discarded (they come back on the next start)', async () => {
    fetchOffers.mockResolvedValue({ offers: [offer], runs: [], bootedAt: null })
    render(<ResumeAfterRestartDialog />)
    await screen.findByRole('button', { name: 'Not now' })
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Not now' })).not.toBeInTheDocument())
    expect(settle).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps a failed resume visible', async () => {
    fetchOffers.mockResolvedValue({ offers: [offer], runs: [], bootedAt: null })
    send.mockRejectedValue(new Error('offline'))
    render(<ResumeAfterRestartDialog />)
    fireEvent.click(await screen.findByRole('button', { name: 'Resume 1' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not resume')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('matches runs by project and id', () => {
    expect(interruptedRunItems([run(), run({ projectId: 'p2' }), run({ subjectId: 'r2' }), run({ detail: null })], [{ projectId: 'p1', runId: 'r1' }])).toHaveLength(1)
  })
})
