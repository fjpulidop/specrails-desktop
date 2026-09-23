import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useChat } from '../useChat'

// ─── Mock useSharedWebSocket ───────────────────────────────────────────────────

let wsHandler: ((msg: unknown) => void) | null = null

vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: vi.fn((_id: string, fn: (msg: unknown) => void) => { wsHandler = fn }),
    unregisterHandler: vi.fn(),
    connectionStatus: 'connected' as const,
  }),
}))

// ─── Mock useDesktop ───────────────────────────────────────────────────────────────

let mockActiveProjectId: string | null = 'proj-1'

vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    activeProjectId: mockActiveProjectId,
  }),
}))

// ─── Mock lib/api ──────────────────────────────────────────────────────────────

vi.mock('../../../../lib/api', () => ({
  getApiBase: () => `/api/projects/${mockActiveProjectId}`,
}))

// ─── Mock sonner ──────────────────────────────────────────────────────────────

const mockToastError = vi.fn()
vi.mock('sonner', () => ({
  toast: { error: (msg: string) => mockToastError(msg) },
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFetchOk(body: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
  } as Response)
}

function makeFetchFail() {
  return Promise.reject(new Error('network error'))
}

function makeFetchNotOk() {
  return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wsHandler = null
    mockActiveProjectId = 'proj-1'
    localStorage.clear()
    // Default fetch: empty conversations
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ conversations: [] }),
    })
  })

  it('initial state: empty conversations', async () => {
    const { result } = renderHook(() => useChat())
    expect(result.current.conversations).toEqual([])
  })

  it('initial isPanelOpen reads from localStorage', () => {
    window.localStorage.setItem('specrails.chatPanelOpen', 'true')
    const { result } = renderHook(() => useChat())
    expect(result.current.isPanelOpen).toBe(true)
  })

  it('loads conversations from API on mount', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          conversations: [{ id: 'c1', title: 'Chat 1', model: 'claude-sonnet-4-5', created_at: '', updated_at: '' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [{ id: 1, conversation_id: 'c1', role: 'user', content: 'hello', created_at: '' }] }),
      })

    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(result.current.conversations).toHaveLength(1))
    expect(result.current.conversations[0].id).toBe('c1')
    expect(result.current.conversations[0].messages).toHaveLength(1)
  })

  it('sendMessage: optimistically adds user message, sets isStreaming', async () => {
    // Setup: have a conversation loaded
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          conversations: [{ id: 'c1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [] }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) } as unknown as Response) // sendMessage POST

    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(result.current.conversations).toHaveLength(1))

    act(() => {
      result.current.sendMessage('c1', 'hello world')
    })

    // Check optimistic message was added and streaming started
    expect(result.current.conversations[0].messages).toHaveLength(1)
    expect(result.current.conversations[0].messages[0].content).toBe('hello world')
    expect(result.current.conversations[0].messages[0].role).toBe('user')
    expect(result.current.conversations[0].isStreaming).toBe(true)
  })

  it('sendMessage failure: rolls back optimistic message and shows toast', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          conversations: [{ id: 'c1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [] }),
      })
      .mockRejectedValueOnce(new Error('network error')) // sendMessage fails

    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(result.current.conversations).toHaveLength(1))

    await act(async () => {
      await result.current.sendMessage('c1', 'will fail')
    })

    // Optimistic message should be rolled back
    expect(result.current.conversations[0].messages).toHaveLength(0)
    // isStreaming should be false
    expect(result.current.conversations[0].isStreaming).toBe(false)
    // Toast error should have been called
    expect(mockToastError).toHaveBeenCalledWith('Failed to send message')
  })

  it('WS chat_stream: accumulates delta in streamingText', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          conversations: [{ id: 'c1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [] }),
      })

    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(result.current.conversations).toHaveLength(1))

    act(() => {
      wsHandler?.({ type: 'chat_stream', conversationId: 'c1', delta: 'Hello' })
    })
    act(() => {
      wsHandler?.({ type: 'chat_stream', conversationId: 'c1', delta: ' world' })
    })

    expect(result.current.conversations[0].streamingText).toBe('Hello world')
    expect(result.current.conversations[0].isStreaming).toBe(true)
  })

  it('WS chat_done: adds full message, clears streaming', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          conversations: [{ id: 'c1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [] }),
      })

    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(result.current.conversations).toHaveLength(1))

    act(() => {
      wsHandler?.({ type: 'chat_stream', conversationId: 'c1', delta: 'Partial...' })
    })
    act(() => {
      wsHandler?.({ type: 'chat_done', conversationId: 'c1', fullText: 'Complete response' })
    })

    const convo = result.current.conversations[0]
    expect(convo.isStreaming).toBe(false)
    expect(convo.streamingText).toBe('')
    expect(convo.messages).toHaveLength(1)
    expect(convo.messages[0].role).toBe('assistant')
    expect(convo.messages[0].content).toBe('Complete response')
  })

  it('WS chat_error: clears streaming state', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          conversations: [{ id: 'c1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [] }),
      })

    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(result.current.conversations).toHaveLength(1))

    act(() => {
      wsHandler?.({ type: 'chat_stream', conversationId: 'c1', delta: 'partial' })
    })
    act(() => {
      wsHandler?.({ type: 'chat_error', conversationId: 'c1' })
    })

    expect(result.current.conversations[0].isStreaming).toBe(false)
    expect(result.current.conversations[0].streamingText).toBe('')
  })

  it('WS chat_command_proposal: adds to commandProposals', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          conversations: [{ id: 'c1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [] }),
      })

    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(result.current.conversations).toHaveLength(1))

    act(() => {
      wsHandler?.({ type: 'chat_command_proposal', conversationId: 'c1', command: 'npm test' })
    })

    expect(result.current.conversations[0].commandProposals).toContain('npm test')
  })

  it('createConversation: POSTs and adds new convo (max 3)', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ conversations: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          conversation: { id: 'new-c1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' },
        }),
      })

    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(result.current.conversations).toHaveLength(0))

    await act(async () => {
      await result.current.createConversation()
    })

    expect(result.current.conversations).toHaveLength(1)
    expect(result.current.conversations[0].id).toBe('new-c1')
  })

  it('deleteConversation: removes from state', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          conversations: [{ id: 'c1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [] }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) } as unknown as Response)

    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(result.current.conversations).toHaveLength(1))

    await act(async () => {
      await result.current.deleteConversation('c1')
    })

    expect(result.current.conversations).toHaveLength(0)
  })

  it('togglePanel: toggles and persists to localStorage', async () => {
    const { result } = renderHook(() => useChat())

    expect(result.current.isPanelOpen).toBe(false)

    act(() => { result.current.togglePanel() })
    expect(result.current.isPanelOpen).toBe(true)
    expect(window.localStorage.getItem('specrails.chatPanelOpen')).toBe('true')

    act(() => { result.current.togglePanel() })
    expect(result.current.isPanelOpen).toBe(false)
    expect(window.localStorage.getItem('specrails.chatPanelOpen')).toBe('false')
  })

  it('abortStream: sends DELETE request', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true } as Response)

    const { result } = renderHook(() => useChat())
    await act(async () => {
      await result.current.abortStream('c1')
    })

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/chat/conversations/c1/messages/stream'),
      expect.objectContaining({ method: 'DELETE' })
    )
  })

  it('does not apply WS messages from other projects', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          conversations: [{ id: 'c1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [] }),
      })

    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(result.current.conversations).toHaveLength(1))

    // Message from different project should be ignored
    act(() => {
      wsHandler?.({ type: 'chat_stream', conversationId: 'c1', delta: 'from other project', projectId: 'other-proj' })
    })

    expect(result.current.conversations[0].streamingText).toBe('')
  })

  it('dismissCommandProposal: removes specific command from proposals', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          conversations: [{ id: 'c1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [] }),
      })

    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(result.current.conversations).toHaveLength(1))

    // Add command proposals via WS
    act(() => {
      wsHandler?.({ type: 'chat_command_proposal', conversationId: 'c1', command: 'npm test' })
      wsHandler?.({ type: 'chat_command_proposal', conversationId: 'c1', command: 'npm build' })
    })

    expect(result.current.conversations[0].commandProposals).toHaveLength(2)

    act(() => {
      result.current.dismissCommandProposal('c1', 'npm test')
    })

    expect(result.current.conversations[0].commandProposals).toEqual(['npm build'])
  })

  it('confirmCommand: sends POST to /spawn endpoint', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true } as Response)

    const { result } = renderHook(() => useChat())
    await act(async () => {
      await result.current.confirmCommand('npm test')
    })

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/spawn'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ command: 'npm test' }),
      })
    )
  })

  it('startWithMessage: creates conversation then sends message', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ conversations: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          conversation: { id: 'new-c1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) } as unknown as Response) // sendMessage POST

    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(result.current.conversations).toHaveLength(0))

    await act(async () => {
      await result.current.startWithMessage('What is the project status?')
    })

    // Conversation was created
    expect(result.current.conversations).toHaveLength(1)
    expect(result.current.conversations[0].id).toBe('new-c1')
    // Message was sent
    expect(result.current.conversations[0].messages).toHaveLength(1)
    expect(result.current.conversations[0].messages[0].content).toBe('What is the project status?')
  })

  it('startWithMessage: ignores non-ok response', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ conversations: [] }),
      })
      .mockResolvedValueOnce({ ok: false } as Response)

    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(result.current.conversations).toHaveLength(0))

    await act(async () => {
      await result.current.startWithMessage('Will fail silently')
    })

    // No conversation created
    expect(result.current.conversations).toHaveLength(0)
  })

  it('WS chat_title_update: updates conversation title', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          conversations: [{ id: 'c1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [] }),
      })

    const { result } = renderHook(() => useChat())
    await waitFor(() => expect(result.current.conversations).toHaveLength(1))

    act(() => {
      wsHandler?.({ type: 'chat_title_update', conversationId: 'c1', title: 'New Title' })
    })

    expect(result.current.conversations[0].title).toBe('New Title')
  })
})
