import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects: [{ id: 'p1', name: 'acme', slug: 'acme', path: '/a', provider: 'claude' }], activeProjectId: 'p1', setActiveProjectId: vi.fn() }),
}))
vi.mock('../../../browser/context/WebViewModalContext', () => ({ useWebViewModal: () => ({ openWebView: vi.fn(), canOpenWebView: false }) }))
vi.mock('../../context/AgentChatContext', () => ({ useAgentChat: () => ({ applyPrDecisionSnapshot: () => 'applied' }) }))
vi.mock('../../../builder/hooks/useMilestoneProgress', () => ({ useStackedHeadDeliveryIds: () => new Set() }))
vi.mock('../../hooks/useAgentRefActions', () => ({ useAgentRefActions: () => ({ openRef: vi.fn() }) }))
const vitals = vi.hoisted(() => ({ paused: false, pausedReason: null as string | null, pauseBudget: null as null | { scope: 'project' | 'desktop'; budgetUsd: number; spentUsd: number; resetsAt: string | null } }))
vi.mock('../../../jobs/hooks/useRunVitals', () => ({
  useRunVitals: () => ({ status: null, paused: vitals.paused, pausedReason: vitals.pausedReason, pauseBudget: vitals.pauseBudget, running: false, elapsedMs: 61_000, costUsd: null, numTurns: null, loaded: true }),
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
import { getMoreItem, queryMoreItem } from './pr-card-actions'

const env = (over: Partial<AgentPrDecisionEnvelope> = {}): AgentPrDecisionEnvelope => ({
  kind: 'pr_decision', prDeliveryId: 'run:r1', railIndex: 1, projectId: 'p1', baseBranch: 'main', ticketIds: [4],
  decision: 'completed', prUrl: null, prNumber: null, prState: 'none', branch: null, runIds: ['r1'], hasDelivery: false, ...over,
})
const failed = { status: 'failed' as const, currentStep: null, canResume: true, recoverableSteps: ['developer'], pendingApproval: true, failure: { code: 'implementation_failed', detail: 'verify exited 1', stepId: 'verify' }, at: '' }

beforeEach(() => {
  runtime.state.runs = []; runtime.state.error = ''; runtime.state.busy = null; runtime.calls.length = 0
  runtime.state.act.mockClear(); Object.values(toast).forEach((f) => f.mockClear())
  vitals.paused = false; vitals.pausedReason = null; vitals.pauseBudget = null
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

describe('paused building card', () => {
  const live = { runId: 'r1', status: 'interrupted', nextStep: 'developer', recoverableSteps: ['attempt-1'], active: false, canResume: true, canCancel: true }

  it('resumes an interrupted run in place, from the interrupted step', async () => {
    vitals.paused = true; vitals.pausedReason = 'restart'
    runtime.state.runs = [live]
    render(<AgentPrDecisionCard envelope={env({ decision: 'building' })} conversationId="c1" />)
    const resume = screen.getByTestId('pr-run-paused-resume')
    expect(resume.textContent).toContain('Resume from developer')
    expect(resume.getAttribute('title')).toContain('runs again from its start')
    fireEvent.click(resume)
    await act(async () => {})
    expect(runtime.state.act).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1' }), 'recover')
  })

  it('says a run without git works in the project folder, not in an isolated worktree', () => {
    render(<AgentPrDecisionCard envelope={env({ decision: 'building' })} conversationId="c1" />)
    expect(screen.getByText('Implementing in the project folder…')).toBeInTheDocument()
    expect(screen.queryByText('Implementing in an isolated worktree…')).toBeNull()
  })

  it('resumes as is when nothing must be re-run', async () => {
    vitals.paused = true
    runtime.state.runs = [{ ...live, recoverableSteps: [] }]
    render(<AgentPrDecisionCard envelope={env({ decision: 'building' })} conversationId="c1" />)
    expect(screen.getByTestId('pr-run-paused-resume').textContent).toBe('Resume')
    fireEvent.click(screen.getByTestId('pr-run-paused-resume'))
    await act(async () => {})
    expect(runtime.state.act).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1' }), 'resume')
  })

  it('shows a budget_paused run with localized amounts and resumes it through the loop-run resume route', async () => {
    vitals.paused = true; vitals.pausedReason = 'SERVER ENGLISH'
    vitals.pauseBudget = { scope: 'desktop', budgetUsd: 5, spentUsd: 6.5, resetsAt: null }
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'daily_budget_exceeded', scope: 'desktop', budgetUsd: 5, spentUsd: 7, resetsAt: null }), { status: 409, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({ decision: 'building' })} conversationId="c1" />)
    const banner = screen.getByTestId('pr-run-paused-actions')
    expect(banner).toHaveTextContent('Paused on the app-wide daily budget ($6.50 of $5.00)')
    expect(banner).not.toHaveTextContent('SERVER ENGLISH')
    await act(async () => { fireEvent.click(screen.getByTestId('pr-run-paused-resume')) })
    expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/projects\/p1\/loop-runs\/r1\/resume$/), expect.objectContaining({ method: 'POST' }))
    expect(runtime.state.act).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('The daily limit is still reached.', expect.objectContaining({ description: expect.stringContaining('Analytics ▸ Budget'), action: expect.objectContaining({ label: 'Raise limit' }) }))
  })

  it('relaunch reports a daily budget 409 in localized words', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'daily_budget_exceeded', scope: 'project', budgetUsd: 10, spentUsd: 11, resetsAt: null, detail: 'SERVER' }), { status: 409, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({ decision: 'implementation_failed', runtime: failed })} conversationId="c1" />)
    await act(async () => { fireEvent.click(screen.getByTestId('mission-run-relaunch')) })
    expect(screen.getByTestId('mission-run-relaunch-error')).toHaveTextContent('Project daily budget reached ($11.00 of $10.00)')
    expect(screen.getByTestId('mission-run-relaunch-error')).not.toHaveTextContent('SERVER')
  })

  it('leaves a pause that awaits an answer to the run log', async () => {
    vitals.paused = true
    runtime.state.runs = [{ ...live, recoverableSteps: [], pendingQuestion: { stepId: 'ask', question: 'Which?' } }]
    render(<AgentPrDecisionCard envelope={env({ decision: 'building' })} conversationId="c1" />)
    fireEvent.click(screen.getByTestId('pr-run-paused-resume'))
    await act(async () => {})
    expect(runtime.state.act).not.toHaveBeenCalled()
  })
})

