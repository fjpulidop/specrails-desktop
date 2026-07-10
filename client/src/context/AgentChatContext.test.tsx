import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

let wsHandler: ((msg: unknown) => void) | null = null

vi.mock('../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (m: unknown) => void) => { wsHandler = fn },
    unregisterHandler: () => { wsHandler = null },
    connectionStatus: 'connected',
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

const prMessage = (conversationId: string) => ({
  id: `msg-${conversationId}`, conversation_id: conversationId, role: 'system' as const,
  content: JSON.stringify(prEnvelope()), created_at: '',
})

function setDocumentVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value,
  })
}

function Harness() {
  const agentChat = useAgentChat()
  return (
    <div>
      <span data-testid="active-id">{agentChat.active?.id ?? ''}</span>
      <span data-testid="unread-ids">{[...agentChat.unreadConversationIds].sort().join(',')}</span>
      <span data-testid="pr-deliveries">{agentChat.messages.flatMap((message) => {
        const envelope = message.role === 'system' ? agentApi.parsePrDecisionEnvelope(message.content) : null
        return envelope ? [`${envelope.prDeliveryId}:${envelope.decision}`] : []
      }).join(',')}</span>
      <button onClick={agentChat.open}>open</button>
      <button onClick={() => void agentChat.selectConversation('c2')}>select-c2</button>
      <button onClick={() => agentChat.applyPrDecisionSnapshot(prEnvelope({ decision: 'pr_draft' }))}>apply-d1</button>
    </div>
  )
}

beforeEach(() => {
  wsHandler = null
  vi.clearAllMocks()
  vi.mocked(agentApi.listAgentConversations).mockResolvedValue([api.conv1, api.conv2])
  vi.mocked(agentApi.getAgentConversation).mockImplementation(async (id: string) => ({
    conversation: id === 'c2' ? api.conv2 : api.conv1,
    messages: [],
  }))
  vi.mocked(agentApi.getMcpStatus).mockResolvedValue({ enabled: true, running: true })
  vi.mocked(agentApi.getAvailableProviders).mockResolvedValue({ any: true, providers: [] })
  setDocumentVisibility('visible')
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
