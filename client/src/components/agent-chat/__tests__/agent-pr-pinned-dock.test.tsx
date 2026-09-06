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
  // The composer now reports an invalid Git response explicitly. Supply its
  // read-only contract so a Git retry button cannot masquerade as a PR action.
  vi.mocked(fetch).mockImplementation(async (url) => ({
    ok: true, status: 200,
    json: async () => String(url).endsWith('/git') ? { git: false, repositoryId: 'primary-p1' } : {},
  }) as Response)
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
    ['no_changes', true],
    ['pr_closed', true],
    ['implementation_failed', true],
    ['pr_failed', true],
    ['pr_ready', false],
    ['completed', false],
    ['superseded', false],
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
      sysRow('s2', { prDeliveryId: 'd2', railIndex: 1, decision: 'on_review' }),
    ])
    expect(derived.byMessageId.size).toBe(2)
    expect(derived.pinned.map((p) => p.messageId)).toEqual(['s1', 's2'])
  })

  it('keeps only the newest authoritative envelope for duplicate legacy rows', () => {
    const derived = derivePrCards([
      sysRow('old-blocked', {
        prDeliveryId: 'd1', decision: 'pr_failed',
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      }),
      sysRow('new-ready', {
        prDeliveryId: 'd1', decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/7',
        prState: 'pr-created', branch: 'feat/review', deliveryOutcome: 'delivered',
      }),
    ])

    expect(derived.byMessageId.size).toBe(1)
    expect(derived.byMessageId.get('new-ready')?.decision).toBe('pr_ready')
    expect(derived.duplicateMessageIds).toEqual(new Set(['old-blocked']))
    expect(derived.pinned).toHaveLength(0)
  })

  it('projects a superseded predecessor as terminal regardless of message order', () => {
    const derived = derivePrCards([
      // Deliberately strange order: the newest generation was persisted first.
      sysRow('generation-c', {
        prDeliveryId: 'generation-c', decision: 'on_review', supersedesDeliveryId: 'generation-b',
      }),
      sysRow('generation-a-stale', {
        prDeliveryId: 'generation-a', decision: 'pr_failed',
        implementationOutcome: 'succeeded', deliveryOutcome: 'retryable_failure', statusCode: 'push_failed',
      }),
      sysRow('generation-b-stale', {
        prDeliveryId: 'generation-b', decision: 'pr_failed', supersedesDeliveryId: 'generation-a',
      }),
    ])

    expect(derived.byMessageId.get('generation-a-stale')?.decision).toBe('superseded')
    expect(derived.byMessageId.get('generation-b-stale')?.decision).toBe('superseded')
    expect(derived.byMessageId.get('generation-c')?.decision).toBe('on_review')
    expect(derived.pinned.map((card) => card.envelope.prDeliveryId)).toEqual(['generation-c'])
  })

  it('uses createdAt to expose only the newest generation on one rail without explicit lineage', () => {
    const derived = derivePrCards([
      sysRow('generation-a', {
        prDeliveryId: 'generation-a', railIndex: 0, decision: 'pr_failed',
        createdAt: '2026-07-10 12:00:01', updatedAt: '2026-07-10 12:00:01',
      }),
      sysRow('generation-b', {
        prDeliveryId: 'generation-b', railIndex: 0, decision: 'on_review',
        createdAt: '2026-07-10 12:00:02', updatedAt: '2026-07-10 12:00:02',
      }),
    ])

    expect(derived.byMessageId.get('generation-a')?.decision).toBe('superseded')
    expect(derived.byMessageId.get('generation-b')?.decision).toBe('on_review')
    expect(derived.pinned.map((card) => card.envelope.prDeliveryId)).toEqual(['generation-b'])
  })

  it('keeps the first accepted generation on a createdAt tie without exposing two action sets', () => {
    const tied = '2026-07-10 12:00:02'
    const derived = derivePrCards([
      sysRow('generation-a', {
        prDeliveryId: 'generation-a', railIndex: 0, decision: 'on_review', createdAt: tied,
      }),
      sysRow('generation-b', {
        prDeliveryId: 'generation-b', railIndex: 0, decision: 'pr_failed', createdAt: tied,
      }),
    ])

    expect(derived.byMessageId.get('generation-a')?.decision).toBe('on_review')
    expect(derived.byMessageId.get('generation-b')?.decision).toBe('superseded')
    expect(derived.pinned.map((card) => card.envelope.prDeliveryId)).toEqual(['generation-a'])
  })

  it('pins an immediate historical relaunch over its discarded predecessor on a createdAt tie', () => {
    const tied = '2026-07-10 12:00:02'
    const derived = derivePrCards([
      sysRow('dismissed-history', {
        prDeliveryId: 'generation-b', railIndex: 0, decision: 'discarded', createdAt: tied,
      }),
      sysRow('historical-relaunch', {
        prDeliveryId: 'generation-c', railIndex: 0, decision: 'building',
        supersedesDeliveryId: 'generation-b', createdAt: tied,
      }),
    ])

    expect(derived.byMessageId.get('dismissed-history')?.decision).toBe('superseded')
    expect(derived.byMessageId.get('historical-relaunch')?.decision).toBe('building')
    expect(derived.pinned.map((card) => card.envelope.prDeliveryId)).toEqual(['generation-c'])
  })

  it('renders restored A as the sole actionable card when explicit rollback names failed B', () => {
    const derived = derivePrCards([
      sysRow('generation-a', {
        prDeliveryId: 'generation-a', railIndex: 0, decision: 'on_review',
        restoredFromDeliveryId: 'generation-b',
        createdAt: '2026-07-10T12:00:01.000Z', updatedAt: '2026-07-10T12:00:04.000Z',
      }),
      sysRow('generation-b', {
        prDeliveryId: 'generation-b', railIndex: 0, decision: 'building',
        supersedesDeliveryId: 'generation-a',
        createdAt: '2026-07-10T12:00:02.000Z', updatedAt: '2026-07-10T12:00:02.000Z',
      }),
    ])

    expect(derived.byMessageId.get('generation-a')?.decision).toBe('on_review')
    expect(derived.byMessageId.get('generation-b')?.decision).toBe('discarded')
    expect(derived.pinned.map((card) => card.envelope.prDeliveryId)).toEqual(['generation-a'])
  })

  it('rejects stale restore-from-B rendering after newer C supersedes A', () => {
    const derived = derivePrCards([
      sysRow('generation-a', {
        prDeliveryId: 'generation-a', railIndex: 0, decision: 'on_review',
        restoredFromDeliveryId: 'generation-b',
        createdAt: '2026-07-10T12:00:01.000Z', updatedAt: '2026-07-10T12:00:04.000Z',
      }),
      sysRow('generation-b', {
        prDeliveryId: 'generation-b', railIndex: 0, decision: 'discarded',
        supersedesDeliveryId: 'generation-a',
        createdAt: '2026-07-10T12:00:02.000Z', updatedAt: '2026-07-10T12:00:03.000Z',
      }),
      sysRow('generation-c', {
        prDeliveryId: 'generation-c', railIndex: 0, decision: 'building',
        supersedesDeliveryId: 'generation-a',
        createdAt: '2026-07-10T12:00:06.000Z', updatedAt: '2026-07-10T12:00:06.000Z',
      }),
    ])

    expect(derived.byMessageId.get('generation-a')?.decision).toBe('superseded')
    expect(derived.pinned.map((card) => card.envelope.prDeliveryId)).toEqual(['generation-c'])
  })
})