describe('run-only card (shared-cwd launch)', () => {
  it('renders the run outcome, no delivery controls, and the honest no-PR note', () => {
    render(<AgentPrDecisionCard envelope={env()} conversationId="c1" />)
    const card = screen.getByTestId('agent-pr-decision-card')
    expect(card.getAttribute('data-run-only')).toBe('true')
    expect(screen.getByTestId('mission-run-status').getAttribute('data-status')).toBe('succeeded')
    expect(screen.getByTestId('mission-run-no-delivery')).toBeInTheDocument()
    expect(queryMoreItem('agent-pr-merge-local')).toBeNull()
    expect(queryMoreItem('agent-pr-checkout')).toBeNull()
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
    expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/projects\/p1\/rails\/1\/relaunch$/), expect.objectContaining({ method: 'POST', body: JSON.stringify({ sourceId: 'run:r1', originConversationId: 'c1', originSurface: 'agent-chat' }) }))
    expect(toast.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ description: 'busy — wait' }))
    expect(screen.getByTestId('mission-run-relaunch-error')).toHaveTextContent('busy — wait')
    ;(global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response('{}', { status: 202 }))
    await act(async () => { fireEvent.click(screen.getByTestId('mission-run-relaunch')) })
    expect(toast.success).toHaveBeenCalled()
    expect(screen.queryByTestId('mission-run-relaunch-error')).toBeNull()
    expect(screen.getByTestId('mission-run-relaunch')).toBeDisabled()
  })

  it('submits only once for synchronous repeat clicks and stays disabled after acceptance', async () => {
    let resolve!: (value: Response) => void
    global.fetch = vi.fn((input: RequestInfo | URL) => String(input).endsWith('/relaunch')
      ? new Promise<Response>(done => { resolve = done })
      : Promise.resolve(new Response('{}', { status: 404 }))) as unknown as typeof fetch
    // The card also reads the run's diagnosis; only relaunch submissions count here.
    const relaunches = () => (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url).endsWith('/relaunch')).length
    render(<AgentPrDecisionCard envelope={env({ decision: 'implementation_failed', runtime: failed })} conversationId="c1" />)
    const button = screen.getByTestId('mission-run-relaunch')
    act(() => { fireEvent.click(button); fireEvent.click(button) })
    expect(relaunches()).toBe(1)
    expect(button).toBeDisabled()
    await act(async () => { resolve(new Response('{}', { status: 202 })) })
    fireEvent.click(button)
    expect(relaunches()).toBe(1)
    expect(button).toBeDisabled()
  })

  it('sends the isolated delivery id and pins requests to the card project', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 202 })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({ projectId: 'other-project', prDeliveryId: 'failed-delivery', hasDelivery: true, decision: 'implementation_failed', runtime: failed })} conversationId="c1" />)
    const relaunchItem = getMoreItem('mission-run-relaunch')
    await act(async () => { fireEvent.click(relaunchItem) })
    expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/projects\/other-project\/rails\/1\/relaunch$/), expect.objectContaining({ body: JSON.stringify({ sourceId: 'failed-delivery', originConversationId: 'c1', originSurface: 'agent-chat' }) }))
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

