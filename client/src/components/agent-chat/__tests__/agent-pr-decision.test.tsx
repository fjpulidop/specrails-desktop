import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// ── Mocks (mirror the agent-chat harness) ─────────────────────────────────────
let wsHandler: ((msg: unknown) => void) | null = null
vi.mock('../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (m: unknown) => void) => { wsHandler = fn },
    unregisterHandler: () => { wsHandler = null },
    connectionStatus: 'connected',
  }),
}))

const projects = [
  { id: 'p1', name: 'acme-api', slug: 'acme-api', path: '/acme', provider: 'claude' },
  { id: 'p2', name: 'deckdex', slug: 'deckdex', path: '/deck', provider: 'claude' },
]
const mockSetActiveProjectId = vi.fn()
vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects, activeProjectId: 'p1', setActiveProjectId: mockSetActiveProjectId }),
}))
const mockForceProjectRoute = vi.fn()
vi.mock('../../../lib/route-memory', () => ({ forceProjectRoute: (...args: unknown[]) => mockForceProjectRoute(...args) }))

// The card is Router-OPTIONAL: bare renders below must keep working, so only the
// two review-entry tests wrap in a MemoryRouter. useNavigate is mocked so the
// route target can be asserted.
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...(actual as object), useNavigate: () => mockNavigate }
})

const mockOpenWebView = vi.fn()
vi.mock('../../../context/WebViewModalContext', () => ({
  useWebViewModal: () => ({ openWebView: mockOpenWebView, canOpenWebView: false }),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
  Toaster: () => null,
}))

const tauriMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  revealItemInDir: vi.fn(async () => {}),
}))
vi.mock('../../../lib/tauri-shell', () => tauriMocks)

const api = {
  conv: { id: 'c1', title: null, provider: 'claude', model: null, session_id: null, pinned_project_id: null, tier_level: 0 as const, reasoning_effort: null, created_at: '', updated_at: '' },
}
vi.mock('../../../lib/agent-api', async (orig) => {
  const actual = await orig<typeof import('../../../lib/agent-api')>()
  return {
    ...actual, // coerce/parsePrDecisionEnvelope + postRailPrDecision stay REAL
    listAgentConversations: vi.fn(async () => []),
    createAgentConversation: vi.fn(async () => api.conv),
    getAgentConversation: vi.fn(async () => ({ conversation: api.conv, messages: [] })),
    patchAgentConversation: vi.fn(async () => api.conv),
    deleteAgentConversation: vi.fn(async () => {}),
    sendAgentMessage: vi.fn(async () => ({ queued: false })),
    abortAgentTurn: vi.fn(async () => {}),
    getMcpStatus: vi.fn(async () => ({ enabled: true, running: true })),
    enableMcp: vi.fn(async () => {}),
    getAvailableProviders: vi.fn(async () => ({ any: true, installed: ['claude'] })),
    getAgentModels: vi.fn(async () => ({
      models: [{ value: 'sonnet', label: 'Claude Sonnet', default: true }],
      supportsImageInput: true,
      efforts: ['low', 'medium', 'high'],
    })),
  }
})

import { toast } from 'sonner'
import * as agentApi from '../../../lib/agent-api'
import type { AgentPrDecisionEnvelope, AgentMessage as ApiAgentMessage } from '../../../lib/agent-api'
import { AgentChatProvider, useAgentChat } from '../../../context/AgentChatContext'
import { AgentPrDecisionCard } from '../AgentPrDecisionCard'

const env = (over: Partial<AgentPrDecisionEnvelope> = {}): AgentPrDecisionEnvelope => ({
  kind: 'pr_decision',
  prDeliveryId: 'd1',
  railIndex: 0,
  projectId: 'p1',
  baseBranch: 'main',
  ticketIds: [4, 7],
  decision: 'on_review',
  prUrl: null,
  prNumber: null,
  prState: 'none',
  branch: null,
  runIds: [],
  ...over,
})
const interruptedActionDetail = 'A previous delivery action was interrupted by restart. Its durable evidence was preserved; review the current state and retry.'
const recoveryWorktreePath = '/tmp/specrails/worktrees/ticket-4'
const recoverableBlockedEnv = (over: Partial<AgentPrDecisionEnvelope> = {}) => env({
  decision: 'pr_failed',
  prUrl: 'https://github.com/o/r/pull/7',
  prNumber: 7,
  prState: 'pr-created',
  branch: 'feat/review',
  implementationOutcome: 'succeeded',
  deliveryOutcome: 'blocked',
  statusCode: 'settlement_interrupted',
  isContinuation: true,
  runIds: ['run-1'],
  units: [{
    ticketId: 4,
    runId: 'run-1',
    branch: 'feat/review',
    succeeded: true,
    implementationOutcome: 'succeeded',
    deliveryOutcome: 'blocked',
    initialSha: 'a'.repeat(40),
    finalSha: null,
    failureCode: 'settlement_interrupted',
    branchOwnership: 'borrowed-pr',
    worktreePath: recoveryWorktreePath,
  }],
  ...over,
})
const unavailableRecoveryEnv = (over: Partial<AgentPrDecisionEnvelope> = {}) => env({
  decision: 'pr_failed',
  prUrl: 'https://github.com/o/r/pull/7',
  prNumber: 7,
  prState: 'pr-created',
  branch: 'feat/review',
  implementationOutcome: 'succeeded',
  deliveryOutcome: 'blocked',
  statusCode: 'recovery_unavailable',
  statusDetail: 'raw recovery scan detail that must not be shown',
  isContinuation: true,
  runIds: ['run-1'],
  units: [{
    ticketId: 4,
    runId: 'run-1',
    branch: 'feat/review',
    succeeded: true,
    implementationOutcome: 'succeeded',
    deliveryOutcome: 'blocked',
    initialSha: 'a'.repeat(40),
    finalSha: null,
    failureCode: 'recovery_unavailable',
    branchOwnership: 'borrowed-pr',
  }],
  ...over,
})

/** JSON-body fetch stub shaped like postRailPrDecision expects (res.text()). */
const httpRes = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
})

beforeEach(() => {
  wsHandler = null
  vi.clearAllMocks()
  tauriMocks.isTauri.mockReturnValue(false)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  })
  vi.mocked(agentApi.listAgentConversations).mockResolvedValue([])
  vi.mocked(agentApi.createAgentConversation).mockResolvedValue(api.conv)
  vi.mocked(agentApi.getAgentConversation).mockResolvedValue({ conversation: api.conv, messages: [] })
  vi.mocked(agentApi.getMcpStatus).mockResolvedValue({ enabled: true, running: true })
})

