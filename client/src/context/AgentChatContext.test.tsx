import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

let wsHandler: ((msg: unknown) => void) | null = null
let wsConnectionStatus: 'connected' | 'disconnected' = 'connected'

vi.mock('../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (m: unknown) => void) => { wsHandler = fn },
    unregisterHandler: () => { wsHandler = null },
    connectionStatus: wsConnectionStatus,
  }),
}))

vi.mock('../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects: [], activeProjectId: null, setActiveProjectId: vi.fn() }),
}))

vi.mock('./UiModeContext', () => ({
  useUiMode: () => ({ uiMode: 'agent', setUiMode: vi.fn(), toggleUiMode: vi.fn() }),
}))

const api = {
  conv1: {
    id: 'c1',
    title: 'Mission one',
    provider: 'claude',
    model: null,
    session_id: null,
    pinned_project_id: null,
    tier_level: 0 as const,
    created_at: '',
    updated_at: '',
  },
  conv2: {
    id: 'c2',
    title: 'Mission two',
    provider: 'claude',
    model: null,
    session_id: null,
    pinned_project_id: null,
    tier_level: 0 as const,
    created_at: '',
    updated_at: '',
  },
}

vi.mock('../lib/agent-api', async (orig) => {
  const actual = await orig<typeof import('../lib/agent-api')>()
  return {
    ...actual,
    listAgentConversations: vi.fn(async () => [api.conv1, api.conv2]),
    createAgentConversation: vi.fn(async () => api.conv1),
    getAgentConversation: vi.fn(async (id: string) => ({
      conversation: id === 'c2' ? api.conv2 : api.conv1,
      messages: [],
    })),
    patchAgentConversation: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...api.conv1, ...patch })),
    deleteAgentConversation: vi.fn(async () => {}),
    sendAgentMessage: vi.fn(async () => ({ queued: false })),
    abortAgentTurn: vi.fn(async () => {}),
    editQueuedAgentMessage: vi.fn(async () => 'saved' as const),
    getMcpStatus: vi.fn(async () => ({ enabled: true, running: true })),
    enableMcp: vi.fn(async () => {}),
    getAvailableProviders: vi.fn(async () => ({ any: true, providers: [] })),
    getAgentActiveTurns: vi.fn(async () => ({ snapshotVersion: 1, capturedAt: new Date().toISOString(), turns: [] })),
  }
})

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}))

import * as agentApi from '../lib/agent-api'
import type { AgentPrDecisionEnvelope } from '../lib/agent-api'
import { AgentChatProvider, useAgentChat } from './AgentChatContext'

const prEnvelope = (over: Partial<AgentPrDecisionEnvelope> = {}): AgentPrDecisionEnvelope => ({
  kind: 'pr_decision', prDeliveryId: 'd1', railIndex: 0, projectId: 'p1', baseBranch: 'main', ticketIds: [1],
  decision: 'on_review', prUrl: null, prNumber: null, prState: 'none', branch: null, runIds: [], ...over,
})

const prMessage = (
  conversationId: string,
  envelope: AgentPrDecisionEnvelope = prEnvelope(),
  id = `msg-${conversationId}-${envelope.prDeliveryId}`,
) => ({
  id, conversation_id: conversationId, role: 'system' as const,
  content: JSON.stringify(envelope), created_at: '',
})

function setDocumentVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value,
  })
}

