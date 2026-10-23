import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects: [{ id: 'p1', name: 'arkanoidex', slug: 'arkanoidex', path: '/a', provider: 'claude' }], activeProjectId: 'p1', setActiveProjectId: vi.fn() }),
}))
vi.mock('../../browser/context/WebViewModalContext', () => ({ useWebViewModal: () => ({ openWebView: vi.fn(), canOpenWebView: false }) }))
vi.mock('../../missions/context/AgentChatContext', () => ({ useAgentChat: () => ({ applyPrDecisionSnapshot: () => 'applied' }) }))
vi.mock('../../builder/hooks/useMilestoneProgress', () => ({ useStackedHeadDeliveryIds: () => new Set() }))
vi.mock('../../missions/hooks/useAgentRefActions', () => ({ useAgentRefActions: () => ({ openRef: vi.fn() }) }))
vi.mock('../../jobs/hooks/useRunVitals', () => ({
  useRunVitals: () => ({ status: null, paused: false, pausedReason: null, pauseBudget: null, running: false, elapsedMs: 61_000, costUsd: null, numTurns: null, loaded: true }),
  formatRunElapsed: (ms: number) => `${Math.floor(ms / 1000)}s`,
}))
const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), toast), Toaster: () => null }))
vi.mock('../../../lib/tauri-shell', () => ({ isTauri: () => false, revealItemInDir: vi.fn() }))
vi.mock('../../code/lib/git-refresh', () => ({ notifyGitChanged: vi.fn() }))
vi.mock('../../jobs/components/JobDetailModal', () => ({ JobDetailModal: () => null }))
vi.mock('../../jobs/components/job-run/useRuntimeRuns', () => ({
  useRuntimeRuns: () => ({ runs: [], error: '', busy: null, answers: {}, setAnswer: vi.fn(), act: vi.fn(async () => {}), refresh: vi.fn() }),
}))
const flowContext = vi.hoisted(() => ({
  value: null as null | { returnToFlow: ReturnType<typeof vi.fn>; relaunch: ReturnType<typeof vi.fn> },
}))
vi.mock('../context/FlowContext', () => ({ useFlowContext: () => flowContext.value }))

import { AgentPrDecisionCard, deriveMissionRunStatus, flowCardOutcome } from '../../missions/components/AgentPrDecisionCard'
import { AgentRunFailureMarker } from '../../missions/components/AgentRunFailureMarker'
import { MissionExtensionsProvider } from '../../missions/context/MissionExtensionsContext'
import { FlowRunCardActions } from '../components/FlowRunCardActions'
import { FlowRunFailure } from '../components/FlowRunFailure'
import { AgentFlowReturnCard, parseFlowReturnBriefingRow } from '../../missions/components/AgentFlowReturnCard'
import { flowFailureStep } from '../lib/flow-failure'
import { FlowApiError } from '../lib/flow-api'
import type { AgentPrDecisionEnvelope } from '../../missions/lib/agent-api'

const review = {
  reason: 'review' as const,
  summary: 'Approval is blocked by four problems: no test carries a spec tag.',
  issues: [
    'tests/effects.test.ts: no test carries a [spec:visual-effects/<slug>] tag.',
    'src/ui/menus.ts: the Options toggles have no test.',
    'tests/effects.test.ts: trail length per quality is untested.',
    'tests/effects.test.ts: live-apply clearing is only covered for hitStop.',
    'design.md: 27 effects in code, 5 in the spec.',
  ],
  issuesOmitted: 0,
  score: 58,
  failingChecks: [{ command: 'npm test', exitCode: 1 }],
}

const env = (over: Partial<AgentPrDecisionEnvelope> = {}): AgentPrDecisionEnvelope => ({
  kind: 'pr_decision', prDeliveryId: 'delivery-1', railIndex: 0, projectId: 'p1', baseBranch: 'main', ticketIds: [8],
  decision: 'implementation_failed', prUrl: null, prNumber: null, prState: 'none', branch: null, runIds: ['run-1'],
  implementationOutcome: 'failed', deliveryOutcome: 'blocked', statusCode: 'review_changes_requested',
  statusDetail: 'The reviewer requested changes (score 58): tests/effects.test.ts: no test carries a tag (+4 more)',
  units: [{ ticketId: 8, branch: 'feat/8-effects', succeeded: false, runId: 'run-1', implementationOutcome: 'failed', deliveryOutcome: 'blocked', failureCode: 'review_changes_requested' }] as never,
  runtime: { status: 'failed', currentStep: null, canResume: false, recoverableSteps: [], pendingApproval: false, failure: { code: 'review_changes_requested', detail: 'The reviewer requested changes', stepId: null }, at: '' },
  flowReview: review,
  ...over,
})

const withFlow = (node: React.ReactNode) => (
  <MissionExtensionsProvider value={{ RunCardActions: FlowRunCardActions }}>{node}</MissionExtensionsProvider>
)

