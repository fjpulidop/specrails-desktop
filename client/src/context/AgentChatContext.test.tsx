import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const missionWindowsMock = vi.hoisted(() => ({
  focus: vi.fn(async () => false), isEditable: vi.fn(() => true), discard: vi.fn(async () => true),
  current: null as null | { conversationId: string },
  secondary: false,
}))
vi.mock('./MissionWindowsContext', () => ({ useMissionWindows: () => missionWindowsMock }))
vi.mock('../lib/mission-windows', async original => ({
  ...await original<typeof import('../lib/mission-windows')>(),
  isMissionWindowRoute: () => missionWindowsMock.secondary,
}))

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
    steerQueuedAgentMessage: vi.fn(async () => 'saved' as const),
    removeQueuedAgentMessage: vi.fn(async () => 'saved' as const),
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
      <span data-testid="stream-text">{agentChat.streamingText}</span>
      <span data-testid="pending-inputs">{JSON.stringify(agentChat.queuedMessages)}</span>
      <span data-testid="transcript-data">{JSON.stringify(agentChat.messages)}</span>
      <span data-testid="live-tools">{JSON.stringify(agentChat.liveTools)}</span>
      <span data-testid="message-text">{agentChat.messages.map((message) => message.content).join('|')}</span>
      <span data-testid="favorites">{[...agentChat.favoriteConversationIds].sort().join(',')}</span>
      <button onClick={() => void agentChat.selectConversation('c1', { windowRestore: true, signal: new AbortController().signal }).catch(() => setApplyResult('restore-failed'))}>restore-c1</button>
      <button onClick={() => agentChat.toggleFavoriteConversation('c1')}>favorite-c1</button>
      <button onClick={() => void agentChat.setModel('model-2')}>model</button>
      <button onClick={() => void agentChat.abort()}>abort</button>
      <button onClick={() => void agentChat.deleteConversation('c1')}>delete-c1</button>
      <button onClick={agentChat.open}>open</button>
      <button onClick={() => void agentChat.send('hello')}>send</button>
      <button onClick={() => void agentChat.send('deleted input', { queueId: 'removed-input' })}>retry-removed</button>
      <button onClick={() => void agentChat.steerQueuedMessage('selected-input')}>steer-selected</button>
      <button onClick={() => void agentChat.removeQueuedMessage('selected-input')}>remove-selected</button>
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
  missionWindowsMock.focus.mockResolvedValue(false)
  missionWindowsMock.isEditable.mockReturnValue(true)
  missionWindowsMock.discard.mockResolvedValue(true)
  missionWindowsMock.secondary = false
  missionWindowsMock.current = null
  localStorage.removeItem('specrails-desktop:favorite-agent-conversations')
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
  it('updates queued receipts without changing stream, tools, order or other messages and carries early receipts into delivery', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await act(async () => {
      wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'Working' })
      wsHandler!({ type: 'agent_tool', conversationId: 'c1', tool: 'Read', toolId: 'read-1' })
      wsHandler!({ type: 'agent_queued', conversationId: 'c1', queueId: 'other', text: 'Other', deliveryMode: 'queue' })
      wsHandler!({ type: 'agent_input_receipt', conversationId: 'c1', queueId: 'receipt-input', receipt: 'received' })
      wsHandler!({ type: 'agent_queued', conversationId: 'c1', queueId: 'receipt-input', text: 'Correction', deliveryMode: 'steer', attachmentIds: ['a1'] })
    })
    expect(JSON.parse(screen.getByTestId('pending-inputs').textContent!)).toMatchObject([{ queueId: 'other' }, { queueId: 'receipt-input', deliveryReceipt: 'received', attachmentIds: ['a1'] }])
    await act(async () => {
      wsHandler!({ type: 'agent_input_receipt', conversationId: 'c1', queueId: 'receipt-input', receipt: 'read' })
      wsHandler!({ type: 'agent_input_receipt', conversationId: 'c1', queueId: 'receipt-input', receipt: 'received' })
    })
    expect(screen.getByTestId('stream-text')).toHaveTextContent('Working')
    expect(screen.getByTestId('live-tools')).toHaveTextContent('read-1')
    expect(screen.getByTestId('streaming')).toHaveTextContent('true')
    expect(JSON.parse(screen.getByTestId('pending-inputs').textContent!)[1].deliveryReceipt).toBe('read')
    await act(async () => {
      wsHandler!({ type: 'agent_steered', conversationId: 'c1', queueId: 'receipt-input', messageId: 'receipt-row', text: 'Correction', attachmentIds: ['a1'], delivery_receipt: 'received' })
    })
    expect(JSON.parse(screen.getByTestId('transcript-data').textContent!)).toMatchObject([{ id: 'receipt-row', delivery_receipt: 'read', attachment_ids: ['a1'] }])
    expect(JSON.parse(screen.getByTestId('pending-inputs').textContent!)).toMatchObject([{ queueId: 'other' }])
  })

  it('updates a persisted receipt in place and preserves read over duplicate events and stale rehydration', async () => {
    const user = { id: 'persisted-user', conversation_id: 'c1', role: 'user' as const, content: 'Requested task', delivery_receipt: 'received' as const, created_at: '', attachment_ids: ['saved'] }
    const assistant = { id: 'reply', conversation_id: 'c1', role: 'assistant' as const, content: 'Response', created_at: '' }
    vi.mocked(agentApi.getAgentConversation).mockImplementation(async id => ({ conversation: id === 'c1' ? api.conv1 : api.conv2, messages: id === 'c1' ? [user, assistant] : [] }))
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await act(async () => {
      wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'Continuing' })
      wsHandler!({ type: 'agent_input_receipt', conversationId: 'c1', queueId: 'persisted-input', messageId: user.id, receipt: 'read' })
      wsHandler!({ type: 'agent_input_receipt', conversationId: 'c1', queueId: 'persisted-input', messageId: user.id, receipt: 'received' })
    })
    expect(JSON.parse(screen.getByTestId('transcript-data').textContent!)).toEqual([{ ...user, delivery_receipt: 'read' }, assistant])
    expect(screen.getByTestId('stream-text')).toHaveTextContent('Continuing')
    await act(async () => { fireEvent.click(screen.getByText('select-c2')) })
    await act(async () => { fireEvent.click(screen.getByText('select-c1')) })
    expect(JSON.parse(screen.getByTestId('transcript-data').textContent!)).toEqual([{ ...user, delivery_receipt: 'read' }, assistant])
    expect(agentApi.sendAgentMessage).not.toHaveBeenCalled()
  })

  it('does not resurrect a removed send retried after reload while preserving the active stream and other pending messages', async () => {
    const pending = { queueId: 'other-input', text: 'Keep this one', deliveryMode: 'queue' as const, attachmentIds: ['diagram'] }
    vi.mocked(agentApi.getAgentConversation).mockResolvedValue({ conversation: api.conv1, messages: [], pendingMessages: [pending], live: { isStreaming: true, streamingText: 'Current work' } })
    vi.mocked(agentApi.sendAgentMessage).mockResolvedValueOnce({ queued: false, duplicate: true, removed: true })
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    // No removal event or client tombstone exists in this freshly loaded view.
    await act(async () => { fireEvent.click(screen.getByText('retry-removed')) })
    expect(agentApi.sendAgentMessage).toHaveBeenCalledWith('c1', 'deleted input', expect.objectContaining({ queueId: 'removed-input' }))
    expect(JSON.parse(screen.getByTestId('pending-inputs').textContent!)).toEqual([pending])
    expect(JSON.parse(screen.getByTestId('transcript-data').textContent!)).toEqual([])
    expect(screen.getByTestId('streaming')).toHaveTextContent('true')
    expect(screen.getByTestId('stream-text')).toHaveTextContent('Current work')
    await act(async () => { wsHandler!({ type: 'agent_queued', conversationId: 'c1', queueId: 'removed-input', text: 'Delayed old echo' }) })
    expect(JSON.parse(screen.getByTestId('pending-inputs').textContent!)).toEqual([pending])
  })

  it.each([false, true])('removed idle retries undo only their own optimistic busy state (new output=%s)', async (newOutput) => {
    let finish!: (result: agentApi.AgentSendResponse) => void
    vi.mocked(agentApi.sendAgentMessage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    fireEvent.click(screen.getByText('retry-removed'))
    expect(screen.getByTestId('streaming')).toHaveTextContent('true')
    await act(async () => {
      if (newOutput) wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'Concurrent active turn' })
      finish({ queued: false, duplicate: true, removed: true })
    })
    expect(JSON.parse(screen.getByTestId('transcript-data').textContent!)).toEqual([])
    expect(JSON.parse(screen.getByTestId('pending-inputs').textContent!)).toEqual([])
    expect(screen.getByTestId('streaming')).toHaveTextContent(String(newOutput))
    expect(screen.getByTestId('stream-text').textContent).toBe(newOutput ? 'Concurrent active turn' : '')
  })

  it('preserves metadata and other messages when Steer finishes after delivery and a conversation switch', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const selected = { queueId: 'selected-input', text: 'Use #12', deliveryMode: 'queue', attachmentIds: ['diagram'], contextRefs: [{ kind: 'spec', id: '12', token: '#12' }] }
    await act(async () => {
      wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'Working' })
      wsHandler!({ type: 'agent_queued', conversationId: 'c1', ...selected })
      wsHandler!({ type: 'agent_queued', conversationId: 'c1', queueId: 'other-input', text: 'Later', deliveryMode: 'queue' })
    })
    let finish!: (result: 'saved') => void
    vi.mocked(agentApi.steerQueuedAgentMessage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByText('steer-selected'))
    await act(async () => {
      wsHandler!({ type: 'agent_steered', conversationId: 'c1', queueId: selected.queueId, messageId: 'selected-user', text: selected.text, contextRefs: selected.contextRefs, attachmentIds: selected.attachmentIds })
      fireEvent.click(screen.getByText('select-c2'))
    })
    await act(async () => { finish('saved') })
    expect(agentApi.steerQueuedAgentMessage).toHaveBeenCalledWith('c1', selected.queueId)
    expect(JSON.parse(screen.getByTestId('pending-inputs').textContent!)).toEqual([])
    expect(JSON.parse(screen.getByTestId('transcript-data').textContent!)).toEqual([])
    await act(async () => { fireEvent.click(screen.getByText('select-c1')) })
    expect(JSON.parse(screen.getByTestId('pending-inputs').textContent!)).toMatchObject([{ queueId: 'other-input', deliveryMode: 'queue' }])
    expect(JSON.parse(screen.getByTestId('transcript-data').textContent!)).toMatchObject([{ id: 'selected-user', attachment_ids: ['diagram'], context_refs: selected.contextRefs, delivery_status: 'delivered' }])
    expect(agentApi.sendAgentMessage).not.toHaveBeenCalled()
  })

  it('keeps promoted mode on delayed queue echoes and removes one message across windows without a transcript row', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await act(async () => {
      wsHandler!({ type: 'agent_queued', conversationId: 'c1', queueId: 'selected-input', text: 'Selected', attachmentIds: ['a1'], deliveryMode: 'queue' })
      wsHandler!({ type: 'agent_queued', conversationId: 'c1', queueId: 'other-input', text: 'Other', deliveryMode: 'queue' })
      wsHandler!({ type: 'agent_queue_edited', conversationId: 'c1', queueId: 'selected-input', deliveryMode: 'steer' })
      wsHandler!({ type: 'agent_queued', conversationId: 'c1', queueId: 'selected-input', text: 'Selected', deliveryMode: 'queue' })
    })
    expect(JSON.parse(screen.getByTestId('pending-inputs').textContent!)[0]).toMatchObject({ queueId: 'selected-input', deliveryMode: 'steer', attachmentIds: ['a1'] })
    await act(async () => { fireEvent.click(screen.getByText('remove-selected')); fireEvent.click(screen.getByText('steer-selected')) })
    expect(agentApi.removeQueuedAgentMessage).not.toHaveBeenCalled()
    expect(agentApi.steerQueuedAgentMessage).not.toHaveBeenCalled()
    await act(async () => {
      wsHandler!({ type: 'agent_queue_removed', conversationId: 'c1', queueId: 'other-input' })
      wsHandler!({ type: 'agent_queued', conversationId: 'c1', queueId: 'other-input', text: 'Late echo' })
    })
    expect(JSON.parse(screen.getByTestId('pending-inputs').textContent!)).toHaveLength(1)
    expect(JSON.parse(screen.getByTestId('transcript-data').textContent!)).toEqual([])
  })

  it('settles an unconfirmed native input without replay, losing metadata or clearing other pending inputs and tools', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const contextRefs = [{ kind: 'file' as const, id: 'src/api.ts', token: '@src/api.ts', scope: { projectId: 'p1', repositoryId: 'api' } }]
    const other = { queueId: 'still-pending', text: 'Also update the tests', attachmentIds: ['other-file'], deliveryMode: 'steer' as const }
    const settled = {
      type: 'agent_steered', conversationId: 'c1', queueId: 'uncertain-input', messageId: 'uncertain-user',
      text: 'Use this contract', attachmentIds: ['contract-file'], contextRefs, deliveryStatus: 'interrupted',
      timestamp: '2026-09-05T20:00:00Z',
      assistantSegment: { id: 'uncertain-segment', content: 'Inspecting the current contract', created_at: '2026-09-05T19:59:59Z' },
    }
    await act(async () => {
      wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: settled.assistantSegment.content })
      wsHandler!({ type: 'agent_tool', conversationId: 'c1', tool: 'Read', toolId: 'live-read' })
      wsHandler!({ type: 'agent_queued', conversationId: 'c1', queueId: settled.queueId, text: settled.text, contextRefs, attachmentIds: settled.attachmentIds })
      wsHandler!({ type: 'agent_queued', conversationId: 'c1', ...other })
      wsHandler!(settled)
    })
    expect(screen.getByTestId('streaming')).toHaveTextContent('true')
    expect(screen.getByTestId('stream-text').textContent).toBe('')
    expect(JSON.parse(screen.getByTestId('pending-inputs').textContent!)).toEqual([other])
    let rows = JSON.parse(screen.getByTestId('transcript-data').textContent!)
    expect(rows.map((row: agentApi.AgentMessage) => row.content)).toEqual(['Inspecting the current contract', 'Use this contract'])
    expect(rows[1]).toMatchObject({ id: 'uncertain-user', delivery_status: 'interrupted', attachment_ids: ['contract-file'], context_refs: contextRefs })
    await act(async () => {
      wsHandler!({ type: 'agent_stream', conversationId: 'c1', delta: 'Read complete' })
      wsHandler!({ type: 'agent_tool_result', conversationId: 'c1', toolId: 'live-read', output: 'Original tool result' })
      wsHandler!(settled)
      wsHandler!({ type: 'agent_queued', conversationId: 'c1', queueId: settled.queueId, text: 'Delayed admission echo' })
    })
    rows = JSON.parse(screen.getByTestId('transcript-data').textContent!)
    expect(rows).toHaveLength(2)
    expect(rows[1].delivery_status).toBe('interrupted')
    expect(screen.getByTestId('stream-text')).toHaveTextContent('Read complete')
    expect(screen.getByTestId('live-tools')).toHaveTextContent('Original tool result')
    expect(JSON.parse(screen.getByTestId('pending-inputs').textContent!)).toEqual([other])
    expect(agentApi.sendAgentMessage).not.toHaveBeenCalled()
  })

  it('hydrates unconfirmed delivery status and ignores replayed delivery checkpoints after reload', async () => {
    const segment = { id: 'persisted-segment', conversation_id: 'c1', role: 'assistant' as const, content: 'Persisted output', created_at: '' }
    const user = { id: 'persisted-uncertain', conversation_id: 'c1', role: 'user' as const, content: 'Unconfirmed correction', delivery_status: 'interrupted' as const, attachment_ids: ['saved-file'], context_refs: [{ kind: 'spec' as const, id: '12', token: '#12' }], created_at: '' }
    const pending = { queueId: 'newer-input', text: 'Next correction', attachmentIds: ['next-file'], deliveryMode: 'steer' as const }
    vi.mocked(agentApi.getAgentConversation).mockResolvedValue({ conversation: api.conv1, messages: [segment, user], pendingMessages: [pending], live: { isStreaming: true, streamingText: 'Newer streamed output' } })
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await act(async () => {
      wsHandler!({ type: 'agent_steered', conversationId: 'c1', queueId: 'old-input', messageId: user.id, text: user.content, deliveryStatus: 'interrupted', assistantSegment: { id: segment.id, content: segment.content, created_at: '' } })
      wsHandler!({ type: 'agent_queued', conversationId: 'c1', queueId: 'old-input', text: user.content })
    })
    expect(JSON.parse(screen.getByTestId('transcript-data').textContent!)).toEqual([segment, user])
    expect(JSON.parse(screen.getByTestId('pending-inputs').textContent!)).toEqual([pending])
    expect(screen.getByTestId('stream-text')).toHaveTextContent('Newer streamed output')
    expect(screen.getByTestId('streaming')).toHaveTextContent('true')
    expect(agentApi.sendAgentMessage).not.toHaveBeenCalled()
  })

  it('restores pending inputs and current output from the active-turn snapshot without resending', async () => {
    wsConnectionStatus = 'disconnected'
    const view = render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    const pending = [{ queueId: 'reconnect-input', text: 'Use the other API', attachmentIds: ['reference-image'], deliveryMode: 'steer' as const }]
    vi.mocked(agentApi.getAgentActiveTurns).mockResolvedValue({ snapshotVersion: 20, capturedAt: new Date().toISOString(), turns: [{ conversationId: 'c1', startedAt: '', streamingText: 'Still working', pendingMessages: pending }] })
    wsConnectionStatus = 'connected'
    view.rerender(<AgentChatProvider><Harness /></AgentChatProvider>)
    await waitFor(() => expect(screen.getByTestId('stream-text')).toHaveTextContent('Still working'))
    expect(JSON.parse(screen.getByTestId('pending-inputs').textContent!)).toEqual(pending)
    expect(agentApi.sendAgentMessage).not.toHaveBeenCalled()
  })

  it('refreshes persisted cards after project recovery while preserving the current live turn', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('active-id')).toHaveTextContent('c1'))
    await act(async () => { fireEvent.click(screen.getByText('send')) })
    expect(screen.getByTestId('streaming')).toHaveTextContent('true')
    const listCalls = vi.mocked(agentApi.listAgentConversations).mock.calls.length
    vi.mocked(agentApi.getAgentConversation).mockResolvedValue({
      conversation: api.conv1,
      messages: [prMessage('c1', prEnvelope({ decision: 'pr_draft' }))],
    })
    await act(async () => { wsHandler?.({ type: 'desktop.project_recovered', projectId: 'p1' }) })
    await waitFor(() => expect(screen.getByTestId('pr-deliveries')).toHaveTextContent('d1:pr_draft'))
    expect(agentApi.listAgentConversations).toHaveBeenCalledTimes(listCalls + 1)
    expect(screen.getByTestId('active-id')).toHaveTextContent('c1')
    expect(screen.getByTestId('streaming')).toHaveTextContent('true')
    expect(agentApi.sendAgentMessage).toHaveBeenCalledTimes(1)
  })

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