// ── AgentPrDecisionCard: state matrix ─────────────────────────────────────────
describe('AgentPrDecisionCard states', () => {
  it('offers checkout for a verified single local result before a PR exists', async () => {
    global.fetch = vi.fn(async () => httpRes(200, { ok: true, branch: 'sr/ticket-4', cleanupWarnings: ['A modified worktree was preserved.'] })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({
      projectId: 'p2', ticketIds: [4],
      units: [{ ticketId: 4, branch: 'sr/ticket-4', succeeded: true, finalSha: 'a'.repeat(40) }],
    })} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Checkout' })) })
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/p2/rails/pr-checkout', expect.objectContaining({
      body: JSON.stringify({ prDeliveryId: 'd1' }),
    }))
    expect(toast.success).toHaveBeenCalledWith('Checked out sr/ticket-4')
    expect(toast.warning).toHaveBeenCalledWith('Cleanup is incomplete (1 warning)', { description: 'A modified worktree was preserved.' })
  })

  it('on_review: title, Create PR + Discard, base chip, spec pill, project + rail badge', () => {
    render(<AgentPrDecisionCard envelope={env()} />)
    expect(screen.getByText('Implementation ready for review')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create PR' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
    expect(screen.getByTitle('Base branch')).toHaveTextContent('→ main')
    expect(screen.getByText('2 specs')).toBeInTheDocument()
    expect(screen.getByText('acme-api')).toBeInTheDocument()
    expect(screen.getByText('Rail 1')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument() // no PR yet
  })

  it('offers the plain-language review entry on on_review and routes to it', () => {
    render(<MemoryRouter><AgentPrDecisionCard envelope={env()} /></MemoryRouter>)
    const review = screen.getByTestId('agent-pr-open-packet')
    expect(review).toHaveTextContent('Review')
    fireEvent.click(review)
    expect(mockNavigate).toHaveBeenCalledWith(`/review/${env().prDeliveryId}`)
  })

  it('opens review in the card project instead of the currently selected project', () => {
    render(<MemoryRouter><AgentPrDecisionCard envelope={env({ projectId: 'p2' })} /></MemoryRouter>)
    fireEvent.click(screen.getByTestId('agent-pr-open-packet'))
    expect(mockForceProjectRoute).toHaveBeenCalledWith('p2', '/review/d1')
    expect(mockSetActiveProjectId).toHaveBeenCalledWith('p2')
    expect(mockNavigate).toHaveBeenCalledWith('/review/d1')
    expect(mockForceProjectRoute.mock.invocationCallOrder[0]).toBeLessThan(mockSetActiveProjectId.mock.invocationCallOrder[0])
  })

  it('does not offer the review entry once the delivery is terminal', () => {
    render(
      <MemoryRouter>
        <AgentPrDecisionCard envelope={env({ decision: 'merged', statusCode: 'merged' })} />
      </MemoryRouter>,
    )
    expect(screen.queryByTestId('agent-pr-open-packet')).not.toBeInTheDocument()
  })

  it('stays renderable outside a Router (the entry is simply absent)', () => {
    render(<AgentPrDecisionCard envelope={env()} />)
    expect(screen.getByRole('button', { name: 'Create PR' })).toBeInTheDocument()
    expect(screen.queryByTestId('agent-pr-open-packet')).not.toBeInTheDocument()
  })

  it('falls back to the raw projectId when the project is unknown', () => {
    render(<AgentPrDecisionCard envelope={env({ projectId: 'gone' })} />)
    expect(screen.getByText('gone')).toBeInTheDocument()
  })

  it('pr_draft with a PR: Publish + Discard + #number link, no Create PR', () => {
    render(<AgentPrDecisionCard envelope={env({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7', prNumber: 7, prState: 'pr-created', branch: 'sr/acme/batch-x' })} />)
    expect(screen.getByText('Draft PR created')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create PR' })).not.toBeInTheDocument()
    const link = screen.getByRole('link')
    expect(link).toHaveTextContent('#7')
    expect(link).toHaveAttribute('href', 'https://github.com/o/r/pull/7')
  })

  it('degraded pr_draft (pushed, no PR): Retry PR + Discard + degraded note, no Publish', () => {
    render(<AgentPrDecisionCard envelope={env({ decision: 'pr_draft', prUrl: null, prState: 'pushed', branch: 'sr/acme/batch-x' })} />)
    expect(screen.getByText('PR delivery incomplete')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry PR' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument()
    expect(screen.getByText(/branch was pushed but the PR could not be created/)).toBeInTheDocument()
  })

  it('degraded pr_draft (local-only) shows the local-only note', () => {
    render(<AgentPrDecisionCard envelope={env({ decision: 'pr_draft', prUrl: null, prState: 'local-only' })} />)
    expect(screen.getByText(/assembled locally but not pushed/)).toBeInTheDocument()
  })

  it('pr_ready: Verify PR + Discard + link', () => {
    render(<AgentPrDecisionCard envelope={env({ decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/12', prState: 'pr-created' })} />)
    expect(screen.getByText('PR ready for merge')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verify PR' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveTextContent('#12')
  })

  it('repaired legacy PR-ready continuation offers only safe Dismiss', () => {
    render(<AgentPrDecisionCard envelope={env({
      decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/12', prState: 'pr-created',
      branch: 'feat/review', isContinuation: true, deliverySha: 'a'.repeat(40),
      implementationOutcome: 'succeeded', deliveryOutcome: 'delivered',
      units: [{
        ticketId: 4, runId: 'legacy-run', branch: 'feat/review', succeeded: true,
        implementationOutcome: 'succeeded', deliveryOutcome: 'ready',
        failureCode: 'settlement_interrupted', finalSha: 'a'.repeat(40), branchOwnership: 'borrowed-pr',
      }],
    })} />)

    expect(screen.getByRole('button', { name: 'Dismiss follow-up' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Verify PR' })).toBeInTheDocument()
  })

  it('fresh interrupted PR-ready recovery with an owned branch keeps Discard', () => {
    render(<AgentPrDecisionCard envelope={env({
      decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/13', prState: 'pr-created',
      branch: 'feat/fresh', isContinuation: false, deliverySha: 'b'.repeat(40),
      implementationOutcome: 'succeeded', deliveryOutcome: 'delivered',
      units: [{
        ticketId: 4, runId: 'fresh-run', branch: 'feat/fresh', succeeded: true,
        implementationOutcome: 'succeeded', deliveryOutcome: 'ready',
        failureCode: 'settlement_interrupted', finalSha: 'b'.repeat(40), branchOwnership: 'created',
      }],
    })} />)

    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dismiss follow-up' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Verify PR' })).toBeInTheDocument()
  })

  it('pr_failed: Retry + Discard', () => {
    render(<AgentPrDecisionCard envelope={env({ decision: 'pr_failed' })} />)
    expect(screen.getByText('PR creation failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
  })

  it('implementation_failed: failed implementation note + Discard only', () => {
    render(<AgentPrDecisionCard envelope={env({ decision: 'implementation_failed', runIds: ['run-1'] })} />)
    expect(screen.getByText('Implementation failed')).toBeInTheDocument()
    expect(screen.getByText(/implementation run failed/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Integrate locally' })).not.toBeInTheDocument()
  })

  it('implementation-failed discard says recoverable local work and branches are preserved', () => {
    render(<AgentPrDecisionCard envelope={env({
      decision: 'implementation_failed', implementationOutcome: 'failed', runIds: ['run-1'],
    })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    const dialog = screen.getByTestId('agent-pr-discard-confirm')
    expect(dialog).toHaveTextContent('Local work and branches will be kept for inspection')
    expect(dialog).toHaveTextContent('Only resources proven safe to clean up may be removed')
    expect(dialog).not.toHaveTextContent('branches and worktrees will be removed')
  })

  it('successful implementation blocked at delivery never claims the agent run failed or offers an unsafe retry', () => {
    render(<AgentPrDecisionCard envelope={env({
      decision: 'pr_failed',
      implementationOutcome: 'succeeded',
      deliveryOutcome: 'blocked',
      statusCode: 'commit_failed',
      statusDetail: 'pre-commit hook rejected the commit',
      units: [{ ticketId: 4, branch: 'feat/4', succeeded: true, implementationOutcome: 'succeeded', deliveryOutcome: 'blocked', initialSha: null, finalSha: null, failureCode: 'commit_failed' }],
    })} />)
    const card = screen.getByTestId('agent-pr-decision-card')
    expect(card).not.toHaveAttribute('role')
    expect(screen.getByRole('status', { name: 'Implementation complete — delivery needs attention' })).toBeInTheDocument()
    expect(screen.getByText('Implementation complete — delivery needs attention')).toBeInTheDocument()
    expect(screen.getByText(/^Implementation succeeded, but delivery is blocked/)).toBeInTheDocument()
    expect(screen.getByText('pre-commit hook rejected the commit')).toBeInTheDocument()
    expect(screen.getByTestId('agent-pr-status-code')).toHaveTextContent('Commit step failed')
    expect(screen.queryByText('Implementation failed')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard local result' })).not.toBeInTheDocument()
  })

  it('fresh blocked delivery with an attached PR offers full Discard and truthful PR-close copy', () => {
    render(<AgentPrDecisionCard envelope={env({
      decision: 'pr_failed', implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      statusCode: 'branch_verification_failed', isContinuation: false,
      prUrl: 'https://github.com/o/r/pull/44', prNumber: 44, prState: 'pr-created',
    })} />)

    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard local result' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    const dialog = screen.getByTestId('agent-pr-discard-confirm')
    expect(dialog).toHaveTextContent('The PR will be closed without deleting its remote branch')
    expect(dialog).toHaveTextContent('specs will return to the backlog')
  })

  it('offers explicit local recovery actions for an interrupted follow-up without presenting Checkout', () => {
    render(<AgentPrDecisionCard envelope={recoverableBlockedEnv()} />)

    expect(screen.getByRole('button', { name: 'Inspect local result' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit & retry push' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard local result' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Checkout' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
  })

  it('offers safe Dismiss instead of claiming a local result exists on another computer', () => {
    render(<AgentPrDecisionCard envelope={recoverableBlockedEnv({
      units: [{
        ticketId: 4, runId: 'run-1', branch: 'feat/review', succeeded: true,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        initialSha: 'a'.repeat(40), finalSha: null,
        failureCode: 'settlement_interrupted', branchOwnership: 'borrowed-pr',
      }],
    })} />)

    expect(screen.getByRole('button', { name: 'Commit & retry push' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss follow-up' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Inspect local result' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard local result' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Checkout' })).not.toBeInTheDocument()
  })

  it('shows a truthful unavailable-on-this-computer path with Check again, run inspection, and Dismiss only', () => {
    render(<AgentPrDecisionCard envelope={unavailableRecoveryEnv()} />)

    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /View run log/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss follow-up' })).toBeInTheDocument()
    expect(screen.getByText('Specrails could not safely prove one delivery-owned result in this clone. Nothing was changed or removed. Inspect the stage detail and run logs. If the run executed on another computer, open Specrails there, then check again.')).toBeInTheDocument()
    const technicalDetail = screen.getByTestId('agent-pr-recovery-technical-detail')
    expect(technicalDetail).not.toHaveAttribute('open')
    expect(within(technicalDetail).getByText('Technical recovery detail')).toBeInTheDocument()
    expect(within(technicalDetail).getByText('raw recovery scan detail that must not be shown')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Commit & retry push' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Inspect local result' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Checkout' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard local result' })).not.toBeInTheDocument()
  })

  it('offers exactly one explicit local-result discard when unavailable recovery has a protected SHA', () => {
    render(<AgentPrDecisionCard envelope={unavailableRecoveryEnv({ deliverySha: 'b'.repeat(40) })} />)

    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Discard local result' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Dismiss follow-up' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Commit & retry push' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Checkout' })).not.toBeInTheDocument()
  })

  it('never presents Checkout without a verified delivery SHA or while delivery is blocked', () => {
    const missingSha = render(<AgentPrDecisionCard envelope={env({
      decision: 'pr_ready',
      prUrl: 'https://github.com/o/r/pull/7',
      prState: 'pr-created',
      branch: 'feat/review',
      implementationOutcome: 'succeeded',
      deliveryOutcome: 'delivered',
    })} />)
    expect(screen.queryByRole('button', { name: 'Checkout' })).not.toBeInTheDocument()
    missingSha.unmount()

    render(<AgentPrDecisionCard envelope={recoverableBlockedEnv({ deliverySha: 'b'.repeat(40) })} />)
    expect(screen.queryByRole('button', { name: 'Checkout' })).not.toBeInTheDocument()
  })

  it('discloses durable safety archives separately from cleanup warnings', () => {
    render(<AgentPrDecisionCard envelope={env({
      decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/45', prState: 'pr-created',
      safetyArchives: ['/worktrees/ticket-4.specrails-overlay-quarantine-a1/CLAUDE.md'],
      cleanupWarnings: [],
    })} />)

    const archives = screen.getByTestId('agent-pr-safety-archives')
    expect(archives).toHaveTextContent('Safety archive (1)')
    expect(archives).toHaveTextContent('ticket-4.specrails-overlay-quarantine-a1/CLAUDE.md')
    expect(screen.queryByTestId('agent-pr-cleanup-warning')).toBeNull()
  })

  it('keeps a terminal Dismiss cleanup warning and recovery path visible in Agent history', () => {
    render(<AgentPrDecisionCard envelope={env({
      decision: 'discarded', isContinuation: true,
      cleanupWarnings: ['worktree /wt/recoverable-follow-up: preserved for inspection because it already requires review'],
    })} />)

    const warning = screen.getByTestId('agent-pr-cleanup-warning')
    expect(warning).toHaveTextContent('Cleanup is incomplete (1 warning)')
    expect(warning).toHaveTextContent('/wt/recoverable-follow-up')
    expect(screen.queryByRole('button', { name: 'Dismiss follow-up' })).not.toBeInTheDocument()
  })

  it('partial and no-change outcomes use truthful counts and actions', () => {
    const partial = render(<AgentPrDecisionCard envelope={env({
      implementationOutcome: 'partially_succeeded',
      deliveryOutcome: 'partial',
      units: [
        { ticketId: 4, branch: 'feat/4', succeeded: true, implementationOutcome: 'succeeded', deliveryOutcome: 'ready', initialSha: null, finalSha: 'abc' },
        { ticketId: 7, branch: 'feat/7', succeeded: false, implementationOutcome: 'failed', deliveryOutcome: 'not_started', initialSha: null, finalSha: null, failureCode: 'loop_failed' },
      ],
    })} />)
    expect(screen.getByText('Partially implemented')).toBeInTheDocument()
    expect(screen.getByText('1 of 2 completed; 1 failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create PR with 1' })).toBeInTheDocument()
    partial.unmount()

    render(<AgentPrDecisionCard envelope={env({ decision: 'no_changes', implementationOutcome: 'succeeded', deliveryOutcome: 'no_changes', isContinuation: true })} />)
    expect(screen.getByText('No changes needed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create PR' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss follow-up' })).toBeInTheDocument()
  })

  it('keeps partial evidence while advancing to draft and ready PR lifecycle actions', () => {
    const partialOutcome = {
      implementationOutcome: 'partially_succeeded' as const,
      deliveryOutcome: 'partial' as const,
      units: [
        { ticketId: 4, branch: 'feat/4', succeeded: true, implementationOutcome: 'succeeded' as const, deliveryOutcome: 'ready' as const, initialSha: null, finalSha: 'abc' },
        { ticketId: 7, branch: 'feat/7', succeeded: false, implementationOutcome: 'failed' as const, deliveryOutcome: 'not_started' as const, initialSha: null, finalSha: null },
      ],
    }
    const draft = render(<AgentPrDecisionCard envelope={env({
      ...partialOutcome, decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created',
    })} />)
    expect(screen.getByText('1 of 2 completed; 1 failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create PR with 1' })).not.toBeInTheDocument()
    draft.unmount()

    render(<AgentPrDecisionCard envelope={env({
      ...partialOutcome, decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created',
    })} />)
    expect(screen.getByText('1 of 2 completed; 1 failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verify PR' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create PR with 1' })).not.toBeInTheDocument()
  })

  it('partial with zero delivery-ready units is blocked and offers no create/retry action', () => {
    render(<AgentPrDecisionCard envelope={env({
      decision: 'pr_failed', implementationOutcome: 'partially_succeeded', deliveryOutcome: 'partial', isContinuation: true,
      units: [
        { ticketId: 4, branch: 'feat/4', succeeded: false, implementationOutcome: 'succeeded', deliveryOutcome: 'blocked', initialSha: null, finalSha: null, failureCode: 'commit_failed' },
        { ticketId: 7, branch: 'feat/7', succeeded: false, implementationOutcome: 'failed', deliveryOutcome: 'not_started', initialSha: null, finalSha: null },
      ],
    })} />)
    expect(screen.getByText('Implementation complete — delivery needs attention')).toBeInTheDocument()
    expect(screen.getByText(/Part of the implementation succeeded, but nothing is safely deliverable yet/)).toBeInTheDocument()
    expect(screen.queryByText(/^Implementation succeeded, but delivery is blocked/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Create/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss follow-up' })).toBeInTheDocument()
  })

  it('fresh no-change offers honest Done/Refine paths and completed is terminal history', () => {
    const fresh = render(<AgentPrDecisionCard envelope={env({
      decision: 'no_changes', implementationOutcome: 'succeeded', deliveryOutcome: 'no_changes',
    })} />)
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refine' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
    fresh.unmount()

    render(<AgentPrDecisionCard envelope={env({
      decision: 'completed', implementationOutcome: 'succeeded', deliveryOutcome: 'no_changes',
    })} />)
    expect(screen.getByText('No changes needed')).toBeInTheDocument()
    expect(screen.getByText('Confirmed — specs moved to Done')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Refine' })).not.toBeInTheDocument()
  })

  it('retryable push and closed PR expose only their safe recovery actions', () => {
    const retryable = render(<AgentPrDecisionCard envelope={env({
      decision: 'pr_failed', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created',
      implementationOutcome: 'succeeded', deliveryOutcome: 'retryable_failure', statusCode: 'push_failed', isContinuation: true,
    })} />)
    expect(screen.getByText('Implementation complete — update failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry push' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss follow-up' })).toBeInTheDocument()
    retryable.unmount()

    render(<AgentPrDecisionCard envelope={env({ decision: 'pr_closed', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created', isContinuation: true })} />)
    expect(screen.getByText('PR closed without merge')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss follow-up' })).toBeInTheDocument()
  })

  it('shows Retry push for a recovered legacy settlement interruption, never the blocked card', () => {
    render(<AgentPrDecisionCard envelope={env({
      decision: 'pr_failed', prUrl: 'https://github.com/o/r/pull/7', prState: 'local-only',
      implementationOutcome: 'succeeded', deliveryOutcome: 'retryable_failure',
      statusCode: 'settlement_interrupted', isContinuation: true,
    })} />)

    expect(screen.getByRole('button', { name: 'Retry push' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss follow-up' })).toBeInTheDocument()
    expect(screen.queryByText('Implementation complete — delivery needs attention')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard local result' })).not.toBeInTheDocument()
  })

  it('shows implementation failure when contradictory delivery fields are also present', () => {
    render(<AgentPrDecisionCard envelope={env({
      decision: 'implementation_failed', implementationOutcome: 'failed',
      deliveryOutcome: 'blocked', statusCode: 'commit_failed', runIds: ['run-1'],
    })} />)

    expect(screen.getByText('Implementation failed')).toBeInTheDocument()
    expect(screen.getByText(/implementation run failed/)).toBeInTheDocument()
    expect(screen.queryByText('Implementation complete — delivery needs attention')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry push' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
  })

  it('labels retryable PR creation distinctly from a push retry or blocked delivery', () => {
    const draft = render(<AgentPrDecisionCard envelope={env({
      decision: 'pr_draft', prState: 'pushed', branch: 'sr/acme/batch-x',
      implementationOutcome: 'succeeded', deliveryOutcome: 'retryable_failure', statusCode: 'delivery_failed',
    })} />)
    expect(screen.getByRole('button', { name: 'Retry PR' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Integrate locally' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry push' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.queryByText('Implementation complete — delivery needs attention')).not.toBeInTheDocument()
    draft.unmount()

    render(<AgentPrDecisionCard envelope={env({
      decision: 'pr_failed', prState: 'local-only',
      implementationOutcome: 'succeeded', deliveryOutcome: 'retryable_failure', statusCode: 'delivery_failed',
    })} />)
    expect(screen.getByRole('button', { name: 'Retry PR' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Integrate locally' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry push' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.queryByText('Implementation complete — delivery needs attention')).not.toBeInTheDocument()
  })

  it('renders the durable operation lease and disables every competing action', () => {
    render(<AgentPrDecisionCard envelope={env({
      decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created', operation: 'publish',
    })} />)
    expect(screen.getByTestId('agent-pr-operation')).toHaveTextContent('Publishing…')
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled()
  })

  it('restart-interrupted action detail is localized and leaves the recovered card actionable', () => {
    render(<AgentPrDecisionCard envelope={env({
      operation: null, statusCode: 'operation_interrupted', statusDetail: interruptedActionDetail,
    })} />)

    expect(screen.getByTestId('agent-pr-status-code')).toHaveTextContent('Previous delivery action interrupted')
    expect(screen.getByTestId('agent-pr-recovery-interrupted')).toHaveTextContent(
      'A previous delivery action was interrupted during restart. Your work was preserved; review the current state and retry when ready.',
    )
    expect(screen.queryByText(interruptedActionDetail)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create PR' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled()
  })

  // Terminal/building cards carry NO decision actions — the only buttons left
  // are the always-present clickable ticket ref chips (#N → TicketDetailModal).
  const nonChipButtons = () =>
    screen.queryAllByRole('button').filter((b) => b.getAttribute('data-testid') !== 'agent-ref-chip')

  it('merged: static success note, no action buttons', () => {
    render(<AgentPrDecisionCard envelope={env({ decision: 'merged', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created' })} />)
    expect(screen.getByText('Merged — specs moved to Done')).toBeInTheDocument()
    expect(nonChipButtons()).toHaveLength(0)
  })

  it('discarded: static muted note, no action buttons', () => {
    render(<AgentPrDecisionCard envelope={env({ decision: 'discarded' })} />)
    expect(screen.getByText('Discarded — specs returned to the backlog')).toBeInTheDocument()
    expect(nonChipButtons()).toHaveLength(0)
  })

  it('building: isolated-worktree shimmer + settle hint, no actions', () => {
    render(<AgentPrDecisionCard envelope={env({ decision: 'building' })} />)
    expect(screen.getByText('Implementing in an isolated worktree…')).toBeInTheDocument()
    expect(screen.getByText("You'll be asked to create the PR when it settles.")).toBeInTheDocument()
    expect(nonChipButtons()).toHaveLength(0)
  })

  it('building on an existing PR: calls out the PR and head branch immediately', () => {
    render(<AgentPrDecisionCard envelope={env({
      decision: 'building',
      prUrl: 'https://github.com/o/r/pull/2147',
      prNumber: 2147,
      prState: 'pr-created',
      branch: 'feat/SKILLS-19-key-terms-activity',
    })} />)
    expect(screen.getByText('Applying changes to an existing PR…')).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveTextContent('#2147')
    expect(screen.getByText('feat/SKILLS-19-key-terms-activity')).toBeInTheDocument()
    expect(screen.getByText(/push the review changes back to that PR/)).toBeInTheDocument()
    expect(nonChipButtons()).toHaveLength(0)
  })
})

// ── AgentPrDecisionCard: actions ──────────────────────────────────────────────
describe('AgentPrDecisionCard actions', () => {
  it('Create PR posts to the CARD project (not the active one) and disables while in flight', async () => {
    let resolveFetch!: (v: unknown) => void
    global.fetch = vi.fn(() => new Promise((r) => { resolveFetch = r })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({ projectId: 'p2' })} />)
    const btn = screen.getByRole('button', { name: 'Create PR' })
    await act(async () => { fireEvent.click(btn) })
    expect(btn).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled()
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/p2/rails/pr-decision',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ prDeliveryId: 'd1', action: 'create-pr', expectedDecision: 'on_review' }),
      }),
    )
    await act(async () => { resolveFetch(httpRes(200, { ok: true, decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7' })) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create PR' })).toBeEnabled())
  })

  it('409 stale_decision → neutral "already resolved" toast (never an error)', async () => {
    global.fetch = vi.fn(async () => httpRes(409, { error: 'stale_decision', current: 'pr_draft' })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env()} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create PR' })) })
    await waitFor(() => expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Already resolved elsewhere'))
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('surfaces an actual conflict instead of falsely reporting it resolved', async () => {
    global.fetch = vi.fn(async () => httpRes(409, { error: 'delivery_not_verified', detail: 'Commit evidence is missing.' })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env()} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create PR' })) })
    expect(toast.error).toHaveBeenCalledWith(expect.any(String), { description: 'Commit evidence is missing.' })
    expect(toast.info).not.toHaveBeenCalledWith('Already resolved elsewhere')
  })

  it('409 project recovery reports a safe temporary pause instead of stale/destructive feedback', async () => {
    global.fetch = vi.fn(async () => httpRes(409, { error: 'project_recovery_in_progress' })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env()} />)
    const create = screen.getByRole('button', { name: 'Create PR' })
    await act(async () => { fireEvent.click(create) })

    await waitFor(() => expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
      'Project recovery is still in progress. Your delivery is safe — retry in a moment.',
    ))
    expect(vi.mocked(toast.info)).not.toHaveBeenCalledWith('Already resolved elsewhere')
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    expect(create).toBeEnabled()
  })

  it('checkout 409 project recovery uses the same safe temporary feedback', async () => {
    global.fetch = vi.fn(async () => httpRes(409, { error: 'project_recovery_in_progress' })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({
      decision: 'pr_ready', branch: 'feat/review', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created',
      deliverySha: 'a'.repeat(40),
    })} />)
    const checkout = screen.getByRole('button', { name: 'Checkout' })
    await act(async () => { fireEvent.click(checkout) })

    await waitFor(() => expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
      'Project recovery is still in progress. Your delivery is safe — retry in a moment.',
    ))
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    expect(checkout).toBeEnabled()
  })

  it.each([
    [
      'checkout_dirty',
      'Checkout blocked to protect your changes',
      'The main project folder has uncommitted changes. Commit or stash them, then retry. Nothing was changed.',
    ],
    [
      'checkout_not_deliverable',
      'This branch is not the preserved implementation',
      'No exact delivery commit has been verified yet. Inspect or recover the local result instead.',
    ],
    [
      'checkout_safety_unknown',
      'Checkout paused because safety could not be verified',
      'Specrails could not read the main project folder’s Git status. Nothing was released or changed. Retry after Git is available.',
    ],
  ])('localizes the %s checkout guard without exposing raw server copy', async (error, title, body) => {
    global.fetch = vi.fn(async () => httpRes(409, { error, detail: 'raw server detail' })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({
      decision: 'pr_ready', branch: 'feat/review', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created',
      deliverySha: 'a'.repeat(40), implementationOutcome: 'succeeded', deliveryOutcome: 'delivered',
    })} />)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Checkout' })) })

    await waitFor(() => expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(title, { description: body }))
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalledWith(expect.anything(), { description: 'raw server detail' })
  })

  it('copies and reveals the preserved worktree from Inspect local result', async () => {
    tauriMocks.isTauri.mockReturnValue(true)
    render(<AgentPrDecisionCard envelope={recoverableBlockedEnv()} />)

    await act(async () => { fireEvent.click(screen.getByTestId('agent-pr-inspect-local-result')) })

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(recoveryWorktreePath)
    expect(tauriMocks.revealItemInDir).toHaveBeenCalledWith(recoveryWorktreePath)
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Local result path copied', { description: recoveryWorktreePath })
    expect(vi.mocked(global.fetch).mock.calls.some(([url]) => String(url).includes('/rails/pr-decision'))).toBe(false)
  })

  it('still reveals the preserved worktree when clipboard access is unavailable', async () => {
    tauriMocks.isTauri.mockReturnValue(true)
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('clipboard denied'))
    render(<AgentPrDecisionCard envelope={recoverableBlockedEnv()} />)

    await act(async () => { fireEvent.click(screen.getByTestId('agent-pr-inspect-local-result')) })

    expect(tauriMocks.revealItemInDir).toHaveBeenCalledWith(recoveryWorktreePath)
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Preserved local result', { description: recoveryWorktreePath })
  })

  it('confirms Commit & retry push, posts the recovery action, and reports the verified SHA', async () => {
    const sha = 'c'.repeat(40)
    global.fetch = vi.fn(async () => httpRes(200, {
      ok: true,
      decision: 'merged',
      merged: true,
      prUrl: 'https://github.com/o/r/pull/7',
      prState: 'pr-created',
      deliveryVerified: true,
      verifiedSha: sha,
      remoteHeadSha: sha,
      pushed: false,
    })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={recoverableBlockedEnv()} />)

    fireEvent.click(screen.getByTestId('agent-pr-recover-and-retry'))
    const dialog = screen.getByTestId('agent-pr-recover-and-retry-confirm')
    expect(dialog).toHaveTextContent('Commit and push the preserved result?')
    expect(dialog).toHaveTextContent('Your main project folder and its uncommitted changes will not be touched')
    expect(vi.mocked(global.fetch).mock.calls.some(([url]) => String(url).includes('/rails/pr-decision'))).toBe(false)

    await act(async () => { fireEvent.click(screen.getByTestId('agent-pr-recover-and-retry-confirm-btn')) })

    expect(global.fetch).toHaveBeenCalledWith('/api/projects/p1/rails/pr-decision', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ prDeliveryId: 'd1', action: 'recover-and-retry', expectedDecision: 'pr_failed' }),
    }))
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Recovered commit cccccccc is verified in the PR',
    ))
  })

  it('keeps recovery visibly blocked when the server cannot verify a safe delivery commit', async () => {
    global.fetch = vi.fn(async () => httpRes(200, {
      ok: true,
      decision: 'pr_failed',
      prUrl: 'https://github.com/o/r/pull/7',
      prState: 'pr-created',
      deliveryVerified: false,
      detail: 'No unique fast-forward candidate remains.',
    })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={recoverableBlockedEnv()} />)

    fireEvent.click(screen.getByTestId('agent-pr-recover-and-retry'))
    await act(async () => { fireEvent.click(screen.getByTestId('agent-pr-recover-and-retry-confirm-btn')) })

    await waitFor(() => expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      'Local recovery still needs attention',
      { description: 'No unique fast-forward candidate remains.' },
    ))
  })

  it('confirms Check again and reports unavailable recovery with localized, non-destructive feedback', async () => {
    global.fetch = vi.fn(async () => httpRes(200, {
      ok: true,
      decision: 'pr_failed',
      prUrl: 'https://github.com/o/r/pull/7',
      prState: 'pr-created',
      deliveryVerified: false,
      recoveryUnavailable: true,
      detail: 'raw scan result',
    })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={unavailableRecoveryEnv()} />)

    fireEvent.click(screen.getByTestId('agent-pr-recheck-recovery'))
    const dialog = screen.getByTestId('agent-pr-recover-and-retry-confirm')
    expect(dialog).toHaveTextContent('Check this computer again?')
    expect(dialog).toHaveTextContent('Specrails will rescan this clone’s delivery-owned worktree, branch, refs, reflogs, and orphan Git objects for feat/review')
    expect(dialog).toHaveTextContent('Your main project folder will not be touched')
    expect(vi.mocked(global.fetch).mock.calls.some(([url]) => String(url).includes('/rails/pr-decision'))).toBe(false)

    await act(async () => { fireEvent.click(screen.getByTestId('agent-pr-recover-and-retry-confirm-btn')) })

    expect(global.fetch).toHaveBeenCalledWith('/api/projects/p1/rails/pr-decision', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ prDeliveryId: 'd1', action: 'recover-and-retry', expectedDecision: 'pr_failed' }),
    }))
    await waitFor(() => expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
      'Recovery could not be verified on this computer',
      { description: 'Specrails could not safely prove one delivery-owned result in this clone. Nothing was changed or removed. Inspect the stage detail and run logs. If the run executed on another computer, open Specrails there, then check again.' },
    ))
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalledWith(
      'Local recovery still needs attention',
      { description: 'raw scan result' },
    )
  })

  it('409 operation_in_progress is busy, applies the lease snapshot, and never says already resolved', async () => {
    global.fetch = vi.fn(async () => httpRes(409, {
      error: 'operation_in_progress', current: 'pr_draft', operation: 'publish',
      snapshot: {
        id: 'd1', railIndex: 0, railKey: '0-impl', ticketIds: [4, 7], baseBranch: 'main', branch: 'feat/review',
        prUrl: 'https://github.com/o/r/pull/7', prNumber: 7, prState: 'pr-created', decision: 'pr_draft', runIds: [], originConversationId: 'c1', operation: 'publish',
      },
    })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created' })} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Publish' })) })
    await waitFor(() => expect(screen.getByTestId('agent-pr-operation')).toHaveTextContent('Publishing…'))
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled()
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Publishing…')
    expect(vi.mocked(toast.info)).not.toHaveBeenCalledWith('Already resolved elsewhere')
  })

  it('502 gh_failed → error toast with the detail', async () => {
    global.fetch = vi.fn(async () => httpRes(502, { error: 'gh_failed', detail: 'gh: not logged in' })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created' })} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Publish' })) })
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Action failed', { description: 'gh: not logged in' }),
    )
  })

  it('poll-merge that is not merged yet → neutral toast, card unchanged', async () => {
    global.fetch = vi.fn(async () => httpRes(200, { ok: true, decision: 'pr_ready', merged: false })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({ decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/12', prState: 'pr-created' })} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Verify PR' })) })
    await waitFor(() => expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Not merged yet'))
    expect(screen.getByRole('button', { name: 'Verify PR' })).toBeEnabled()
  })

  it('poll-merge CLOSED transitions to the explicit closed state without a contradictory not-merged toast', async () => {
    global.fetch = vi.fn(async () => httpRes(200, {
      ok: true, decision: 'pr_closed', merged: false,
      snapshot: {
        id: 'd1', railIndex: 0, railKey: '0-impl', ticketIds: [4, 7], baseBranch: 'main', branch: 'feat/review',
        prUrl: 'https://github.com/o/r/pull/12', prNumber: 12, prState: 'pr-created', decision: 'pr_closed', runIds: [], originConversationId: 'c1',
      },
    })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({ decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/12', prState: 'pr-created' })} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Verify PR' })) })
    await waitFor(() => expect(screen.getByText('PR closed without merge')).toBeInTheDocument())
    expect(vi.mocked(toast.info)).not.toHaveBeenCalledWith('Not merged yet')
  })

  it('fresh discard explains its consequences in a dialog before firing the POST', async () => {
    global.fetch = vi.fn(async () => httpRes(200, { ok: true, decision: 'discarded' })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    const dialog = screen.getByTestId('agent-pr-discard-confirm')
    expect(dialog).toHaveTextContent('Discard this delivery?')
    expect(dialog).toHaveTextContent('PR will be closed without deleting its remote branch')
    expect(dialog).toHaveTextContent('SpecRails-owned local branches and worktrees that are still at their recorded commit')
    expect(dialog).toHaveTextContent('anything changed will be preserved with a warning')
    expect(dialog).toHaveTextContent('specs will return to the backlog')
    expect(dialog).toHaveTextContent('Removed local resources cannot be recovered')
    expect(global.fetch).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByTestId('agent-pr-discard-confirm-btn')) })
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/p1/rails/pr-decision',
      expect.objectContaining({
        body: JSON.stringify({ prDeliveryId: 'd1', action: 'discard', expectedDecision: 'on_review' }),
      }),
    )
  })

  it('cancelling fresh discard leaves the delivery untouched', async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByTestId('agent-pr-discard-confirm')).not.toBeInTheDocument())
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('applies the authoritative HTTP snapshot immediately when the WS transition is lost', async () => {
    global.fetch = vi.fn(async () => httpRes(200, {
      ok: true,
      decision: 'pr_failed',
      detail: 'remote temporarily unavailable',
      snapshot: {
        id: 'd1', railIndex: 0, railKey: '0-impl', ticketIds: [4, 7], baseBranch: 'main', branch: 'feat/batch',
        prUrl: null, prNumber: null, prState: 'local-only', decision: 'pr_failed', runIds: [], originConversationId: 'c1',
        implementationOutcome: 'succeeded', deliveryOutcome: 'retryable_failure', statusCode: 'push_failed', statusDetail: 'remote temporarily unavailable',
      },
    })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env()} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create PR' })) })
    await waitFor(() => expect(screen.getByText('Implementation complete — update failed')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Retry push' })).toBeInTheDocument()
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Implementation complete; delivery needs attention', { description: 'remote temporarily unavailable' })
  })

  it('confirms the exact SHA after Retry push and immediately renders the verified PR state', async () => {
    const sha = 'a'.repeat(40)
    global.fetch = vi.fn(async () => httpRes(200, {
      ok: true, decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created',
      deliveryVerified: true, verifiedSha: sha, remoteHeadSha: sha, pushed: true,
      snapshot: {
        id: 'd1', railIndex: 0, railKey: '0-impl', ticketIds: [4, 7], baseBranch: 'main',
        branch: 'feat/review', prUrl: 'https://github.com/o/r/pull/7', prNumber: 7,
        prState: 'pr-created', decision: 'pr_ready', runIds: [], originConversationId: 'c1',
        implementationOutcome: 'succeeded', deliveryOutcome: 'delivered', statusCode: 'pr_ready',
        statusDetail: null, deliverySha: sha,
      },
    })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({
      decision: 'pr_failed', prUrl: 'https://github.com/o/r/pull/7', prState: 'local-only',
      branch: 'feat/review', implementationOutcome: 'succeeded',
      deliveryOutcome: 'retryable_failure', statusCode: 'push_failed', deliverySha: sha,
    })} />)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry push' })) })

    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Push verified · commit aaaaaaaa is in the PR',
    ))
    expect(screen.getByRole('button', { name: 'Verify PR' })).toBeInTheDocument()
    expect(screen.getByTestId('agent-pr-delivery-sha')).toHaveTextContent('commit aaaaaaaa')
    expect(screen.queryByRole('button', { name: 'Retry push' })).toBeNull()
  })

  it('restores Retry push when Verify PR proves the commit is missing', async () => {
    const sha = 'a'.repeat(40)
    global.fetch = vi.fn(async () => httpRes(200, {
      ok: true, decision: 'pr_failed', prUrl: 'https://github.com/o/r/pull/7',
      deliveryVerified: false, verifiedSha: sha, remoteHeadSha: 'b'.repeat(40),
      snapshot: {
        id: 'd1', railIndex: 0, railKey: '0-impl', ticketIds: [4, 7], baseBranch: 'main',
        branch: 'feat/review', prUrl: 'https://github.com/o/r/pull/7', prNumber: 7,
        prState: 'pr-created', decision: 'pr_failed', runIds: [], originConversationId: 'c1',
        implementationOutcome: 'succeeded', deliveryOutcome: 'retryable_failure', statusCode: 'push_failed',
        statusDetail: 'the open PR no longer exposes the verified implementation commit', deliverySha: sha,
      },
    })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({
      decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created',
      branch: 'feat/review', implementationOutcome: 'succeeded',
      deliveryOutcome: 'delivered', statusCode: 'pr_ready', deliverySha: sha,
    })} />)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Verify PR' })) })

    await waitFor(() => expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      'The delivery commit is no longer in the PR. Retry push is available again.',
    ))
    expect(screen.getByRole('button', { name: 'Retry push' })).toBeInTheDocument()
    expect(vi.mocked(toast.info)).not.toHaveBeenCalledWith('Not merged yet')
  })

  it('local integration requires an explicit repository-changing confirmation', async () => {
    global.fetch = vi.fn(async () => httpRes(200, { ok: true, decision: 'merged' })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Integrate locally' }))
    expect(screen.getByTestId('agent-pr-merge-local-confirm')).toHaveTextContent('merged into main')
    expect(global.fetch).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByTestId('agent-pr-merge-local-confirm-btn')) })
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/p1/rails/pr-decision', expect.objectContaining({
      body: JSON.stringify({ prDeliveryId: 'd1', action: 'merge-local', expectedDecision: 'on_review' }),
    }))
  })

  it('confirms both fresh no-change outcomes and posts their distinct actions', async () => {
    global.fetch = vi.fn(async () => httpRes(200, { ok: true })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({ decision: 'no_changes', implementationOutcome: 'succeeded', deliveryOutcome: 'no_changes' })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }))
    expect(screen.getByTestId('agent-pr-no-changes-done-confirm')).toHaveTextContent('specs will move to Done')
    expect(global.fetch).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByTestId('agent-pr-no-changes-done-confirm-btn')) })
    expect(global.fetch).toHaveBeenLastCalledWith('/api/projects/p1/rails/pr-decision', expect.objectContaining({
      body: JSON.stringify({ prDeliveryId: 'd1', action: 'acknowledge-no-changes', expectedDecision: 'no_changes' }),
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Refine' }))
    expect(screen.getByTestId('agent-pr-refine-confirm')).toHaveTextContent('return to the backlog')
    await act(async () => { fireEvent.click(screen.getByTestId('agent-pr-refine-confirm-btn')) })
    expect(global.fetch).toHaveBeenLastCalledWith('/api/projects/p1/rails/pr-decision', expect.objectContaining({
      body: JSON.stringify({ prDeliveryId: 'd1', action: 'discard', expectedDecision: 'no_changes' }),
    }))
  })

  it('a network failure surfaces the error toast and re-enables the buttons', async () => {
    global.fetch = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env()} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create PR' })) })
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Action failed', { description: 'offline' }))
    expect(screen.getByRole('button', { name: 'Create PR' })).toBeEnabled()
  })
})