// ── Pinned slot in the floating panel ─────────────────────────────────────────
describe('pinned dock (floating panel)', () => {
  it.each(['building', 'on_review', 'pr_draft', 'no_changes', 'pr_closed', 'implementation_failed', 'pr_failed'] as const)(
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

  it.each(['pr_ready', 'completed', 'superseded', 'merged', 'discarded'] as const)(
    'a %s card is UNPINNED: full card in history, no dock, no marker',
    async (decision) => {
      await renderPanelWithMessages([
        sysRow('s1', { decision, prUrl: decision === 'discarded' || decision === 'completed' || decision === 'superseded' ? null : 'https://github.com/o/r/pull/7', prState: decision === 'discarded' || decision === 'completed' || decision === 'superseded' ? 'none' : 'pr-created' }),
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

  it('renders one coherent action set when legacy blocked and current PR-ready rows coexist', async () => {
    await renderPanelWithMessages([
      sysRow('old-blocked', {
        prDeliveryId: 'd1', decision: 'pr_failed', prUrl: 'https://github.com/o/r/pull/7',
        prState: 'pr-created', branch: 'feat/review', implementationOutcome: 'succeeded',
        deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      }),
      sysRow('new-ready', {
        prDeliveryId: 'd1', decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/7',
        prState: 'pr-created', branch: 'feat/review', implementationOutcome: 'succeeded',
        deliveryOutcome: 'delivered', deliverySha: 'a'.repeat(40),
      }),
    ])

    await waitFor(() => expect(fullCards()).toHaveLength(1))
    expect(dock()).toBeNull()
    expect(markers()).toHaveLength(0)
    expect(screen.getAllByRole('button', { name: 'Checkout' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Verify PR' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Discard' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Discard local result' })).toBeNull()
  })

  it('renders actions only for B when B supersedes a stale actionable A card', async () => {
    await renderPanelWithMessages([
      sysRow('generation-a', {
        prDeliveryId: 'generation-a', decision: 'pr_failed', prUrl: 'https://github.com/o/r/pull/7',
        prState: 'pr-created', branch: 'feat/a', implementationOutcome: 'succeeded',
        deliveryOutcome: 'retryable_failure', statusCode: 'push_failed',
      }),
      sysRow('generation-b', {
        prDeliveryId: 'generation-b', decision: 'on_review', supersedesDeliveryId: 'generation-a',
        implementationOutcome: 'succeeded', deliveryOutcome: 'ready',
      }),
    ])

    const d = await screen.findByTestId('agent-pr-pinned-dock')
    expect(within(d).getAllByRole('button', { name: 'Create PR' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Retry push' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Discard' })).toHaveLength(1)
    expect(screen.getByText('A newer implementation run replaced this card.')).toBeInTheDocument()
  })

  it('renders one action set for the newest createdAt generation even without a lineage edge', async () => {
    await renderPanelWithMessages([
      sysRow('generation-a', {
        prDeliveryId: 'generation-a', railIndex: 0, decision: 'pr_failed',
        createdAt: '2026-07-10 12:00:01', updatedAt: '2026-07-10 12:00:01',
      }),
      sysRow('generation-b', {
        prDeliveryId: 'generation-b', railIndex: 0, decision: 'on_review',
        createdAt: '2026-07-10 12:00:02', updatedAt: '2026-07-10 12:00:02',
      }),
    ])

    const d = await screen.findByTestId('agent-pr-pinned-dock')
    expect(within(d).getAllByRole('button', { name: 'Create PR' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.getByText('A newer implementation run replaced this card.')).toBeInTheDocument()
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

// ── Thinking halo on the OUTER composer card (Settings ▸ Effects) ────────────
describe('thinking halo on the composer dock', () => {
  it('orbits the whole dock card while a turn streams and fades once it settles; off ⇒ absent', async () => {
    const { resetEffectsPrefsCache, setEffectsPrefs } = await import('../../../lib/effects-prefs')
    localStorage.clear(); resetEffectsPrefsCache()
    render(<AgentChatProvider><InlineHarness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('select')) })
    const dockCard = await screen.findByTestId('agent-composer-dock')
    expect(within(dockCard).getByTestId('agent-thinking-halo')).toHaveAttribute('data-active', 'false')
    // The halo lives on the OUTER card, not inside the composer's textarea box.
    expect(dockCard.querySelector('[data-testid="agent-thinking-halo"]')?.parentElement).toBe(dockCard)
    await act(async () => { wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'Thinking' }) })
    expect(within(dockCard).getByTestId('agent-thinking-halo')).toHaveAttribute('data-active', 'true')
    expect(within(dockCard).getByTestId('builder-halo')).toBeInTheDocument()
    await act(async () => { wsHandler!({ type: 'agent_done', conversationId: 'c1', fullText: 'Thinking done' }) })
    expect(within(dockCard).getByTestId('agent-thinking-halo')).toHaveAttribute('data-active', 'false')
    await act(async () => { setEffectsPrefs({ agentThinkingHalo: false }) })
    expect(within(dockCard).queryByTestId('agent-thinking-halo')).toBeNull()
  })
})
