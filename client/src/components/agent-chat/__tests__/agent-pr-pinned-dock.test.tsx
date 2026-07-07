import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'

// ── Mocks (mirror the agent-pr-decision harness) ──────────────────────────────
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

const conv = {
  id: 'c1', title: null, provider: 'claude', model: null, session_id: null,
  pinned_project_id: 'p1', tier_level: 0 as const, reasoning_effort: null,
  created_at: '', updated_at: '',
}
vi.mock('../../../lib/agent-api', async (orig) => {
  const actual = await orig<typeof import('../../../lib/agent-api')>()
  return {
    ...actual, // coerce/parsePrDecisionEnvelope stay REAL
    listAgentConversations: vi.fn(async () => [conv]),
    createAgentConversation: vi.fn(async () => conv),
    getAgentConversation: vi.fn(async () => ({ conversation: conv, messages: [] })),
    patchAgentConversation: vi.fn(async () => conv),
    deleteAgentConversation: vi.fn(async () => {}),
    sendAgentMessage: vi.fn(async () => ({ queued: false })),
    abortAgentTurn: vi.fn(async () => {}),
    editQueuedAgentMessage: vi.fn(async () => 'saved' as const),
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

import * as agentApi from '../../../lib/agent-api'
import type {
  AgentPrDecisionEnvelope,
  AgentPrDecisionValue,
  AgentMessage as ApiAgentMessage,
} from '../../../lib/agent-api'
import { AgentChatProvider, useAgentChat } from '../../../context/AgentChatContext'
import { AgentConversationView } from '../AgentConversationView'
import { derivePrCards, isPrDecisionPinned, PINNED_PR_DECISIONS } from '../agent-pr-pinning'

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

const sysRow = (id: string, over: Partial<AgentPrDecisionEnvelope> = {}): ApiAgentMessage => ({
  id, conversation_id: 'c1', role: 'system', content: JSON.stringify(env(over)), created_at: '',
})

const wsEnvelope = (over: Partial<AgentPrDecisionEnvelope> = {}) => ({
  type: 'agent_pr_decision',
  conversationId: 'c1',
  timestamp: new Date().toISOString(),
  ...env(over),
})

/** Opens the floating panel via the provider (mirrors the pr-decision harness). */
function Opener() {
  const a = useAgentChat()
  return <button onClick={a.open}>open-panel</button>
}

async function renderPanelWithMessages(messages: ApiAgentMessage[]) {
  vi.mocked(agentApi.getAgentConversation).mockResolvedValue({ conversation: conv, messages })
  render(<AgentChatProvider><Opener /></AgentChatProvider>)
  await act(async () => { fireEvent.click(screen.getByText('open-panel')) })
  await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
}

/** Mounts the INLINE surface's conversation body directly (Agent-Mode wiring). */
function InlineHarness() {
  const a = useAgentChat()
  return (
    <div>
      <button onClick={() => void a.selectConversation('c1')}>select</button>
      <AgentConversationView variant="inline" />
    </div>
  )
}

const dock = () => screen.queryByTestId('agent-pr-pinned-dock')
const markers = () => screen.queryAllByTestId('agent-pr-pinned-marker')
const fullCards = () => screen.queryAllByTestId('agent-pr-decision-card')

beforeEach(() => {
  wsHandler = null
  vi.clearAllMocks()
  sessionStorage.clear()
  vi.mocked(agentApi.listAgentConversations).mockResolvedValue([conv])
  vi.mocked(agentApi.createAgentConversation).mockResolvedValue(conv)
  vi.mocked(agentApi.getAgentConversation).mockResolvedValue({ conversation: conv, messages: [] })
})

// ── Pure derivation ───────────────────────────────────────────────────────────
describe('derivePrCards / pin-state matrix', () => {
  const matrix: Array<[AgentPrDecisionValue, boolean]> = [
    ['building', true],
    ['on_review', true],
    ['pr_draft', true],
    ['implementation_failed', true],
    ['pr_failed', true],
    ['pr_ready', false],
    ['merged', false],
    ['discarded', false],
  ]
  it.each(matrix)('%s → pinned=%s', (decision, pinned) => {
    expect(isPrDecisionPinned(decision)).toBe(pinned)
    expect(PINNED_PR_DECISIONS.has(decision)).toBe(pinned)
    const derived = derivePrCards([sysRow('s1', { decision })])
    expect(derived.byMessageId.size).toBe(1)
    expect(derived.pinned).toHaveLength(pinned ? 1 : 0)
  })

  it('skips non-system rows and unparseable system rows; keeps message order (newest last)', () => {
    const derived = derivePrCards([
      { id: 'u1', conversation_id: 'c1', role: 'user', content: 'go', created_at: '' },
      sysRow('s1', { prDeliveryId: 'd1', decision: 'building' }),
      { id: 'sX', conversation_id: 'c1', role: 'system', content: 'not json', created_at: '' },
      sysRow('s2', { prDeliveryId: 'd2', decision: 'on_review' }),
    ])
    expect(derived.byMessageId.size).toBe(2)
    expect(derived.pinned.map((p) => p.messageId)).toEqual(['s1', 's2'])
  })
})

// ── Pinned slot in the floating panel ─────────────────────────────────────────
describe('pinned dock (floating panel)', () => {
  it.each(['building', 'on_review', 'pr_draft', 'implementation_failed', 'pr_failed'] as const)(
    'a %s card is PINNED above the composer with a history marker in its slot',
    async (decision) => {
      await renderPanelWithMessages([sysRow('s1', { decision })])
      const d = await screen.findByTestId('agent-pr-pinned-dock')
      // The FULL card renders in the dock (reused verbatim)…
      expect(within(d).getByTestId('agent-pr-decision-card')).toBeInTheDocument()
      expect(fullCards()).toHaveLength(1) // …and ONLY there (no double render).
      // …while the chronological slot holds the slim reference marker.
      expect(markers()).toHaveLength(1)
      expect(screen.getByText('Implementation card — pinned above')).toBeInTheDocument()
    },
  )

  it.each(['pr_ready', 'merged', 'discarded'] as const)(
    'a %s card is UNPINNED: full card in history, no dock, no marker',
    async (decision) => {
      await renderPanelWithMessages([
        sysRow('s1', { decision, prUrl: decision === 'discarded' ? null : 'https://github.com/o/r/pull/7', prState: decision === 'discarded' ? 'none' : 'pr-created' }),
      ])
      await waitFor(() => expect(fullCards()).toHaveLength(1))
      expect(dock()).toBeNull()
      expect(markers()).toHaveLength(0)
    },
  )

  it('a conversation without PR cards renders no dock and no markers', async () => {
    await renderPanelWithMessages([
      { id: 'a1', conversation_id: 'c1', role: 'assistant', content: 'hello', created_at: '' },
    ])
    expect(await screen.findByText('hello')).toBeInTheDocument()
    expect(dock()).toBeNull()
    expect(markers()).toHaveLength(0)
    expect(fullCards()).toHaveLength(0)
  })

  it('unpins on the publish WS transition: dock away, full card back in its chronological slot', async () => {
    await renderPanelWithMessages([sysRow('s1', { decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created' })])
    await screen.findByTestId('agent-pr-pinned-dock')
    expect(markers()).toHaveLength(1)

    // The user publishes elsewhere → the same envelope moves to pr_ready.
    await act(async () => {
      wsHandler!(wsEnvelope({ decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created' }))
    })
    await waitFor(() => expect(dock()).toBeNull())
    expect(markers()).toHaveLength(0)
    // The full card returned to history in its pr_ready state.
    expect(fullCards()).toHaveLength(1)
    expect(screen.getByText('PR ready for merge')).toBeInTheDocument()
  })

  it('a live building arrival pins immediately (WS append, no reload)', async () => {
    await renderPanelWithMessages([])
    await act(async () => { wsHandler!(wsEnvelope({ decision: 'building' })) })
    const d = await screen.findByTestId('agent-pr-pinned-dock')
    expect(within(d).getByText('Implementing in an isolated worktree…')).toBeInTheDocument()
    expect(markers()).toHaveLength(1)
  })
})

// ── Multi-card stacking ───────────────────────────────────────────────────────
describe('multi-card stacking', () => {
  const twoPinned = [
    sysRow('s1', { prDeliveryId: 'd1', railIndex: 0, decision: 'on_review', ticketIds: [4] }),
    sysRow('s2', { prDeliveryId: 'd2', railIndex: 1, decision: 'pr_draft', ticketIds: [7], prUrl: 'https://github.com/o/r/pull/9', prState: 'pr-created' }),
  ]

  it('EVERY pinned delivery renders as its own full card, stacked oldest→newest', async () => {
    await renderPanelWithMessages(twoPinned)
    const d = await screen.findByTestId('agent-pr-pinned-dock')
    // Both full cards render in the dock…
    expect(within(d).getByText('Implementation ready for review')).toBeInTheDocument()
    expect(within(d).getByText('Draft PR created')).toBeInTheDocument()
    expect(within(d).getAllByTestId('agent-pr-decision-card')).toHaveLength(2)
    expect(fullCards()).toHaveLength(2)
    // …with per-card headers in message order (oldest first, newest by the composer).
    const headers = within(d).getAllByTestId('agent-pr-dock-card-toggle')
    expect(headers).toHaveLength(2)
    expect(headers[0].textContent).toContain('Rail 1')
    expect(headers[0].textContent).toContain('#4')
    expect(headers[1].textContent).toContain('Rail 2')
    expect(headers[1].textContent).toContain('#7')
    // Both history slots are markers.
    expect(markers()).toHaveLength(2)
  })

  it('per-card collapse is independent; state survives remount via sessionStorage', async () => {
    await renderPanelWithMessages(twoPinned)
    const d = await screen.findByTestId('agent-pr-pinned-dock')
    // Collapse only the OLDER card (d1) to its header row.
    fireEvent.click(within(d).getAllByTestId('agent-pr-dock-card-toggle')[0])
    expect(within(d).getAllByTestId('agent-pr-decision-card')).toHaveLength(1)
    expect(within(d).getByText('Draft PR created')).toBeInTheDocument()
    expect(within(d).queryByText('Implementation ready for review')).toBeNull()
    expect(sessionStorage.getItem('specrails-desktop:agent-pr-dock-card-collapsed:c1')).toBe(
      JSON.stringify(['d1']),
    )
    // Expand it back.
    fireEvent.click(within(d).getAllByTestId('agent-pr-dock-card-toggle')[0])
    expect(within(d).getAllByTestId('agent-pr-decision-card')).toHaveLength(2)
    expect(sessionStorage.getItem('specrails-desktop:agent-pr-dock-card-collapsed:c1')).toBeNull()
  })

  it('when one card unpins, the remaining pinned card keeps its own slot', async () => {
    await renderPanelWithMessages(twoPinned)
    await screen.findByTestId('agent-pr-pinned-dock')
    // d2 publishes → unpins; d1 keeps its full card in the dock.
    await act(async () => {
      wsHandler!(wsEnvelope({ prDeliveryId: 'd2', railIndex: 1, decision: 'pr_ready', ticketIds: [7], prUrl: 'https://github.com/o/r/pull/9', prState: 'pr-created' }))
    })
    const d = await screen.findByTestId('agent-pr-pinned-dock')
    await waitFor(() => expect(within(d).getAllByTestId('agent-pr-decision-card')).toHaveLength(1))
    expect(within(d).getByText('Implementation ready for review')).toBeInTheDocument()
    // History: one marker (d1 still pinned) + the unpinned d2 full card.
    expect(markers()).toHaveLength(1)
    expect(screen.getByText('PR ready for merge')).toBeInTheDocument()
  })
})

// ── Collapse-to-chip control ──────────────────────────────────────────────────
describe('collapse control', () => {
  it('collapses to a slim bar and expands back; state survives remount via sessionStorage', async () => {
    await renderPanelWithMessages([sysRow('s1', { decision: 'on_review' })])
    const d = await screen.findByTestId('agent-pr-pinned-dock')
    fireEvent.click(within(d).getByTestId('agent-pr-dock-collapse'))
    // Slim bar: no full card in the dock, marker still in history.
    expect(within(d).queryByTestId('agent-pr-decision-card')).toBeNull()
    const bar = within(d).getByTestId('agent-pr-dock-expand')
    expect(bar.textContent).toContain('Implementation card')
    expect(markers()).toHaveLength(1)
    expect(sessionStorage.getItem('specrails-desktop:agent-pr-dock-collapsed:c1')).toBe('1')

    // Expand back.
    fireEvent.click(bar)
    expect(within(d).getByTestId('agent-pr-decision-card')).toBeInTheDocument()
    expect(sessionStorage.getItem('specrails-desktop:agent-pr-dock-collapsed:c1')).toBeNull()
  })

  it('the collapsed bar shows the pinned count when multiple cards are active', async () => {
    sessionStorage.setItem('specrails-desktop:agent-pr-dock-collapsed:c1', '1')
    await renderPanelWithMessages([
      sysRow('s1', { prDeliveryId: 'd1', decision: 'on_review' }),
      sysRow('s2', { prDeliveryId: 'd2', railIndex: 1, decision: 'pr_failed' }),
    ])
    const d = await screen.findByTestId('agent-pr-pinned-dock')
    expect(within(d).getByTestId('agent-pr-dock-expand').textContent).toContain('2 implementation cards')
  })
})

// ── Both surfaces mount the pinned slot ───────────────────────────────────────
describe('surfaces', () => {
  it('the Agent-Mode INLINE conversation view renders the same pinned dock', async () => {
    vi.mocked(agentApi.getAgentConversation).mockResolvedValue({
      conversation: conv,
      messages: [sysRow('s1', { decision: 'on_review' })],
    })
    render(<AgentChatProvider><InlineHarness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('select')) })
    const d = await screen.findByTestId('agent-pr-pinned-dock')
    expect(within(d).getByTestId('agent-pr-decision-card')).toBeInTheDocument()
    expect(markers()).toHaveLength(1)
  })
})