function Harness() {
  const agentChat = useAgentChat()
  const [applyResult, setApplyResult] = useState('')
  return (
    <div>
      <span data-testid="active-id">{agentChat.active?.id ?? ''}</span>
      <span data-testid="unread-ids">{[...agentChat.unreadConversationIds].sort().join(',')}</span>
      <span data-testid="pr-deliveries">{agentChat.messages.flatMap((message) => {
        const envelope = message.role === 'system' ? agentApi.parsePrDecisionEnvelope(message.content) : null
        return envelope ? [`${envelope.prDeliveryId}:${envelope.decision}`] : []
      }).join(',')}</span>
      <span data-testid="apply-result">{applyResult}</span>
      <span data-testid="streaming">{String(agentChat.isStreaming)}</span>
      <span data-testid="message-text">{agentChat.messages.map((message) => message.content).join('|')}</span>
      <button onClick={agentChat.open}>open</button>
      <button onClick={() => void agentChat.send('hello')}>send</button>
      <button onClick={() => void agentChat.selectConversation('c1')}>select-c1</button>
      <button onClick={() => void agentChat.selectConversation('c2')}>select-c2</button>
      <button onClick={() => setApplyResult(agentChat.applyPrDecisionSnapshot(prEnvelope({ decision: 'pr_draft' })))}>apply-d1</button>
      <button onClick={() => setApplyResult(agentChat.applyPrDecisionSnapshot(prEnvelope({
        prDeliveryId: 'generation-a', decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/7',
        prState: 'pr-created', branch: 'feat/a',
      })))}>apply-a-late</button>
    </div>
  )
}

beforeEach(() => {
  wsHandler = null
  wsConnectionStatus = 'connected'
  vi.clearAllMocks()
  vi.mocked(agentApi.listAgentConversations).mockResolvedValue([api.conv1, api.conv2])
  vi.mocked(agentApi.getAgentConversation).mockImplementation(async (id: string) => ({
    conversation: id === 'c2' ? api.conv2 : api.conv1,
    messages: [],
  }))
  vi.mocked(agentApi.getMcpStatus).mockResolvedValue({ enabled: true, running: true })
  vi.mocked(agentApi.getAvailableProviders).mockResolvedValue({ any: true, providers: [] })
  vi.mocked(agentApi.getAgentActiveTurns).mockResolvedValue({ snapshotVersion: 1, capturedAt: new Date().toISOString(), turns: [] })
  setDocumentVisibility('visible')
})

describe('AgentChatContext reconnect reconciliation', () => {
  it('settles an optimistic turn absent from the server snapshot without retrying it', async () => {
    wsConnectionStatus = 'disconnected'
    const view = render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('active-id')).toHaveTextContent('c1'))
    await act(async () => { fireEvent.click(screen.getByText('send')) })
    expect(screen.getByTestId('streaming')).toHaveTextContent('true')

    vi.mocked(agentApi.getAgentActiveTurns).mockResolvedValue({
      snapshotVersion: 7,
      capturedAt: new Date(Date.now() + 1000).toISOString(),
      turns: [],
    })
    wsConnectionStatus = 'connected'
    view.rerender(<AgentChatProvider><Harness /></AgentChatProvider>)

    await waitFor(() => expect(screen.getByTestId('streaming')).toHaveTextContent('false'))
    expect(screen.getByTestId('message-text')).toHaveTextContent('was interrupted')
    expect(agentApi.sendAgentMessage).toHaveBeenCalledTimes(1)
  })

  it('preserves an optimistic turn that the authoritative snapshot reports active', async () => {
    wsConnectionStatus = 'disconnected'
    const view = render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('active-id')).toHaveTextContent('c1'))
    await act(async () => { fireEvent.click(screen.getByText('send')) })
    vi.mocked(agentApi.getAgentActiveTurns).mockResolvedValue({
      snapshotVersion: 8,
      capturedAt: new Date(Date.now() + 1000).toISOString(),
      turns: [{ conversationId: 'c1', startedAt: new Date().toISOString() }],
    })
    wsConnectionStatus = 'connected'
    view.rerender(<AgentChatProvider><Harness /></AgentChatProvider>)
    await waitFor(() => expect(agentApi.getAgentActiveTurns).toHaveBeenCalled())
    expect(screen.getByTestId('streaming')).toHaveTextContent('true')
    expect(screen.getByTestId('message-text')).not.toHaveTextContent('was interrupted')
  })
})