describe('AgentChatContext native window ownership', () => {
  it('focuses an external mission without loading another editable copy', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('select-c1')) })
    missionWindowsMock.focus.mockResolvedValue(true)
    vi.mocked(agentApi.getAgentConversation).mockClear()
    await act(async () => { fireEvent.click(screen.getByText('select-c2')) })
    expect(missionWindowsMock.focus).toHaveBeenLastCalledWith('c2')
    expect(agentApi.getAgentConversation).not.toHaveBeenCalled()
    expect(screen.getByTestId('active-id')).toHaveTextContent('c1')
  })

  it('blocks backend mutations in the frozen source and preserves execution', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('select-c1')) })
    missionWindowsMock.isEditable.mockReturnValue(false)
    await act(async () => {
      for (const label of ['send', 'abort', 'model', 'delete-c1']) fireEvent.click(screen.getByText(label))
    })
    expect(agentApi.sendAgentMessage).not.toHaveBeenCalled()
    expect(agentApi.abortAgentTurn).not.toHaveBeenCalled()
    expect(agentApi.patchAgentConversation).not.toHaveBeenCalled()
    expect(agentApi.deleteAgentConversation).not.toHaveBeenCalled()
  })

  it('hydrates the native-authorized mission before current has reached React', async () => {
    missionWindowsMock.secondary = true
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('restore-c1')) })
    expect(screen.getByTestId('active-id')).toHaveTextContent('c1')
    expect(agentApi.createAgentConversation).not.toHaveBeenCalled()
    expect(missionWindowsMock.focus).not.toHaveBeenCalled()
  })

  it('rejects a superseded restoration instead of acknowledging the wrong mission', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof agentApi.getAgentConversation>>) => void
    vi.mocked(agentApi.getAgentConversation).mockImplementation(id => id === 'c1' ? new Promise(done => { resolve = done }) : Promise.resolve({ conversation: api.conv2, messages: [] }))
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('restore-c1')) })
    await act(async () => { fireEvent.click(screen.getByText('select-c2')) })
    await act(async () => { resolve({ conversation: api.conv1, messages: [] }) })
    expect(screen.getByTestId('active-id')).toHaveTextContent('c2')
    expect(screen.getByTestId('apply-result')).toHaveTextContent('restore-failed')
  })

  it('merges favorites with other windows and observes their changes', async () => {
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    localStorage.setItem('specrails-desktop:favorite-agent-conversations', '["c2"]')
    fireEvent.click(screen.getByText('favorite-c1'))
    expect(JSON.parse(localStorage.getItem('specrails-desktop:favorite-agent-conversations')!)).toEqual(['c2', 'c1'])
    localStorage.setItem('specrails-desktop:favorite-agent-conversations', '["c2"]')
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'specrails-desktop:favorite-agent-conversations' })) })
    expect(screen.getByTestId('favorites')).toHaveTextContent('c2')
    expect(screen.getByTestId('favorites')).not.toHaveTextContent('c1')
  })
})
