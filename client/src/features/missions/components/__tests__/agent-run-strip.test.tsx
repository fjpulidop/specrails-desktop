import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'

// ── Mocks (mirror the agent-pr-decision harness) ──────────────────────────────
let wsHandler: ((msg: unknown) => void) | null = null
vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (m: unknown) => void) => { wsHandler = fn },
    unregisterHandler: () => { wsHandler = null },
    connectionStatus: 'connected',
  }),
}))

const projects = [
  { id: 'p1', name: 'acme-api', slug: 'acme-api', path: '/acme', provider: 'claude' },
]
vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects, activeProjectId: 'p1', setActiveProjectId: vi.fn() }),
}))

vi.mock('../../../browser/context/WebViewModalContext', () => ({
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
vi.mock('../../lib/agent-api', async (orig) => {
  const actual = await orig<typeof import('../../lib/agent-api')>()
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
      models: [{ value: 'sonnet', label: 'Sonnet 5.5', default: true }],
      supportsImageInput: true,
      efforts: ['low', 'medium', 'high'],
    })),
  }
})

import * as agentApi from '../../lib/agent-api'
import type {
  AgentPrDecisionEnvelope,
  AgentPrDecisionValue,
  AgentMessage as ApiAgentMessage,
} from '../../lib/agent-api'
import { AgentChatProvider, useAgentChat } from '../../context/AgentChatContext'
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

const strip = () => screen.queryByTestId('mission-run-strip')
const launchedLines = () => screen.queryAllByTestId('agent-run-launched-line')
const fullCards = () => screen.queryAllByTestId('agent-pr-decision-card')
/** Cards shown in the history (not inside the strip's panel). */
const historyCards = () => fullCards().filter((card) => !card.closest('[data-testid="mission-run-strip"]'))
const panel = () => screen.getByTestId('mission-run-strip-panel')
async function openPanel() {
  await act(async () => { fireEvent.click(screen.getByTestId('mission-run-strip-toggle')) })
  await waitFor(() => expect(panel()).toHaveAttribute('data-open', 'true'))
}

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