describe('AgentChatContext unread conversations', () => {
  it('exposes unreadConversationIds and marks inactive assistant output unread', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('active-id').textContent).toBe('c1'))

    await act(async () => { wsHandler!({ type: 'agent_stream', conversationId: 'c2', delta: 'working' }) })

    expect(screen.getByTestId('unread-ids').textContent).toBe('c2')
  })

  it('marks active hidden-document output unread until visibility returns', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('active-id').textContent).toBe('c1'))

    setDocumentVisibility('hidden')
    await act(async () => { wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'hidden work' }) })
    expect(screen.getByTestId('unread-ids').textContent).toBe('c1')

    setDocumentVisibility('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })

    expect(screen.getByTestId('unread-ids').textContent).toBe('')
  })

  it('clears unread only after selecting the conversation loads successfully', async () => {
    let resolveC2!: (value: { conversation: typeof api.conv2; messages: [] }) => void
    const c2Load = new Promise<{ conversation: typeof api.conv2; messages: [] }>((resolve) => { resolveC2 = resolve })
    vi.mocked(agentApi.getAgentConversation).mockImplementation(async (id: string) => {
      if (id === 'c2') return c2Load
      return { conversation: api.conv1, messages: [] }
    })
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('active-id').textContent).toBe('c1'))
    await act(async () => { wsHandler!({ type: 'agent_stream', conversationId: 'c2', delta: 'background' }) })
    expect(screen.getByTestId('unread-ids').textContent).toBe('c2')

    fireEvent.click(screen.getByText('select-c2'))
    await waitFor(() => expect(agentApi.getAgentConversation).toHaveBeenCalledWith('c2'))
    expect(screen.getByTestId('unread-ids').textContent).toBe('c2')

    await act(async () => { resolveC2({ conversation: api.conv2, messages: [] }) })
    await waitFor(() => expect(screen.getByTestId('active-id').textContent).toBe('c2'))

    expect(screen.getByTestId('unread-ids').textContent).toBe('')
  })
})