beforeEach(() => {
  Object.values(toast).forEach((f) => f.mockClear())
  flowContext.value = {
    returnToFlow: vi.fn(async () => ({ id: 'flow-1', state: 'active' })),
    relaunch: vi.fn(async () => ({ flow: { id: 'flow-1', state: 'handed_off', railIndex: 0 }, loopRunIds: ['run-2'], deliveryId: 'delivery-2' })),
  }
})

describe('Flow → Spec requested changes on the mission card', () => {
  it('maps the outcome without calling it a failure', () => {
    expect(flowCardOutcome(env())).toBe('changes')
    expect(flowCardOutcome(env({ decision: 'discarded', statusCode: 'returned_to_flow' }))).toBe('returned')
    expect(flowCardOutcome(env({ statusCode: 'implementation_failed' }))).toBeNull()
    expect(deriveMissionRunStatus(env(), null, false)).toBe('changes_requested')
    expect(deriveMissionRunStatus(env({ decision: 'discarded', statusCode: 'returned_to_flow' }), null, false)).toBe('returned')
  })

  it('shows the reviewer\'s issues and failing checks instead of "Implementation failed / settlement_interrupted"', () => {
    render(withFlow(<AgentPrDecisionCard envelope={env()} conversationId="conv-1" />))
    expect(screen.getAllByText('The reviewer requested changes').length).toBeGreaterThan(0)
    expect(screen.queryByText('Implementation failed')).toBeNull()
    expect(screen.queryByText(/settlement_interrupted/)).toBeNull()
    expect(screen.queryByTestId('mission-run-failure')).toBeNull()
    const block = screen.getByTestId('mission-flow-review')
    expect(block.getAttribute('data-reason')).toBe('review')
    expect(screen.getByTestId('mission-flow-review-score').textContent).toBe('score 58')
    expect(screen.getByText(review.summary)).toBeInTheDocument()
    // Four issues first, the rest behind "Show all".
    expect(screen.getByTestId('mission-flow-review-issues').querySelectorAll('li')).toHaveLength(4)
    fireEvent.click(screen.getByTestId('mission-flow-review-toggle'))
    expect(screen.getByTestId('mission-flow-review-issues').querySelectorAll('li')).toHaveLength(5)
    expect(screen.getByTestId('mission-flow-review-checks').textContent).toContain('npm test · exit 1')
    // The generic recovery actions never touch the Flow worktree from here.
    expect(screen.queryByTestId('mission-run-relaunch')).toBeNull()
    expect(screen.getByTestId('flow-review-back-to-flow')).toBeInTheDocument()
    expect(screen.getByTestId('flow-review-relaunch')).toBeInTheDocument()
  })

  it('Back to Flow and Relaunch call the Flow actions for this delivery', async () => {
    render(withFlow(<AgentPrDecisionCard envelope={env()} conversationId="conv-1" />))
    fireEvent.click(screen.getByTestId('flow-review-back-to-flow'))
    await act(async () => {})
    expect(flowContext.value!.returnToFlow).toHaveBeenCalledWith('p1', 'delivery-1')
    expect(toast.success).toHaveBeenCalledWith('Back in Flow — the agent has the review')
    fireEvent.click(screen.getByTestId('flow-review-relaunch'))
    await act(async () => {})
    expect(flowContext.value!.relaunch).toHaveBeenCalledWith('p1', 'delivery-1')
    expect(toast.success).toHaveBeenCalledWith('Flow → Spec relaunched on rail 1')
  })

  it('a Flow → Spec run that failed outright relaunches through its Flow, never the plain rail relaunch', async () => {
    const failed = env({ loopId: 'factory:flow-spec', statusCode: 'settlement_interrupted', statusDetail: 'OpenSpec 1.14.3 required; found 1.4.1', flowReview: null,
      runtime: { status: 'failed', currentStep: null, canResume: false, recoverableSteps: [], pendingApproval: false, failure: { code: 'piece_failed', detail: 'OpenSpec 1.14.3 required; found 1.4.1', stepId: 'derive' }, at: '' } } as never)
    render(withFlow(<AgentPrDecisionCard envelope={failed} conversationId="conv-1" />))
    expect(screen.queryByTestId('mission-run-relaunch')).toBeNull()
    fireEvent.click(screen.getByTestId('flow-review-relaunch'))
    await act(async () => {})
    expect(flowContext.value!.relaunch).toHaveBeenCalledWith('p1', 'delivery-1')
    expect(screen.getByTestId('flow-review-back-to-flow')).toBeInTheDocument()
  })

  it('shows a refused action inline', async () => {
    flowContext.value!.returnToFlow.mockRejectedValueOnce(new FlowApiError('flow_return_busy', 409, 'The delivery is busy'))
    render(withFlow(<AgentPrDecisionCard envelope={env()} conversationId="conv-1" />))
    fireEvent.click(screen.getByTestId('flow-review-back-to-flow'))
    await act(async () => {})
    // Localized by code; the server's English detail never reaches the card.
    expect(screen.getByTestId('flow-review-error').textContent).toBe('Could not go back to Flow: The run is busy with another action. Try again in a moment.')
  })

  it('without Flow wired, still explains the review (no actions)', () => {
    flowContext.value = null
    render(withFlow(<AgentPrDecisionCard envelope={env({ flowReview: undefined })} conversationId="conv-1" />))
    expect(screen.getByTestId('mission-flow-review')).toBeInTheDocument()
    expect(screen.getByText(/score 58\): tests\/effects/)).toBeInTheDocument()
    expect(screen.queryByTestId('flow-review-back-to-flow')).toBeNull()
  })

  it('a delivery that went back to its Flow says so, with no actions', () => {
    render(withFlow(<AgentPrDecisionCard envelope={env({ decision: 'discarded', statusCode: 'returned_to_flow', statusDetail: 'Returned to Flow' })} conversationId="conv-1" />))
    expect(screen.getAllByText('Back in Flow').length).toBeGreaterThan(0)
    expect(screen.getByTestId('mission-flow-returned')).toBeInTheDocument()
    expect(screen.queryByTestId('mission-flow-review')).toBeNull()
    expect(screen.queryByTestId('flow-review-back-to-flow')).toBeNull()
  })

  it('the failure marker reads as a review outcome', () => {
    render(<AgentRunFailureMarker row={{ kind: 'run-failure', runId: 'run-1', railIndex: 0, projectId: 'p1', code: 'review_changes_requested', detail: 'score 58', stepId: null, at: null }} />)
    expect(screen.getByText('Rail 1: the reviewer requested changes')).toBeInTheDocument()
    expect(screen.getByTestId('agent-run-failure-marker').getAttribute('data-code')).toBe('review_changes_requested')
  })
})