// ── Context: agent_pr_decision WS upsert/append ───────────────────────────────
function Harness() {
  const a = useAgentChat()
  const cards = a.messages
    .filter((m) => m.role === 'system')
    .map((m) => {
      const e = agentApi.parsePrDecisionEnvelope(m.content)
      return e ? `${e.prDeliveryId}:${e.decision}` : '<foreign>'
    })
  return (
    <div>
      <span data-testid="msgs">{a.messages.length}</span>
      <span data-testid="cards">{cards.join(',')}</span>
      <button onClick={a.open}>open</button>
    </div>
  )
}

const wsEnvelope = (over: Partial<AgentPrDecisionEnvelope> = {}, conversationId = 'c1') => ({
  type: 'agent_pr_decision',
  conversationId,
  timestamp: new Date().toISOString(),
  ...env(over),
})

describe('AgentChatContext agent_pr_decision', () => {
  it('appends a synthetic system card on live arrival, then upserts the SAME card in place', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(agentApi.createAgentConversation).toHaveBeenCalled())

    await act(async () => { wsHandler!(wsEnvelope({ decision: 'on_review' })) })
    expect(screen.getByTestId('msgs').textContent).toBe('1')
    expect(screen.getByTestId('cards').textContent).toBe('d1:on_review')

    // Same prDeliveryId → in-place update, no duplicate card.
    await act(async () => { wsHandler!(wsEnvelope({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created' })) })
    expect(screen.getByTestId('msgs').textContent).toBe('1')
    expect(screen.getByTestId('cards').textContent).toBe('d1:pr_draft')

    // A different delivery appends its own card.
    await act(async () => { wsHandler!(wsEnvelope({ prDeliveryId: 'd2', railIndex: 1 })) })
    expect(screen.getByTestId('msgs').textContent).toBe('2')
    expect(screen.getByTestId('cards').textContent).toBe('d1:pr_draft,d2:on_review')
  })

  it('ignores cards for other conversations and malformed envelopes', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(agentApi.createAgentConversation).toHaveBeenCalled())

    await act(async () => { wsHandler!(wsEnvelope({}, 'OTHER')) })
    expect(screen.getByTestId('msgs').textContent).toBe('0')

    // Missing prDeliveryId → coercion rejects, nothing appended.
    const bad = { ...wsEnvelope(), prDeliveryId: undefined }
    await act(async () => { wsHandler!(bad) })
    expect(screen.getByTestId('msgs').textContent).toBe('0')
  })
})

// ── Render branch: system rows in the conversation view ──────────────────────
describe('system-row rendering in the conversation view', () => {
  it('renders the PR card for pr_decision rows and nothing for foreign system rows', async () => {
    const messages: ApiAgentMessage[] = [
      { id: 'a1', conversation_id: 'c1', role: 'assistant', content: 'Launched the rail.', created_at: '' },
      { id: 's1', conversation_id: 'c1', role: 'system', content: JSON.stringify(env()), created_at: '' },
      { id: 's2', conversation_id: 'c1', role: 'system', content: '{"kind":"weird","x":1}', created_at: '' },
      { id: 's3', conversation_id: 'c1', role: 'system', content: 'not json at all', created_at: '' },
    ]
    vi.mocked(agentApi.listAgentConversations).mockResolvedValue([api.conv])
    vi.mocked(agentApi.getAgentConversation).mockResolvedValue({ conversation: api.conv, messages })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('msgs').textContent).toBe('4'))

    // The pr_decision card renders (actionable), the assistant bubble renders,
    // the foreign/unparseable system rows render NOTHING (no raw JSON leak).
    expect(await screen.findByText('Implementation ready for review')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create PR' })).toBeInTheDocument()
    expect(screen.getByText('Launched the rail.')).toBeInTheDocument()
    expect(screen.queryByText(/"kind":"weird"/)).not.toBeInTheDocument()
    expect(screen.queryByText('not json at all')).not.toBeInTheDocument()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unrenderable system message'))
  })

  it('a live agent_pr_decision renders the card in the open panel without reload', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(agentApi.createAgentConversation).toHaveBeenCalled())

    await act(async () => { wsHandler!(wsEnvelope()) })
    expect(await screen.findByText('Implementation ready for review')).toBeInTheDocument()

    // The follow-up transition swaps the SAME card to its pr_draft state.
    await act(async () => { wsHandler!(wsEnvelope({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/9', prState: 'pr-created' })) })
    expect(await screen.findByText('Draft PR created')).toBeInTheDocument()
    expect(screen.queryByText('Implementation ready for review')).not.toBeInTheDocument()
  })
})
