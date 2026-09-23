import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects: [{ id: 'p1', name: 'acme', slug: 'acme', path: '/a', provider: 'claude' }], activeProjectId: 'p1', setActiveProjectId: vi.fn() }),
}))
vi.mock('../../../browser/context/WebViewModalContext', () => ({ useWebViewModal: () => ({ openWebView: vi.fn(), canOpenWebView: false }) }))
vi.mock('../../context/AgentChatContext', () => ({ useAgentChat: () => ({ applyPrDecisionSnapshot: () => 'applied' }) }))
vi.mock('../../../builder/hooks/useMilestoneProgress', () => ({ useStackedHeadDeliveryIds: () => new Set() }))
vi.mock('../../hooks/useAgentRefActions', () => ({ useAgentRefActions: () => ({ openRef: vi.fn() }) }))
vi.mock('../../../jobs/hooks/useRunVitals', () => ({
  useRunVitals: () => ({ status: null, paused: false, pausedReason: null, running: false, elapsedMs: 61_000, costUsd: null, numTurns: null, loaded: true }),
  formatRunElapsed: (ms: number) => `${Math.floor(ms / 1000)}s`,
}))
const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), toast), Toaster: () => null }))
vi.mock('../../../../lib/tauri-shell', () => ({ isTauri: () => false, revealItemInDir: vi.fn() }))
vi.mock('../../../code/lib/git-refresh', () => ({ notifyGitChanged: vi.fn() }))
vi.mock('../../../jobs/components/JobDetailModal', () => ({ JobDetailModal: () => null }))

const runtime = vi.hoisted(() => ({
  state: { runs: [] as unknown[], error: '', busy: null as string | null, answers: {}, setAnswer: vi.fn(), act: vi.fn(async () => {}), refresh: vi.fn() },
  calls: [] as unknown[],
}))
vi.mock('../../../jobs/components/job-run/useRuntimeRuns', () => ({
  useRuntimeRuns: (projectId: string, opts: unknown) => { runtime.calls.push({ projectId, opts }); return runtime.state },
}))

import { AgentPrDecisionCard, deriveMissionRunStatus } from '../AgentPrDecisionCard'
import { FOCUS_PR_CARD_EVENT } from '../agent-run-failure'
import type { AgentPrDecisionEnvelope } from '../../lib/agent-api'

const env = (over: Partial<AgentPrDecisionEnvelope> = {}): AgentPrDecisionEnvelope => ({
  kind: 'pr_decision', prDeliveryId: 'run:r1', railIndex: 1, projectId: 'p1', baseBranch: 'main', ticketIds: [4],
  decision: 'completed', prUrl: null, prNumber: null, prState: 'none', branch: null, runIds: ['r1'], hasDelivery: false, ...over,
})
const failed = { status: 'failed' as const, currentStep: null, canResume: true, recoverableSteps: ['developer'], pendingApproval: true, failure: { code: 'implementation_failed', detail: 'verify exited 1', stepId: 'verify' }, at: '' }

beforeEach(() => {
  runtime.state.runs = []; runtime.state.error = ''; runtime.state.busy = null; runtime.calls.length = 0
  runtime.state.act.mockClear(); Object.values(toast).forEach((f) => f.mockClear())
})

describe('deriveMissionRunStatus', () => {
  it('prefers live, then snapshot, then decision', () => {
    expect(deriveMissionRunStatus(env({ decision: 'building' }), null, false)).toBe('running')
    expect(deriveMissionRunStatus(env({ decision: 'building' }), null, true)).toBe('paused')
    expect(deriveMissionRunStatus(env({ decision: 'building' }), { status: 'stalled' }, false)).toBe('stalled')
    expect(deriveMissionRunStatus(env(), { active: true }, false)).toBe('running')
    expect(deriveMissionRunStatus(env({ runtime: failed }), null, false)).toBe('failed')
    expect(deriveMissionRunStatus(env({ runtime: { ...failed, status: 'unknown', failure: { code: 'stuck', detail: null, stepId: null } } }), null, false)).toBe('stalled')
    expect(deriveMissionRunStatus(env({ decision: 'implementation_failed' }), null, false)).toBe('failed')
    expect(deriveMissionRunStatus(env({ decision: 'discarded' }), null, false)).toBe('cancelled')
    expect(deriveMissionRunStatus(env({ decision: 'completed' }), null, false)).toBe('succeeded')
    expect(deriveMissionRunStatus(env({ decision: 'pr_closed' }), null, false)).toBe('unknown')
  })
})

