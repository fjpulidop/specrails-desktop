import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import React from 'react'
import { useChat } from '../../features/chat/hooks/useChat'

// Mock dependencies
vi.mock('../../lib/api', () => ({
  getApiBase: () => '/api',
  setActiveProjectId: vi.fn(),
  setApiContext: vi.fn(),
}))

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    activeProjectId: 'proj-1',
  }),
}))

const mockRegisterHandler = vi.fn()
const mockUnregisterHandler = vi.fn()
let capturedMessageHandler: ((msg: unknown) => void) | null = null

vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (id: string, fn: (msg: unknown) => void) => {
      if (id === 'chat') capturedMessageHandler = fn
      mockRegisterHandler(id, fn)
    },
    unregisterHandler: mockUnregisterHandler,
    connectionStatus: 'connected',
  }),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(React.Fragment, null, children)
}

describe('chat flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedMessageHandler = null
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ conversations: [] }),
    })
  })

  it('initializes with empty conversations', async () => {
    const { result } = renderHook(() => useChat(), { wrapper })
    await waitFor(() => {
      expect(result.current.conversations).toEqual([])
    })
  })

  it('createConversation adds a new conversation', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ conversations: [] }) }) // load
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversation: { id: 'conv-new', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' },
        }),
      }) // POST

    const { result } = renderHook(() => useChat(), { wrapper })
    await waitFor(() => {
      expect(result.current.conversations.length).toBe(0)
    })

    await act(async () => {
      await result.current.createConversation()
    })

    expect(result.current.conversations.length).toBe(1)
    expect(result.current.conversations[0].id).toBe('conv-new')
  })

  it('sendMessage adds user message optimistically', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversations: [{ id: 'conv-1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' }],
        }),
      }) // load conversations
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [] }),
      }) // load messages for conv-1
      .mockResolvedValue({ ok: true, json: async () => ({}) }) // POST message

    const { result } = renderHook(() => useChat(), { wrapper })
    await waitFor(() => {
      expect(result.current.conversations.length).toBe(1)
    })

    await act(async () => {
      await result.current.sendMessage('conv-1', 'Hello Claude')
    })

    // User message should be added optimistically
    const conv = result.current.conversations.find((c) => c.id === 'conv-1')
    expect(conv?.messages.length).toBe(1)
    expect(conv?.messages[0].role).toBe('user')
    expect(conv?.messages[0].content).toBe('Hello Claude')
  })

  it('sets isStreaming=true when message is sent', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversations: [{ id: 'conv-1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) })
      .mockResolvedValue({ ok: true, json: async () => ({}) })

    const { result } = renderHook(() => useChat(), { wrapper })
    await waitFor(() => {
      expect(result.current.conversations.length).toBe(1)
    })

    await act(async () => {
      await result.current.sendMessage('conv-1', 'Test message')
    })

    const conv = result.current.conversations.find((c) => c.id === 'conv-1')
    expect(conv?.isStreaming).toBe(true)
  })

  it('receives streaming text via WebSocket chat_stream message', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversations: [{ id: 'conv-1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) })
      .mockResolvedValue({ ok: true, json: async () => ({}) })

    const { result } = renderHook(() => useChat(), { wrapper })
    await waitFor(() => {
      expect(result.current.conversations.length).toBe(1)
    })

    // Send message first to set isStreaming=true
    await act(async () => {
      await result.current.sendMessage('conv-1', 'Hello')
    })

    // Simulate WS chat_stream message
    act(() => {
      capturedMessageHandler?.({
        type: 'chat_stream',
        conversationId: 'conv-1',
        delta: 'Hello, I am ',
        projectId: 'proj-1',
      })
    })

    act(() => {
      capturedMessageHandler?.({
        type: 'chat_stream',
        conversationId: 'conv-1',
        delta: 'Claude!',
        projectId: 'proj-1',
      })
    })

    const conv = result.current.conversations.find((c) => c.id === 'conv-1')
    expect(conv?.streamingText).toBe('Hello, I am Claude!')
  })

  it('finalizes message on chat_done WebSocket message', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversations: [{ id: 'conv-1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) })
      .mockResolvedValue({ ok: true, json: async () => ({}) })

    const { result } = renderHook(() => useChat(), { wrapper })
    await waitFor(() => {
      expect(result.current.conversations.length).toBe(1)
    })

    await act(async () => {
      await result.current.sendMessage('conv-1', 'Hello')
    })

    // Simulate WS chat_done message
    act(() => {
      capturedMessageHandler?.({
        type: 'chat_done',
        conversationId: 'conv-1',
        fullText: 'Complete response from Claude',
        projectId: 'proj-1',
      })
    })

    const conv = result.current.conversations.find((c) => c.id === 'conv-1')
    expect(conv?.isStreaming).toBe(false)
    expect(conv?.streamingText).toBe('')
    // Final message should be appended (user + assistant)
    const assistantMsg = conv?.messages.find((m) => m.role === 'assistant')
    expect(assistantMsg?.content).toBe('Complete response from Claude')
  })

  it('deleteConversation removes conversation from list', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversations: [
            { id: 'conv-1', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' },
            { id: 'conv-2', title: null, model: 'claude-sonnet-4-5', created_at: '', updated_at: '' },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) })
      .mockResolvedValue({ ok: true, json: async () => ({}) }) // DELETE

    const { result } = renderHook(() => useChat(), { wrapper })
    await waitFor(() => {
      expect(result.current.conversations.length).toBe(2)
    })

    await act(async () => {
      await result.current.deleteConversation('conv-1')
    })

    expect(result.current.conversations.length).toBe(1)
    expect(result.current.conversations[0].id).toBe('conv-2')
  })
})
