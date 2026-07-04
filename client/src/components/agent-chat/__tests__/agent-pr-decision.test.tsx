import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

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
vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects, activeProjectId: 'p1', setActiveProjectId: vi.fn() }),
}))

const mockOpenWebView = vi.fn()
vi.mock('../../../context/WebViewModalContext', () => ({
  useWebViewModal: () => ({ openWebView: mockOpenWebView, canOpenWebView: false }),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), success: vi.fn() }),
  Toaster: () => null,
}))

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
  prState: 'none',
  branch: null,
  runIds: [],
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
  vi.mocked(agentApi.listAgentConversations).mockResolvedValue([])
  vi.mocked(agentApi.createAgentConversation).mockResolvedValue(api.conv)
  vi.mocked(agentApi.getAgentConversation).mockResolvedValue({ conversation: api.conv, messages: [] })
  vi.mocked(agentApi.getMcpStatus).mockResolvedValue({ enabled: true, running: true })
})

// ── AgentPrDecisionCard: state matrix ─────────────────────────────────────────
describe('AgentPrDecisionCard states', () => {
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

  it('falls back to the raw projectId when the project is unknown', () => {
    render(<AgentPrDecisionCard envelope={env({ projectId: 'gone' })} />)
    expect(screen.getByText('gone')).toBeInTheDocument()
  })

  it('pr_draft with a PR: Publish + Discard + #number link, no Create PR', () => {
    render(<AgentPrDecisionCard envelope={env({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created', branch: 'sr/acme/batch-x' })} />)
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

  it('pr_ready: Check merge + Discard + link', () => {
    render(<AgentPrDecisionCard envelope={env({ decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/12', prState: 'pr-created' })} />)
    expect(screen.getByText('PR ready for merge')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check merge' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveTextContent('#12')
  })

  it('pr_failed: Retry + Discard', () => {
    render(<AgentPrDecisionCard envelope={env({ decision: 'pr_failed' })} />)
    expect(screen.getByText('PR creation failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
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
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check merge' })) })
    await waitFor(() => expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Not merged yet'))
    expect(screen.getByRole('button', { name: 'Check merge' })).toBeEnabled()
  })

  it('discard is a two-step confirm: first click arms, second fires the POST', async () => {
    global.fetch = vi.fn(async () => httpRes(200, { ok: true, decision: 'discarded' })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByRole('button', { name: 'Confirm discard?' })).toBeInTheDocument()
    expect(global.fetch).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm discard?' })) })
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/p1/rails/pr-decision',
      expect.objectContaining({
        body: JSON.stringify({ prDeliveryId: 'd1', action: 'discard', expectedDecision: 'on_review' }),
      }),
    )
  })

  it('an armed discard auto-resets after 3s without a second click', () => {
    vi.useFakeTimers()
    try {
      render(<AgentPrDecisionCard envelope={env()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
      expect(screen.getByRole('button', { name: 'Confirm discard?' })).toBeInTheDocument()
      act(() => { vi.advanceTimersByTime(3100) })
      expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
      expect(global.fetch).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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