describe('failure diagnosis on a failed run', () => {
  const diagnosis = { kind: 'tests_failed', confidence: 'high', phase: 'reviewer', rounds: 4, resetAt: null, detail: null, resumablePhase: 'fixer', blocker: null, source: 'core', remedies: ['resume', 'retry', 'edit-spec', 'open-logs'] }
  const answer = (failureDiagnosis: unknown) => vi.fn(async () => new Response(JSON.stringify({ loopRun: { id: 'r1', failureDiagnosis } }), { status: 200 })) as unknown as typeof fetch

  it('replaces the bare failure block with the diagnosis, keeping the technical details one click away', async () => {
    global.fetch = answer(diagnosis)
    runtime.state.runs = [{ runId: 'r1', status: 'failed', nextStep: 'fixer', recoverableSteps: [], active: false, canResume: true, canCancel: false }]
    render(<AgentPrDecisionCard envelope={env({ runtime: failed, decision: 'implementation_failed' })} conversationId="c1" />)
    expect(await screen.findByTestId('failure-diagnosis-card')).toHaveAttribute('data-kind', 'tests_failed')
    expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/projects\/p1\/loop-runs\/r1$/), expect.anything())
    const card = screen.getByTestId('failure-diagnosis-card')
    expect(card).toHaveTextContent('Tests failed in the Reviewer phase after 4 fix rounds')
    expect(screen.getByText('Technical details')).toBeInTheDocument()
  })

  it('runs the card\'s real actions: resume and open the failing run\'s log', async () => {
    global.fetch = answer(diagnosis)
    runtime.state.runs = [{ runId: 'r1', status: 'failed', nextStep: 'fixer', recoverableSteps: [], active: false, canResume: true, canCancel: false }]
    render(<AgentPrDecisionCard envelope={env({ runtime: { ...failed, recoverableSteps: [] }, decision: 'implementation_failed' })} conversationId="c1" />)
    const card = await screen.findByTestId('failure-diagnosis-card')
    fireEvent.click(card.querySelector('[data-testid="failure-remedy-resume"]')!)
    await act(async () => {})
    expect(runtime.state.act).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1' }), 'resume')
  })

  it('keeps the existing failure block when the run has no diagnosis', async () => {
    global.fetch = answer(null)
    render(<AgentPrDecisionCard envelope={env({ runtime: failed })} conversationId="c1" />)
    await act(async () => {})
    expect(screen.queryByTestId('failure-diagnosis-card')).toBeNull()
    expect(screen.getByTestId('mission-run-failure')).toBeInTheDocument()
  })
})