describe('Flow → Spec failed outright (Flow-authored failure)', () => {
  const crashRuntime = { status: 'failed', currentStep: 'derive', canResume: false, recoverableSteps: [], pendingApproval: false, at: '',
    failure: { code: 'implementation_failed', detail: 'OpenSpec 1.14.3 required; found 1.4.1\n    at checkVersion (core.js:12)', stepId: 'derive' } }
  const crashed = (over: Partial<AgentPrDecisionEnvelope> = {}) => env({
    loopId: 'factory:flow-spec', statusCode: 'implementation_failed', flowReview: undefined,
    statusDetail: 'Programmatic workflow stopped before delivery; partial changes stay in its original worktree.',
    units: [{ ticketId: 8, branch: 'feat/8-effects', succeeded: false, runId: 'run-1', implementationOutcome: 'failed', deliveryOutcome: 'blocked', failureCode: 'settlement_interrupted' }] as never,
    runtime: crashRuntime as never,
    ...over,
  })
  const withFailure = (node: React.ReactNode) => (
    <MissionExtensionsProvider value={{ RunCardActions: FlowRunCardActions, RunFailureOutcome: FlowRunFailure }}>{node}</MissionExtensionsProvider>
  )

  it('classifies a crash apart from requested changes, and maps every recipe step', () => {
    expect(flowCardOutcome(crashed())).toBe('crashed')
    expect(flowCardOutcome(env({ loopId: 'factory:flow-spec' }))).toBe('changes')
    expect(flowCardOutcome(env({ loopId: 'factory:implement', statusCode: 'implementation_failed' }))).toBeNull()
    expect(deriveMissionRunStatus(crashed(), null, false)).toBe('failed')
    expect(['init', 'derive', 'repair-guard', 'check', 'verify', 'review-policy', 'fix-progress', 'archive'].map((step) => flowFailureStep(step)))
      .toEqual(['derive', 'derive', 'derive', 'verify', 'verify', 'review', 'fix', 'archive'])
    expect(flowFailureStep(null, ['branch_verification_failed'])).toBe('settle')
    expect(flowFailureStep(null, ['implementation_failed'])).toBe('unknown')
  })

  it('says what failed in plain words, the cause, what happens next, and keeps the codes as technical details', () => {
    render(withFailure(<AgentPrDecisionCard envelope={crashed()} conversationId="conv-1" />))
    expect(screen.getByText('Flow → Spec stopped')).toBeInTheDocument()
    expect(screen.getByTestId('flow-run-failure-headline').textContent).toBe('Couldn’t write the spec from your changes')
    expect(screen.getByTestId('flow-run-failure-cause').textContent).toBe('Cause: OpenSpec 1.14.3 required; found 1.4.1')
    expect(screen.getByTestId('flow-run-failure-next').textContent).toBe('Your work is intact. Back in Flow, the agent gets the error.')
    // No generic failure block, note, status label or red unit chip.
    expect(screen.queryByTestId('mission-run-failure')).toBeNull()
    expect(screen.queryByText(/The implementation failed/)).toBeNull()
    expect(screen.queryByTestId('agent-pr-status-code')).toBeNull()
    expect(screen.queryByTestId('agent-pr-unit-evidence')).toBeNull()
    // The English detail and the codes live only under Technical details.
    const technical = screen.getByTestId('flow-run-failure-technical')
    expect(technical.tagName).toBe('DETAILS')
    expect(technical.hasAttribute('open')).toBe(false)
    expect(technical.textContent).toContain('implementation_failed')
    expect(technical.textContent).toContain('settlement_interrupted')
    expect(technical.textContent).toContain('Programmatic workflow stopped before delivery')
    // Back to Flow first, Relaunch second; the plain rail relaunch never shows.
    const actions = screen.getAllByRole('button').map((button) => button.getAttribute('data-testid')).filter((id) => id?.startsWith('flow-review-'))
    expect(actions).toEqual(['flow-review-back-to-flow', 'flow-review-relaunch'])
    expect(screen.getByTestId('flow-review-back-to-flow').getAttribute('title')).toBe('Reopen this Flow on the same worktree; the agent receives the error on its next turn')
    expect(screen.queryByTestId('mission-run-relaunch')).toBeNull()
  })

  it('once returned on its own, shows "Returned to Flow" instead of the actions', () => {
    render(withFailure(<AgentPrDecisionCard envelope={crashed({ decision: 'discarded', statusCode: 'returned_to_flow', statusDetail: 'Returned to Flow: the run failed' })} conversationId="conv-1" />))
    expect(screen.getByTestId('flow-run-failure').getAttribute('data-returned')).toBe('true')
    expect(screen.getByTestId('flow-run-failure-returned').textContent).toBe('Returned to Flow')
    expect(screen.getByTestId('flow-run-failure-next').textContent).toBe('Your work is intact. Back in Flow, the agent has the error.')
    expect(screen.queryByTestId('flow-review-back-to-flow')).toBeNull()
    expect(screen.queryByTestId('mission-flow-returned')).toBeNull()
  })

  it('Back to Flow on a crash confirms the error went along', async () => {
    render(withFailure(<AgentPrDecisionCard envelope={crashed()} conversationId="conv-1" />))
    fireEvent.click(screen.getByTestId('flow-review-back-to-flow'))
    await act(async () => {})
    expect(flowContext.value!.returnToFlow).toHaveBeenCalledWith('p1', 'delivery-1')
    expect(toast.success).toHaveBeenCalledWith('Back in Flow — the agent has the error')
  })

  it('names the repository of a multi-repository run in the technical details', () => {
    render(withFailure(<AgentPrDecisionCard envelope={crashed({ repositoryDeliveries: [{ repositoryId: 'api', name: 'api-server', path: '/a', deliveryId: 'd', baseBranch: 'main', branch: null, deliverySha: null, decision: 'implementation_failed', implementationOutcome: 'failed', deliveryOutcome: 'blocked', statusCode: null, statusDetail: null, prUrl: null, prNumber: null }] as never })} conversationId="conv-1" />))
    expect(screen.getByTestId('flow-run-failure-technical').textContent).toContain('api-server')
  })

  it('the Flow return card explains the failure (no actions there)', () => {
    const row = parseFlowReturnBriefingRow(JSON.stringify({ kind: 'flow-return-briefing', flowId: 'flow-1', deliveryId: 'delivery-1', reason: null, issues: [],
      failure: { stepId: 'archive', cause: 'OpenSpec aborted: missing Purpose', statusCode: 'implementation_failed', failureCode: null, statusDetail: null } }))!
    expect(row.failure).toMatchObject({ stepId: 'archive' })
    render(withFailure(<AgentFlowReturnCard row={row} conversationId="conv-1" />))
    expect(screen.getByText('Why Flow → Spec stopped')).toBeInTheDocument()
    expect(screen.getByTestId('flow-run-failure-headline').textContent).toBe('Couldn’t archive the OpenSpec change')
    expect(screen.getByTestId('flow-run-failure-cause').textContent).toContain('OpenSpec aborted: missing Purpose')
    expect(screen.queryByTestId('flow-review-back-to-flow')).toBeNull()
    expect(screen.queryByTestId('flow-run-failure-returned')).toBeNull()
  })

  it('without the Flow extension, a crash keeps the generic presentation', () => {
    render(withFlow(<AgentPrDecisionCard envelope={crashed()} conversationId="conv-1" />))
    expect(screen.queryByTestId('flow-run-failure')).toBeNull()
    expect(screen.getByTestId('mission-run-failure')).toBeInTheDocument()
  })
})