// ── The run strip in the floating panel ───────────────────────────────────────
describe('run strip (floating panel)', () => {
  it.each([
    ['building', 'running', 'Working'],
    ['on_review', 'decision', 'Ready for your review'],
    ['pr_draft', 'decision', 'Draft PR ready to publish'],
    ['no_changes', 'info', 'Finished without changes'],
    ['pr_closed', 'info', 'PR closed without merging'],
    ['implementation_failed', 'failed', 'The implementation failed'],
    ['pr_failed', 'failed', 'The PR could not be created'],
  ] as const)(
    'a %s delivery is LIVE: one strip (%s · "%s") and a one-line "launched" event in its history slot',
    async (decision, tone, headline) => {
      await renderPanelWithMessages([sysRow('s1', { decision, ...(decision === 'implementation_failed' ? { implementationOutcome: 'failed' as const } : {}) })])
      const s = await screen.findByTestId('mission-run-strip')
      expect(s).toHaveAttribute('data-tone', tone)
      expect(within(s).getByTestId('mission-run-strip-headline')).toHaveTextContent(headline)
      // The full card is mounted ONCE, inside the strip's (closed) panel…
      expect(within(s).getByTestId('agent-pr-decision-card')).toBeInTheDocument()
      expect(fullCards()).toHaveLength(1)
      expect(historyCards()).toHaveLength(0)
      // …the history slot only says what happened.
      expect(launchedLines()).toHaveLength(1)
      expect(launchedLines()[0]).toHaveTextContent('Launched on Rail 1')
      expect(launchedLines()[0]).toHaveTextContent('#4 #7')
      // No "pinned" chrome survives.
      expect(screen.queryByText(/pinned above/i)).toBeNull()
      expect(screen.queryByText('Pinned')).toBeNull()
    },
  )

  it.each(['pr_ready', 'completed', 'superseded', 'merged', 'discarded'] as const)(
    'a %s delivery is SETTLED: no strip, the full card in its history slot',
    async (decision) => {
      await renderPanelWithMessages([
        sysRow('s1', { decision, prUrl: decision === 'discarded' || decision === 'completed' || decision === 'superseded' ? null : 'https://github.com/o/r/pull/7', prState: decision === 'discarded' || decision === 'completed' || decision === 'superseded' ? 'none' : 'pr-created' }),
      ])
      await waitFor(() => expect(historyCards()).toHaveLength(1))
      expect(strip()).toBeNull()
      expect(launchedLines()).toHaveLength(0)
    },
  )

  it('a conversation without runs renders no strip and no event lines', async () => {
    await renderPanelWithMessages([
      { id: 'a1', conversation_id: 'c1', role: 'assistant', content: 'hello', created_at: '' },
    ])
    expect(await screen.findByText('hello')).toBeInTheDocument()
    expect(strip()).toBeNull()
    expect(launchedLines()).toHaveLength(0)
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
    expect(strip()).toBeNull()
    // One primary button; Checkout and Discard sit behind the card's single "More actions" menu.
    expect(screen.getAllByRole('button', { name: 'Verify PR' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'More actions' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getAllByRole('menuitem', { name: /^Checkout/ })).toHaveLength(1)
    expect(screen.getAllByRole('menuitem', { name: /^Discard/ })).toHaveLength(1)
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

    const s = await screen.findByTestId('mission-run-strip')
    await openPanel()
    expect(within(s).getAllByRole('button', { name: 'Create PR' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Retry push' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'More actions' })).toHaveLength(1)
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

    const s = await screen.findByTestId('mission-run-strip')
    await openPanel()
    expect(within(s).getAllByRole('button', { name: 'Create PR' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.getByText('A newer implementation run replaced this card.')).toBeInTheDocument()
  })

  it('retires on the publish WS transition: strip away, the full card back in its chronological slot', async () => {
    await renderPanelWithMessages([sysRow('s1', { decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created' })])
    await screen.findByTestId('mission-run-strip')
    expect(launchedLines()).toHaveLength(1)

    await act(async () => {
      wsHandler!(wsEnvelope({ decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created' }))
    })
    await waitFor(() => expect(strip()).toBeNull())
    expect(launchedLines()).toHaveLength(0)
    expect(historyCards()).toHaveLength(1)
    expect(screen.getByText('PR ready for merge')).toBeInTheDocument()
    // The retirement is announced politely.
    expect(screen.getByTestId('mission-run-strip-announcer')).toHaveTextContent('Rail 1 finished')
  })

  it('a live building arrival shows in the strip at once (WS append, no reload); launched = skeleton', async () => {
    await renderPanelWithMessages([])
    await act(async () => { wsHandler!(wsEnvelope({ decision: 'building', phase: 'launched' })) })
    const s = await screen.findByTestId('mission-run-strip')
    expect(s).toHaveAttribute('data-tone', 'launching')
    expect(within(s).getByTestId('mission-run-strip-headline')).toHaveTextContent('Launching on Rail 1…')
    expect(within(s).getByTestId('mission-run-strip-skeleton')).toBeInTheDocument()
    expect(within(s).queryByTestId('mission-run-strip-primary')).toBeNull()
    expect(launchedLines()).toHaveLength(1)
  })

  it('a running run shows "—" for time and cost until measured, and no primary action', async () => {
    await renderPanelWithMessages([sysRow('s1', { decision: 'building', phase: 'running' })])
    const s = await screen.findByTestId('mission-run-strip')
    expect(within(s).getByTestId('mission-run-strip-elapsed')).toHaveTextContent('—')
    expect(within(s).getByTestId('mission-run-strip-cost')).toHaveTextContent('—')
    expect(within(s).queryByTestId('mission-run-strip-primary')).toBeNull()
  })
})

// ── Panel: open, Esc, primary action ──────────────────────────────────────────
describe('strip panel', () => {
  it('opens above the strip, moves focus into it, and Esc closes it back to the strip', async () => {
    await renderPanelWithMessages([sysRow('s1', { decision: 'on_review' })])
    await screen.findByTestId('mission-run-strip')
    const toggle = screen.getByTestId('mission-run-strip-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(panel()).queryByRole('button', { name: 'Create PR' })).toBeNull() // hidden while closed
    expect(screen.getByTestId('mission-run-strip-primary')).toHaveTextContent('Create PR')
    await openPanel()
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAttribute('aria-controls', panel().id)
    expect(within(panel()).getByRole('button', { name: 'Create PR' })).toBeInTheDocument()
    // The card shows the action now: the strip does not repeat it.
    expect(screen.queryByTestId('mission-run-strip-primary')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(panel()))
    fireEvent.keyDown(panel(), { key: 'Escape' })
    expect(panel()).toHaveAttribute('data-open', 'false')
    expect(document.activeElement).toBe(toggle)
  })

  it('a click in the conversation closes the panel', async () => {
    await renderPanelWithMessages([
      { id: 'a1', conversation_id: 'c1', role: 'assistant', content: 'hello there', created_at: '' },
      sysRow('s1', { decision: 'on_review' }),
    ])
    await screen.findByTestId('mission-run-strip')
    await openPanel()
    fireEvent.pointerDown(screen.getByText('hello there'))
    expect(panel()).toHaveAttribute('data-open', 'false')
  })

  it('an OUTWARD primary (Create PR) is never fired from the strip: it opens the card focused on its own control', async () => {
    await renderPanelWithMessages([sysRow('s1', { decision: 'on_review' })])
    const s = await screen.findByTestId('mission-run-strip')
    const primary = await within(s).findByTestId('mission-run-strip-primary')
    expect(primary).toHaveTextContent('Create PR')
    expect(primary).toHaveAttribute('data-kind', 'outward')
    // One disclosure cue: the outward primary carries the chevron, the toggle doesn't.
    expect(within(s).queryByTestId('mission-run-strip-toggle-chevron')).not.toBeInTheDocument()
    expect(primary).toHaveAccessibleDescription('Opens the run\u2019s card so you can confirm there'.replace('\u2019', "'"))
    const create = within(s).getByTestId('agent-pr-decision-card').querySelector<HTMLButtonElement>('[data-run-primary-id="create-pr"]')!
    expect(create).toHaveAttribute('data-run-primary-kind', 'outward')
    const clicked = vi.fn()
    create.addEventListener('click', clicked)
    await act(async () => { fireEvent.click(primary) })
    expect(panel()).toHaveAttribute('data-open', 'true')
    await waitFor(() => expect(document.activeElement).toBe(create))
    // The person confirms on the card: nothing was performed for them.
    expect(clicked).not.toHaveBeenCalled()
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/pr-decision'))).toBe(false)
  })

  it('Relaunch spends money on a new run: OUTWARD, the strip opens the card focused on it and never relaunches itself', async () => {
    await renderPanelWithMessages([sysRow('s1', { decision: 'implementation_failed', implementationOutcome: 'failed', runIds: ['r1'] })])
    const s = await screen.findByTestId('mission-run-strip')
    expect(s).toHaveAttribute('data-tone', 'failed')
    expect(within(s).getByTestId('mission-run-strip-toggle')).toHaveTextContent('Failed:')
    expect(within(s).getByTestId('mission-run-strip-headline').className).toContain('text-destructive')
    const primary = await within(s).findByTestId('mission-run-strip-primary')
    expect(primary).toHaveTextContent('Relaunch')
    expect(primary).toHaveAttribute('data-kind', 'outward')
    const relaunch = within(s).getByTestId('agent-pr-decision-card').querySelector<HTMLButtonElement>('[data-run-primary-id="relaunch"]')!
    await act(async () => { fireEvent.click(primary) })
    expect(panel()).toHaveAttribute('data-open', 'true')
    await waitFor(() => expect(document.activeElement).toBe(relaunch))
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/rails/0/relaunch'))).toBe(false)
  })
})

describe('the strip primary for a blocked delivery', () => {
  it('Retry delivery is OUTWARD: the strip shows it and opens the card focused on it, never retrying itself', async () => {
    await renderPanelWithMessages([sysRow('s1', { decision: 'pr_failed', statusCode: 'commit_failed', runIds: ['r1'] })])
    const s = await screen.findByTestId('mission-run-strip')
    const primary = await within(s).findByTestId('mission-run-strip-primary')
    expect(primary).toHaveTextContent('Retry delivery')
    expect(primary).toHaveAttribute('data-kind', 'outward')
    const retry = within(s).getByTestId('agent-pr-retry-delivery')
    expect(retry).toHaveAttribute('data-run-primary-id', 'retry-delivery')
    const clicked = vi.fn()
    retry.addEventListener('click', clicked)
    await act(async () => { fireEvent.click(primary) })
    expect(panel()).toHaveAttribute('data-open', 'true')
    await waitFor(() => expect(document.activeElement).toBe(retry))
    expect(clicked).not.toHaveBeenCalled()
  })
})

// ── Several live runs: ONE strip + switcher ───────────────────────────────────
describe('several live runs', () => {
  const two = [
    sysRow('s1', { prDeliveryId: 'd1', railIndex: 0, decision: 'building', phase: 'running', ticketIds: [4] }),
    sysRow('s2', { prDeliveryId: 'd2', railIndex: 1, decision: 'on_review', ticketIds: [7] }),
  ]

  it('shows the most urgent run (waiting for you over running) with a switcher, never stacked cards', async () => {
    await renderPanelWithMessages(two)
    const s = await screen.findByTestId('mission-run-strip')
    expect(screen.getAllByTestId('mission-run-strip')).toHaveLength(1)
    expect(s).toHaveAttribute('data-run-key', 'delivery:d2')
    const switches = within(s).getAllByTestId('mission-run-strip-switch')
    expect(switches.map((b) => b.textContent)).toEqual(['Rail 2', 'Rail 1'])
    expect(switches[0]).toHaveAttribute('aria-pressed', 'true')
    // Both cards stay mounted (they measure their runs); both history slots are event lines.
    expect(within(s).getAllByTestId('agent-pr-decision-card')).toHaveLength(2)
    expect(launchedLines()).toHaveLength(2)
  })

  it('the person’s pick holds (session-only): a run that newly needs them is marked and announced, never swapped in', async () => {
    await renderPanelWithMessages(two)
    const s = await screen.findByTestId('mission-run-strip')
    fireEvent.click(within(s).getAllByTestId('mission-run-strip-switch')[1])
    expect(s).toHaveAttribute('data-run-key', 'delivery:d1')
    expect(sessionStorage.getItem('specrails-desktop:run-strip-pick:c1')).toBe('delivery:d1')
    await act(async () => {
      wsHandler!(wsEnvelope({ prDeliveryId: 'd3', railIndex: 2, decision: 'on_review', ticketIds: [9] }))
    })
    const marked = await waitFor(() => {
      const button = within(screen.getByTestId('mission-run-strip')).getAllByTestId('mission-run-strip-switch').find((b) => b.getAttribute('data-run-key') === 'delivery:d3')
      expect(button).toBeDefined()
      return button!
    })
    expect(screen.getByTestId('mission-run-strip')).toHaveAttribute('data-run-key', 'delivery:d1')
    expect(within(marked).getByTestId('mission-run-strip-needs-you')).toHaveTextContent('needs you')
    await waitFor(() => expect(screen.getByTestId('mission-run-strip-announcer')).toHaveTextContent('Rail 3 needs you'))
    // Showing it clears the mark.
    fireEvent.click(marked)
    expect(screen.getByTestId('mission-run-strip')).toHaveAttribute('data-run-key', 'delivery:d3')
    expect(screen.queryByTestId('mission-run-strip-needs-you')).toBeNull()
  })

  it('an open panel is never swapped: the new urgent run waits in the switcher', async () => {
    await renderPanelWithMessages([sysRow('s1', { prDeliveryId: 'd1', railIndex: 0, decision: 'building', phase: 'running', ticketIds: [4] })])
    await screen.findByTestId('mission-run-strip')
    await openPanel()
    await act(async () => {
      wsHandler!(wsEnvelope({ prDeliveryId: 'd2', railIndex: 1, decision: 'on_review', ticketIds: [7] }))
    })
    await waitFor(() => expect(screen.getByTestId('mission-run-strip-needs-you')).toBeInTheDocument())
    expect(screen.getByTestId('mission-run-strip')).toHaveAttribute('data-run-key', 'delivery:d1')
    expect(panel()).toHaveAttribute('data-open', 'true')
  })

  it('an idle strip (nothing picked, closed, focus elsewhere) follows the most urgent run on its own', async () => {
    await renderPanelWithMessages([sysRow('s1', { prDeliveryId: 'd1', railIndex: 0, decision: 'building', phase: 'running', ticketIds: [4] })])
    await screen.findByTestId('mission-run-strip')
    await act(async () => {
      wsHandler!(wsEnvelope({ prDeliveryId: 'd2', railIndex: 1, decision: 'on_review', ticketIds: [7] }))
    })
    await waitFor(() => expect(screen.getByTestId('mission-run-strip')).toHaveAttribute('data-run-key', 'delivery:d2'))
    expect(screen.queryByTestId('mission-run-strip-needs-you')).toBeNull()
  })

  it('more than three runs: the shown one, the two most urgent and "+N"', async () => {
    await renderPanelWithMessages([
      sysRow('s1', { prDeliveryId: 'd1', railIndex: 0, decision: 'building', phase: 'running' }),
      sysRow('s2', { prDeliveryId: 'd2', railIndex: 1, decision: 'building', phase: 'running' }),
      sysRow('s3', { prDeliveryId: 'd3', railIndex: 2, decision: 'pr_failed' }),
      sysRow('s4', { prDeliveryId: 'd4', railIndex: 3, decision: 'on_review' }),
    ])
    const s = await screen.findByTestId('mission-run-strip')
    expect(s).toHaveAttribute('data-run-key', 'delivery:d4')
    expect(within(s).getAllByTestId('mission-run-strip-switch').map((b) => b.textContent)).toEqual(['Rail 4', 'Rail 3', 'Rail 1'])
    const more = within(s).getByTestId('mission-run-strip-more')
    expect(more).toHaveTextContent('+1')
    fireEvent.click(more)
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem'))
    expect(s).toHaveAttribute('data-run-key', 'delivery:d2')
  })

  it('the "+N" menu works from the keyboard: arrows, Home/End, roving focus, Esc back to its button', async () => {
    await renderPanelWithMessages([
      sysRow('s1', { prDeliveryId: 'd1', railIndex: 0, decision: 'building', phase: 'running' }),
      sysRow('s2', { prDeliveryId: 'd2', railIndex: 1, decision: 'building', phase: 'running' }),
      sysRow('s3', { prDeliveryId: 'd3', railIndex: 2, decision: 'building', phase: 'running' }),
      sysRow('s4', { prDeliveryId: 'd4', railIndex: 3, decision: 'pr_failed' }),
      sysRow('s5', { prDeliveryId: 'd5', railIndex: 4, decision: 'on_review' }),
    ])
    const s = await screen.findByTestId('mission-run-strip')
    const more = within(s).getByTestId('mission-run-strip-more')
    expect(more).toHaveTextContent('+2')
    more.focus()
    fireEvent.keyDown(more, { key: 'ArrowDown' })
    const menu = screen.getByRole('menu')
    const items = within(menu).getAllByRole('menuitem')
    await waitFor(() => expect(document.activeElement).toBe(items[0]))
    expect(items[0]).toHaveAttribute('tabindex', '0')
    expect(items[1]).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(items[1]))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(items[0]))
    fireEvent.keyDown(menu, { key: 'End' })
    await waitFor(() => expect(document.activeElement).toBe(items[1]))
    fireEvent.keyDown(menu, { key: 'Home' })
    await waitFor(() => expect(document.activeElement).toBe(items[0]))
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(more)
  })

  it('a run leaving the strip keeps the others; the settled card returns to history', async () => {
    await renderPanelWithMessages(two)
    await screen.findByTestId('mission-run-strip')
    await act(async () => {
      wsHandler!(wsEnvelope({ prDeliveryId: 'd2', railIndex: 1, decision: 'pr_ready', ticketIds: [7], prUrl: 'https://github.com/o/r/pull/9', prState: 'pr-created' }))
    })
    await waitFor(() => expect(screen.getByTestId('mission-run-strip')).toHaveAttribute('data-run-key', 'delivery:d1'))
    expect(screen.queryByTestId('mission-run-strip-switcher')?.textContent).toBe('Rail 1')
    expect(launchedLines()).toHaveLength(1)
    expect(screen.getByText('PR ready for merge')).toBeInTheDocument()
  })
})

// ── History lines open the run ────────────────────────────────────────────────
describe('history lines focus the run', () => {
  const failureRow = (over: Record<string, unknown> = {}): ApiAgentMessage => ({
    id: 'f1', conversation_id: 'c1', role: 'system', created_at: '',
    content: JSON.stringify({ kind: 'run-failure', runId: 'r1', railIndex: 0, projectId: 'p1', code: 'implementation_failed', detail: 'boom', stepId: null, at: null, prDeliveryId: 'd1', ...over }),
  })
  const failedCard = () => sysRow('s1', { prDeliveryId: 'd1', decision: 'implementation_failed', implementationOutcome: 'failed', runIds: ['r1'], ticketIds: [8] })
  const scrollSpy = () => vi.mocked(HTMLElement.prototype.scrollIntoView)

  it('the failure line opens the run’s panel, scrolls its card into view and focuses it (once)', async () => {
    await renderPanelWithMessages([failedCard(), failureRow()])
    const s = await screen.findByTestId('mission-run-strip')
    expect(screen.getByTestId('agent-run-failure-marker')).toHaveTextContent('Rail 1 failed: The implementation failed')
    scrollSpy().mockClear()
    await act(async () => { fireEvent.click(screen.getByTestId('agent-run-failure-marker')) })
    const card = within(s).getByTestId('agent-pr-decision-card')
    await waitFor(() => expect(document.activeElement).toBe(card))
    expect(panel()).toHaveAttribute('data-open', 'true')
    expect(card).toHaveAttribute('role', 'region')
    expect(card.getAttribute('aria-label')).toContain('Rail 1')
    expect(card.getAttribute('aria-label')).toContain('#8')
    expect(card.className).toContain('ring-2')
    expect(scrollSpy()).toHaveBeenCalledTimes(1)
  })

  it('the "launched" line opens the same run', async () => {
    await renderPanelWithMessages([failedCard()])
    const s = await screen.findByTestId('mission-run-strip')
    await act(async () => { fireEvent.click(launchedLines()[0]!) })
    await waitFor(() => expect(document.activeElement).toBe(within(s).getByTestId('agent-pr-decision-card')))
  })

  it('a run that is not there is a graceful no-op', async () => {
    await renderPanelWithMessages([failedCard(), failureRow({ runId: 'other', prDeliveryId: 'gone' })])
    await screen.findByTestId('mission-run-strip')
    scrollSpy().mockClear()
    await act(async () => { fireEvent.click(screen.getByTestId('agent-run-failure-marker')) })
    expect(panel()).toHaveAttribute('data-open', 'false')
    expect(scrollSpy()).not.toHaveBeenCalled()
  })

  it('a request scoped to another conversation (split panes) is ignored', async () => {
    await renderPanelWithMessages([failedCard()])
    await screen.findByTestId('mission-run-strip')
    const { focusPrCard } = await import('../agent-run-failure')
    await act(async () => { focusPrCard({ prDeliveryId: 'd1', runIds: ['r1'], conversationId: 'c2' }) })
    expect(panel()).toHaveAttribute('data-open', 'false')
  })

  it('a settled Flow → Spec run is one outcome line that expands its card in place', async () => {
    await renderPanelWithMessages([sysRow('s1', { decision: 'pr_ready', loopId: 'factory:flow-spec', loopName: 'Flow → Spec', prNumber: 812, prUrl: 'https://github.com/o/r/pull/812', prState: 'pr-created' })])
    const line = await screen.findByTestId('agent-settled-run-line')
    expect(line).toHaveTextContent('Delivered: PR #812')
    expect(fullCards()).toHaveLength(0)
    fireEvent.click(line)
    expect(historyCards()).toHaveLength(1)
  })
})

// ── Both surfaces mount the strip ─────────────────────────────────────────────
describe('surfaces', () => {
  it('the Agent-Mode INLINE conversation view renders the same strip', async () => {
    vi.mocked(agentApi.getAgentConversation).mockResolvedValue({
      conversation: conv,
      messages: [sysRow('s1', { decision: 'on_review' })],
    })
    render(<AgentChatProvider><InlineHarness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('select')) })
    const s = await screen.findByTestId('mission-run-strip')
    expect(within(s).getByTestId('agent-pr-decision-card')).toBeInTheDocument()
    expect(launchedLines()).toHaveLength(1)
  })
})

// ── Thinking halo on the flat composer surface (Settings ▸ Effects) ────────────
describe('thinking halo on the composer dock', () => {
  it('orbits the flat input surface while a turn streams and fades once it settles; off ⇒ absent', async () => {
    const { resetEffectsPrefsCache, setEffectsPrefs } = await import('../../../settings/lib/effects-prefs')
    localStorage.clear(); resetEffectsPrefsCache()
    render(<AgentChatProvider><InlineHarness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('select')) })
    const dockCard = await screen.findByTestId('agent-composer-dock')
    expect(within(dockCard).getByTestId('agent-thinking-halo')).toHaveAttribute('data-active', 'false')
    // The ring follows the single visible input surface and its new radius.
    const inputBox = within(dockCard).getByTestId('agent-composer-box')
    expect(inputBox).toHaveClass('rounded-panel')
    expect(dockCard.querySelector('[data-testid="agent-thinking-halo"]')?.parentElement).toBe(inputBox)
    await act(async () => { wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'Thinking' }) })
    expect(within(dockCard).getByTestId('agent-thinking-halo')).toHaveAttribute('data-active', 'true')
    expect(within(dockCard).getByTestId('builder-halo')).toHaveStyle({ inset: '-1px' })
    expect(within(dockCard).getByTestId('builder-halo').firstElementChild).toHaveAttribute('style', expect.stringContaining('var(--radius-panel)'))
    await act(async () => { wsHandler!({ type: 'agent_done', conversationId: 'c1', fullText: 'Thinking done' }) })
    expect(within(dockCard).getByTestId('agent-thinking-halo')).toHaveAttribute('data-active', 'false')
    await act(async () => { setEffectsPrefs({ agentThinkingHalo: false }) })
    expect(within(dockCard).queryByTestId('agent-thinking-halo')).toBeNull()
  })
})

// ── Keyboard: conversation-scoped shortcuts (run-strip-keys.ts) ────────────────
describe('run strip keyboard', () => {
  const two = [
    sysRow('s1', { prDeliveryId: 'd1', railIndex: 0, decision: 'building', phase: 'running', ticketIds: [4] }),
    sysRow('s2', { prDeliveryId: 'd2', railIndex: 1, decision: 'on_review', ticketIds: [7] }),
  ]
  const altR = (target: Element) => fireEvent.keyDown(target, { key: '®', code: 'KeyR', altKey: true })
  const altBracket = (target: Element, side: 'left' | 'right') =>
    fireEvent.keyDown(target, { key: side === 'left' ? '“' : '‘', code: side === 'left' ? 'BracketLeft' : 'BracketRight', altKey: true })

  it('⌥R jumps from the composer to the strip, again toggles its details, and Esc goes back to the composer', async () => {
    await renderPanelWithMessages(two)
    const s = await screen.findByTestId('mission-run-strip')
    const toggle = within(s).getByTestId('mission-run-strip-toggle')
    expect(toggle).toHaveAttribute('aria-keyshortcuts', 'Alt+R')
    expect(toggle.getAttribute('title')).toMatch(/^Show details \((⌥R|Alt\+R)\)$/)
    const composer = await screen.findByRole('textbox')
    composer.focus()
    // Modifier-based: it works while typing, and the Option character is not typed.
    expect(altR(composer)).toBe(false)
    expect(document.activeElement).toBe(toggle)
    await act(async () => { altR(toggle) })
    await waitFor(() => expect(panel()).toHaveAttribute('data-open', 'true'))
    await waitFor(() => expect(document.activeElement).toBe(panel()))
    await act(async () => { altR(panel()) })
    expect(panel()).toHaveAttribute('data-open', 'false')
    expect(document.activeElement).toBe(toggle)
    fireEvent.keyDown(toggle, { key: 'Escape' })
    expect(document.activeElement).toBe(composer)
  })

  it('⌥] / ⌥[ cycle the shown run outside text fields (announced), never while typing', async () => {
    await renderPanelWithMessages(two)
    const s = await screen.findByTestId('mission-run-strip')
    expect(s).toHaveAttribute('data-run-key', 'delivery:d2')
    expect(within(s).getAllByTestId('mission-run-strip-switch')[0].getAttribute('title')).toMatch(/Switch runs: (⌥\[ ⌥\]|Alt\+\[ Alt\+\])/)
    const composer = await screen.findByRole('textbox')
    composer.focus()
    // In a text field the bracket keys type (Option+[ is "[" on several layouts).
    expect(altBracket(composer, 'right')).toBe(true)
    expect(s).toHaveAttribute('data-run-key', 'delivery:d2')
    await act(async () => { altR(composer) })
    await act(async () => { altBracket(document.activeElement!, 'right') })
    expect(screen.getByTestId('mission-run-strip')).toHaveAttribute('data-run-key', 'delivery:d1')
    expect(screen.getByTestId('mission-run-strip-announcer')).toHaveTextContent('Showing Rail 1')
    // The bar re-keys on a new run: focus stays in the strip.
    await waitFor(() => expect(screen.getByTestId('mission-run-strip').contains(document.activeElement)).toBe(true))
    await act(async () => { altBracket(document.activeElement!, 'left') })
    expect(screen.getByTestId('mission-run-strip')).toHaveAttribute('data-run-key', 'delivery:d2')
  })

  it('← / → move along the switcher; ⌘/Ctrl combinations are left to the app', async () => {
    await renderPanelWithMessages(two)
    const s = await screen.findByTestId('mission-run-strip')
    const switches = within(s).getAllByTestId('mission-run-strip-switch')
    switches[0].focus()
    fireEvent.keyDown(switches[0], { key: 'ArrowRight' })
    expect(document.activeElement).toBe(switches[1])
    fireEvent.keyDown(switches[1], { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(switches[0])
    expect(fireEvent.keyDown(document.body, { key: 'r', code: 'KeyR', altKey: true, metaKey: true })).toBe(true)
    expect(document.activeElement).toBe(switches[0])
  })

  it('a mission without runs takes no shortcut (the key types as usual)', async () => {
    await renderPanelWithMessages([])
    const composer = await screen.findByRole('textbox')
    composer.focus()
    expect(altR(composer)).toBe(true)
    expect(document.activeElement).toBe(composer)
  })
})