describe('run-only card (shared-cwd launch)', () => {
  it('renders the run outcome, no delivery controls, and the honest no-PR note', () => {
    render(<AgentPrDecisionCard envelope={env()} conversationId="c1" />)
    const card = screen.getByTestId('agent-pr-decision-card')
    expect(card.getAttribute('data-run-only')).toBe('true')
    expect(screen.getByTestId('mission-run-status').getAttribute('data-status')).toBe('succeeded')
    expect(screen.getByTestId('mission-run-no-delivery')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-pr-merge-local')).toBeNull()
    expect(screen.queryByTestId('agent-pr-checkout')).toBeNull()
    expect(screen.getByTestId('mission-run-relaunch')).toBeInTheDocument()
    expect(screen.getByTestId('mission-run-dismiss')).toBeInTheDocument()
    // Runtime polling is NOT armed for a green settled run.
    expect((runtime.calls[0] as { opts: { enabled: boolean } }).opts.enabled).toBe(false)
  })

  it('shows the failure as text with recovery actions from the snapshot and forwards them to the runtime', async () => {
    render(<AgentPrDecisionCard envelope={env({ decision: 'implementation_failed', runtime: failed, units: [{ ticketId: 4, branch: '', succeeded: false, failureCode: 'tests_failed' }] })} />)
    expect(screen.getByTestId('mission-run-status').getAttribute('data-status')).toBe('failed')
    expect(screen.getByTestId('mission-run-failure-code').textContent).toBe('implementation_failed')
    expect(screen.getByTestId('mission-run-failure-detail').textContent).toBe('verify exited 1')
    expect(screen.getByText(/#4 · tests_failed/)).toBeInTheDocument()
    expect((runtime.calls[0] as { opts: { enabled: boolean } }).opts.enabled).toBe(true)
    fireEvent.click(screen.getByTestId('mission-run-resume'))
    fireEvent.click(screen.getByTestId('mission-run-recover'))
    fireEvent.click(screen.getByTestId('mission-run-approve'))
    await act(async () => {})
    expect(runtime.state.act.mock.calls.map((c) => c[1])).toEqual(['resume', 'recover', 'approve'])
    expect(runtime.state.act.mock.calls[0][0]).toMatchObject({ runId: 'r1', canResume: true, pendingApproval: { stepId: 'verify' } })
  })

  it('prefers live runtime data and disables relaunch while active', () => {
    runtime.state.runs = [{ runId: 'r1', status: 'running', nextStep: 'developer', recoverableSteps: [], active: true, canResume: false, canCancel: true }]
    render(<AgentPrDecisionCard envelope={env({ runtime: failed })} />)
    expect(screen.getByTestId('mission-run-status').getAttribute('data-status')).toBe('running')
    expect(screen.getByTestId('mission-run-phase').textContent).toContain('developer')
    expect(screen.queryByTestId('mission-run-resume')).toBeNull()
    expect(screen.queryByTestId('mission-run-relaunch')).toBeNull()
  })

  it('relaunches the rail tagged with the mission and reports 409s inline via toast', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'tickets_in_flight', detail: 'busy', action: 'wait' }), { status: 409, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({ decision: 'implementation_failed', runtime: failed })} conversationId="c1" />)
    await act(async () => { fireEvent.click(screen.getByTestId('mission-run-relaunch')) })
    expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/projects\/p1\/rails\/1\/launch$/), expect.objectContaining({ method: 'POST', body: JSON.stringify({ originConversationId: 'c1', originSurface: 'agent-chat' }) }))
    expect(toast.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ description: 'busy — wait' }))
    ;(global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response('{}', { status: 202 }))
    await act(async () => { fireEvent.click(screen.getByTestId('mission-run-relaunch')) })
    expect(toast.success).toHaveBeenCalled()
  })

  it('scrolls + flashes on a matching focus event', () => {
    render(<AgentPrDecisionCard envelope={env()} />)
    const card = screen.getByTestId('agent-pr-decision-card')
    card.scrollIntoView = vi.fn()
    act(() => { window.dispatchEvent(new CustomEvent(FOCUS_PR_CARD_EVENT, { detail: { runIds: ['r1'] } })) })
    expect(card.scrollIntoView).toHaveBeenCalled()
    expect(card.className).toContain('ring-2')
    act(() => { window.dispatchEvent(new CustomEvent(FOCUS_PR_CARD_EVENT, { detail: { runIds: ['other'] } })) })
    expect((card.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })
})

describe('delivery card failure honesty', () => {
  it('discarded (launch failed) shows the swallowed statusDetail + relaunch', () => {
    render(<AgentPrDecisionCard envelope={env({ prDeliveryId: 'd1', hasDelivery: undefined, decision: 'discarded', statusCode: 'delivery_failed', statusDetail: 'worktree add failed', runIds: [] })} />)
    expect(screen.getByTestId('mission-run-failure-detail').textContent).toBe('worktree add failed')
    expect(screen.getByTestId('mission-run-failure-code').textContent).toBe('delivery_failed')
    expect(screen.getByTestId('mission-run-discarded-actions')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-pr-status-detail')).toBeNull()
  })
  it('building card shows the status pill and rail label', () => {
    render(<AgentPrDecisionCard envelope={env({ prDeliveryId: 'd1', hasDelivery: undefined, decision: 'building', railName: 'Auth' })} />)
    expect(screen.getByTestId('mission-run-status').getAttribute('data-status')).toBe('running')
    expect(screen.getByText('Auth')).toBeInTheDocument()
  })
})
