import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

// ── Mocks (mirror agent-pr-decision.test.tsx, plus a handler-MAP WS mock so
//    every mounted run chip keeps its own subscription) ───────────────────────
const wsHandlers = new Map<string, (msg: unknown) => void>()
const emitWs = (msg: unknown) => { for (const fn of [...wsHandlers.values()]) fn(msg) }
vi.mock('../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (id: string, fn: (m: unknown) => void) => { wsHandlers.set(id, fn) },
    unregisterHandler: (id: string) => { wsHandlers.delete(id) },
    connectionStatus: 'connected',
  }),
}))

const projects = [
  { id: 'p1', name: 'acme-api', slug: 'acme-api', path: '/acme', provider: 'claude' },
  { id: 'p2', name: 'deckdex', slug: 'deckdex', path: '/deck', provider: 'claude' },
]
vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects, activeProjectId: 'p1', setActiveProjectId: vi.fn() }),
}))

vi.mock('../../../context/WebViewModalContext', () => ({
  useWebViewModal: () => ({ openWebView: vi.fn(), canOpenWebView: false }),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), success: vi.fn() }),
  Toaster: () => null,
}))

// The run-log chip opens the mission-mode JobDetailModal — stub it to a probe
// that records its scope props (the real one drags in the whole log explorer).
vi.mock('../../JobDetailModal', () => ({
  JobDetailModal: ({ jobId, projectId, onClose }: { jobId: string; projectId?: string; onClose: () => void }) => (
    <div data-testid="job-detail-modal" data-job={jobId} data-project={projectId}>
      <button onClick={onClose}>close-modal</button>
    </div>
  ),
}))

import { AgentPrDecisionCard } from '../AgentPrDecisionCard'
import type { AgentPrDecisionEnvelope } from '../../../lib/agent-api'

const env = (over: Partial<AgentPrDecisionEnvelope> = {}): AgentPrDecisionEnvelope => ({
  kind: 'pr_decision',
  prDeliveryId: 'd1',
  railIndex: 0,
  projectId: 'p2',
  baseBranch: 'main',
  ticketIds: [4, 7],
  decision: 'building',
  prUrl: null,
  prNumber: null,
  prState: 'none',
  branch: null,
  runIds: ['run-a', 'run-b'],
  ...over,
})

/** GET /jobs/:id stub — per-runId job rows (the chip's initial vitals). */
function stubJobsFetch(rows: Record<string, Record<string, unknown>>) {
  const fetchMock = vi.fn(async (url: unknown) => {
    const m = /\/api\/projects\/([^/]+)\/jobs\/([^/?]+)$/.exec(String(url))
    const job = m ? rows[m[2]] ?? null : null
    return {
      ok: !!job,
      status: job ? 200 : 404,
      json: async () => ({ job }),
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const T0 = Date.now()
const runningRow = (startedMsAgo: number, cost: number | null = null) => ({
  status: 'running',
  started_at: new Date(T0 - startedMsAgo).toISOString(),
  finished_at: null,
  total_cost_usd: cost,
  num_turns: null,
})
const finishedRow = (durationMs: number, cost: number) => ({
  status: 'completed',
  started_at: new Date(T0 - durationMs).toISOString(),
  finished_at: new Date(T0).toISOString(),
  total_cost_usd: cost,
  num_turns: 4,
})

const chips = () => screen.queryAllByTestId('pr-run-log-chip')
const flush = async () => act(async () => { await Promise.resolve() })

beforeEach(() => { wsHandlers.clear() })
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('AgentPrDecisionCard run-log chips', () => {
  it('building card: one chip per runId, labeled with its ticket, fetching the CARD project', async () => {
    const fetchMock = stubJobsFetch({ 'run-a': runningRow(5_000), 'run-b': runningRow(3_000) })
    render(<AgentPrDecisionCard envelope={env()} />)
    await flush()
    expect(chips()).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'View run log for #4' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View run log for #7' })).toBeInTheDocument()
    // vitals fetched against the envelope's project (never the active one)
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p2/jobs/run-a')
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p2/jobs/run-b')
    // cost hidden until > 0
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument()
  })

  it('building card: a job.turn_done broadcast updates the chip cost LIVE (own run only)', async () => {
    stubJobsFetch({ 'run-a': runningRow(5_000), 'run-b': runningRow(3_000) })
    render(<AgentPrDecisionCard envelope={env()} />)
    await flush()
    act(() => emitWs({ type: 'job.turn_done', jobId: 'run-a', totals: { total_cost_usd: 0.87, num_turns: 2 } }))
    expect(screen.getByText('$0.87')).toBeInTheDocument()
    // run-b untouched — still no cost anywhere else
    expect(screen.getAllByText(/^\$/)).toHaveLength(1)
  })

  it('terminal card (merged): chips stay visible with FROZEN vitals and no live WS subscription', async () => {
    stubJobsFetch({ 'run-a': finishedRow(252_000, 0.87), 'run-b': finishedRow(61_000, 1.2) })
    render(
      <AgentPrDecisionCard
        envelope={env({ decision: 'merged', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created' })}
      />,
    )
    await flush()
    expect(chips()).toHaveLength(2)
    expect(screen.getByText('4m12s')).toBeInTheDocument()
    expect(screen.getByText('$0.87')).toBeInTheDocument()
    expect(screen.getByText('1m01s')).toBeInTheDocument()
    expect(screen.getByText('$1.20')).toBeInTheDocument()
    expect(wsHandlers.size).toBe(0) // frozen — no live stream
  })

  it('single all-scope run covering several tickets: ONE chip labeled with every ticket', async () => {
    stubJobsFetch({ 'run-a': runningRow(1_000) })
    render(<AgentPrDecisionCard envelope={env({ runIds: ['run-a'] })} />)
    await flush()
    expect(chips()).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'View run log for #4 #7' })).toBeInTheDocument()
  })

  it('multi-run wrap: every runId gets its chip (3 runs → 3 chips, on_review too)', async () => {
    stubJobsFetch({ 'run-a': finishedRow(10_000, 0.1), 'run-b': finishedRow(20_000, 0.2), 'run-c': finishedRow(30_000, 0.3) })
    render(
      <AgentPrDecisionCard
        envelope={env({ decision: 'on_review', ticketIds: [4, 7, 9], runIds: ['run-a', 'run-b', 'run-c'] })}
      />,
    )
    await flush()
    expect(chips()).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'View run log for #9' })).toBeInTheDocument()
  })

  it('no runIds (pre-allocation / legacy persisted card) → no chips row', async () => {
    stubJobsFetch({})
    render(<AgentPrDecisionCard envelope={env({ runIds: [] })} />)
    await flush()
    expect(chips()).toHaveLength(0)
    expect(screen.queryByTestId('pr-run-log-chips')).not.toBeInTheDocument()
  })

  it('click → JobDetailModal opens with the run id AND the envelope project (not the active one); close unmounts', async () => {
    stubJobsFetch({ 'run-a': runningRow(1_000), 'run-b': runningRow(1_000) })
    render(<AgentPrDecisionCard envelope={env()} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'View run log for #7' }))
    const modal = await screen.findByTestId('job-detail-modal')
    expect(modal).toHaveAttribute('data-job', 'run-b')
    expect(modal).toHaveAttribute('data-project', 'p2')
    fireEvent.click(screen.getByText('close-modal'))
    expect(screen.queryByTestId('job-detail-modal')).not.toBeInTheDocument()
  })
})