describe('AgentChatContext authoritative PR snapshots', () => {
  it('updates an authoritative snapshot when its delivery still belongs to the active thread', async () => {
    vi.mocked(agentApi.getAgentConversation).mockResolvedValue({ conversation: api.conv1, messages: [prMessage('c1')] })
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('d1:on_review'))
    await act(async () => { fireEvent.click(screen.getByText('apply-d1')) })
    expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('d1:pr_draft')
    expect(screen.getByTestId('apply-result')).toHaveTextContent('accepted')
  })

  it('orders same-delivery WS snapshots by updatedAt and keeps a conflicting tie fail-safe', async () => {
    vi.mocked(agentApi.getAgentConversation).mockResolvedValue({
      conversation: api.conv1,
      messages: [prMessage('c1', prEnvelope({
        decision: 'pr_draft', updatedAt: '2026-07-10 12:00:02',
        prUrl: 'https://github.com/o/r/pull/4', prState: 'pr-created',
      }))],
    })
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('d1:pr_draft'))

    await act(async () => { wsHandler!({
      type: 'agent_pr_decision', conversationId: 'c1',
      ...prEnvelope({ decision: 'on_review', updatedAt: '2026-07-10 12:00:01' }),
    }) })
    expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('d1:pr_draft')

    await act(async () => { wsHandler!({
      type: 'agent_pr_decision', conversationId: 'c1',
      ...prEnvelope({ decision: 'pr_failed', updatedAt: '2026-07-10 12:00:02' }),
    }) })
    expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('d1:pr_draft')

    await act(async () => { wsHandler!({
      type: 'agent_pr_decision', conversationId: 'c1',
      ...prEnvelope({ decision: 'pr_ready', updatedAt: '2026-07-10 12:00:03', prState: 'pr-created' }),
    }) })
    expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('d1:pr_ready')
  })

  it('projects an older rail generation out when a newer createdAt generation arrives without coexistence', async () => {
    vi.mocked(agentApi.getAgentConversation).mockResolvedValue({
      conversation: api.conv1,
      messages: [prMessage('c1', prEnvelope({
        prDeliveryId: 'generation-a', decision: 'pr_failed',
        createdAt: '2026-07-10 12:00:01', updatedAt: '2026-07-10 12:00:01',
      }), 'msg-a')],
    })
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('generation-a:pr_failed'))

    await act(async () => { wsHandler!({
      type: 'agent_pr_decision', conversationId: 'c1',
      ...prEnvelope({
        prDeliveryId: 'generation-b', decision: 'building',
        createdAt: '2026-07-10 12:00:02', updatedAt: '2026-07-10 12:00:02',
      }),
    }) })

    expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('generation-a:superseded,generation-b:building')
    expect(screen.getByTestId('pr-deliveries')).not.toHaveTextContent('generation-a:pr_failed')

    // Even a later-arriving payload cannot revive A: generation creation time
    // is immutable and B has already made A terminal in this view.
    await act(async () => { wsHandler!({
      type: 'agent_pr_decision', conversationId: 'c1',
      ...prEnvelope({
        prDeliveryId: 'generation-a', decision: 'pr_ready',
        createdAt: '2026-07-10 12:00:01', updatedAt: '2026-07-10 12:00:03',
      }),
    }) })
    expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('generation-a:superseded,generation-b:building')
  })

  it('accepts persisted A-from-B rollback evidence, terminalizes B, and rejects stale lineage replays', async () => {
    vi.mocked(agentApi.getAgentConversation).mockResolvedValue({
      conversation: api.conv1,
      messages: [prMessage('c1', prEnvelope({
        prDeliveryId: 'generation-a', decision: 'on_review',
        createdAt: '2026-07-10T12:00:01.000Z', updatedAt: '2026-07-10T12:00:01.000Z',
      }), 'msg-a')],
    })
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('generation-a:on_review'))

    await act(async () => { wsHandler!({
      type: 'agent_pr_decision', conversationId: 'c1',
      ...prEnvelope({
        prDeliveryId: 'generation-b', decision: 'building', supersedesDeliveryId: 'generation-a',
        createdAt: '2026-07-10T12:00:02.000Z', updatedAt: '2026-07-10T12:00:02.000Z',
      }),
    }) })
    await act(async () => { wsHandler!({
      type: 'agent_pr_decision', conversationId: 'c1',
      ...prEnvelope({
        prDeliveryId: 'generation-b', decision: 'discarded', supersedesDeliveryId: 'generation-a',
        createdAt: '2026-07-10T12:00:02.000Z', updatedAt: '2026-07-10T12:00:03.000Z',
      }),
    }) })
    expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('generation-a:superseded,generation-b:discarded')

    await act(async () => { wsHandler!({
      type: 'agent_pr_decision', conversationId: 'c1',
      ...prEnvelope({
        prDeliveryId: 'generation-a', decision: 'on_review', restoredFromDeliveryId: 'generation-b',
        createdAt: '2026-07-10T12:00:01.000Z', updatedAt: '2026-07-10T12:00:04.000Z',
      }),
    }) })
    expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('generation-a:on_review,generation-b:discarded')

    await act(async () => { wsHandler!({
      type: 'agent_pr_decision', conversationId: 'c1',
      ...prEnvelope({
        prDeliveryId: 'generation-c', decision: 'building', supersedesDeliveryId: 'generation-a',
        createdAt: '2026-07-10T12:00:06.000Z', updatedAt: '2026-07-10T12:00:06.000Z',
      }),
    }) })
    await act(async () => { wsHandler!({
      type: 'agent_pr_decision', conversationId: 'c1',
      ...prEnvelope({
        prDeliveryId: 'generation-a', decision: 'on_review', restoredFromDeliveryId: 'generation-b',
        createdAt: '2026-07-10T12:00:01.000Z', updatedAt: '2026-07-10T12:00:07.000Z',
      }),
    }) })
    expect(screen.getByTestId('pr-deliveries')).toHaveTextContent(
      'generation-a:superseded,generation-b:discarded,generation-c:building',
    )
  })

  it('focus hydration can restore A from persisted B rollback lineage', async () => {
    const supersededA = prMessage('c1', prEnvelope({
      prDeliveryId: 'generation-a', decision: 'superseded',
      createdAt: '2026-07-10T12:00:01.000Z', updatedAt: '2026-07-10T12:00:02.000Z',
    }), 'msg-a')
    const failedB = prMessage('c1', prEnvelope({
      prDeliveryId: 'generation-b', decision: 'discarded', supersedesDeliveryId: 'generation-a',
      createdAt: '2026-07-10T12:00:02.000Z', updatedAt: '2026-07-10T12:00:03.000Z',
    }), 'msg-b')
    const restoredA = prMessage('c1', prEnvelope({
      prDeliveryId: 'generation-a', decision: 'on_review', restoredFromDeliveryId: 'generation-b',
      createdAt: '2026-07-10T12:00:01.000Z', updatedAt: '2026-07-10T12:00:04.000Z',
    }), 'msg-a')
    vi.mocked(agentApi.getAgentConversation)
      .mockResolvedValueOnce({ conversation: api.conv1, messages: [supersededA, failedB] })
      .mockResolvedValueOnce({ conversation: api.conv1, messages: [restoredA, failedB] })

    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('pr-deliveries')).toHaveTextContent(
      'generation-a:superseded,generation-b:discarded',
    ))

    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(screen.getByTestId('pr-deliveries')).toHaveTextContent(
      'generation-a:on_review,generation-b:discarded',
    ))
  })

  it('consumes an explicit A-from-B rollback only once after restored A terminalizes', async () => {
    vi.mocked(agentApi.getAgentConversation).mockResolvedValue({
      conversation: api.conv1,
      messages: [prMessage('c1', prEnvelope({
        prDeliveryId: 'generation-a', decision: 'superseded',
        createdAt: '2026-07-10T12:00:01.000Z', updatedAt: '2026-07-10T12:00:02.000Z',
      }), 'msg-a')],
    })
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })

    await act(async () => { wsHandler!({
      type: 'agent_pr_decision', conversationId: 'c1',
      ...prEnvelope({
        prDeliveryId: 'generation-b', decision: 'discarded', supersedesDeliveryId: 'generation-a',
        createdAt: '2026-07-10T12:00:02.000Z', updatedAt: '2026-07-10T12:00:03.000Z',
      }),
    }) })
    await act(async () => { wsHandler!({
      type: 'agent_pr_decision', conversationId: 'c1',
      ...prEnvelope({
        prDeliveryId: 'generation-a', decision: 'on_review', restoredFromDeliveryId: 'generation-b',
        createdAt: '2026-07-10T12:00:01.000Z', updatedAt: '2026-07-10T12:00:04.000Z',
      }),
    }) })
    await act(async () => { wsHandler!({
      type: 'agent_pr_decision', conversationId: 'c1',
      ...prEnvelope({
        prDeliveryId: 'generation-a', decision: 'completed', restoredFromDeliveryId: 'generation-b',
        createdAt: '2026-07-10T12:00:01.000Z', updatedAt: '2026-07-10T12:00:05.000Z',
      }),
    }) })

    await act(async () => { wsHandler!({
      type: 'agent_pr_decision', conversationId: 'c1',
      ...prEnvelope({
        prDeliveryId: 'generation-a', decision: 'on_review', restoredFromDeliveryId: 'generation-b',
        createdAt: '2026-07-10T12:00:01.000Z', updatedAt: '2026-07-10T12:00:06.000Z',
      }),
    }) })

    expect(screen.getByTestId('pr-deliveries')).toHaveTextContent(
      'generation-a:completed,generation-b:discarded',
    )
  })

  it('rejects a delayed HTTP snapshot for A after B superseded it', async () => {
    const messages = [
      prMessage('c1', prEnvelope({
        prDeliveryId: 'generation-c', decision: 'building', supersedesDeliveryId: 'generation-b',
      }), 'msg-c'),
      // Deliberately out of order and still actionable in persisted history:
      // lineage, not row position or A's own decision, makes A stale.
      prMessage('c1', prEnvelope({ prDeliveryId: 'generation-a', decision: 'pr_failed' }), 'msg-a'),
      prMessage('c1', prEnvelope({
        prDeliveryId: 'generation-b', decision: 'superseded', supersedesDeliveryId: 'generation-a',
      }), 'msg-b'),
    ]
    vi.mocked(agentApi.getAgentConversation).mockResolvedValue({ conversation: api.conv1, messages })
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('pr-deliveries')).toHaveTextContent(
      'generation-c:building,generation-a:pr_failed,generation-b:superseded',
    ))

    await act(async () => { fireEvent.click(screen.getByText('apply-a-late')) })

    expect(screen.getByTestId('apply-result')).toHaveTextContent('stale')
    expect(screen.getByTestId('pr-deliveries')).toHaveTextContent(
      'generation-c:building,generation-a:pr_failed,generation-b:superseded',
    )
  })

  it('keeps the fresh C1 card when an older focus hydration resolves after C1→C2→C1', async () => {
    let c1Calls = 0
    let resolveStaleHydration!: (value: { conversation: typeof api.conv1; messages: ReturnType<typeof prMessage>[] }) => void
    const staleHydration = new Promise<{ conversation: typeof api.conv1; messages: ReturnType<typeof prMessage>[] }>(
      (resolve) => { resolveStaleHydration = resolve },
    )
    const initial = prMessage('c1', prEnvelope({ decision: 'on_review' }), 'initial')
    const stale = prMessage('c1', prEnvelope({ decision: 'pr_failed' }), 'stale')
    const fresh = prMessage('c1', prEnvelope({
      decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/9', prState: 'pr-created', branch: 'feat/fresh',
    }), 'fresh')
    vi.mocked(agentApi.getAgentConversation).mockImplementation(async (id: string) => {
      if (id === 'c2') return { conversation: api.conv2, messages: [] }
      c1Calls++
      if (c1Calls === 1) return { conversation: api.conv1, messages: [initial] }
      if (c1Calls === 2) return staleHydration
      return { conversation: api.conv1, messages: [fresh] }
    })
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('d1:on_review'))

    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(c1Calls).toBe(2))
    await act(async () => { fireEvent.click(screen.getByText('select-c2')) })
    await waitFor(() => expect(screen.getByTestId('active-id')).toHaveTextContent('c2'))
    await act(async () => { fireEvent.click(screen.getByText('select-c1')) })
    await waitFor(() => expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('d1:pr_ready'))

    await act(async () => { resolveStaleHydration({ conversation: api.conv1, messages: [stale] }) })

    expect(screen.getByTestId('active-id')).toHaveTextContent('c1')
    expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('d1:pr_ready')
    expect(screen.getByTestId('pr-deliveries')).not.toHaveTextContent('d1:pr_failed')
  })

  it('does not append conversation A delivery into B when the action resolves after a switch', async () => {
    vi.mocked(agentApi.getAgentConversation).mockImplementation(async (id: string) => ({
      conversation: id === 'c2' ? api.conv2 : api.conv1,
      messages: id === 'c2' ? [] : [prMessage('c1')],
    }))
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('d1:on_review'))

    await act(async () => { fireEvent.click(screen.getByText('select-c2')) })
    await waitFor(() => expect(screen.getByTestId('active-id')).toHaveTextContent('c2'))
    expect(screen.getByTestId('pr-deliveries').textContent).toBe('')

    await act(async () => { fireEvent.click(screen.getByText('apply-d1')) })
    expect(screen.getByTestId('active-id')).toHaveTextContent('c2')
    expect(screen.getByTestId('pr-deliveries').textContent).toBe('')
  })
})
