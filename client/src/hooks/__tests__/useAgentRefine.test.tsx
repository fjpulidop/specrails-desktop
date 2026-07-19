import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import { useAgentRefine } from '../useAgentRefine'
import { SharedWebSocketContext } from '../useSharedWebSocket'

interface FakeWs {
  registerHandler: (id: string, fn: (msg: unknown) => void) => void
  unregisterHandler: (id: string) => void
  connectionStatus: 'disconnected' | 'connecting' | 'connected'
  emit: (msg: unknown) => void
}

function makeFakeWs(): FakeWs {
  const handlers = new Map<string, (msg: unknown) => void>()
  return {
    registerHandler: (id, fn) => handlers.set(id, fn),
    unregisterHandler: (id) => handlers.delete(id),
    connectionStatus: 'connected',
    emit: (msg) => {
      for (const h of handlers.values()) h(msg)
    },
  }
}

function wrapper(ws: FakeWs) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(SharedWebSocketContext.Provider, { value: ws }, children)
}

const PROJECT = 'test-project'
const API = `/api/projects/${PROJECT}/profiles/catalog`

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }
}

type HookResult = ReturnType<typeof renderHook<ReturnType<typeof useAgentRefine>, { pid: string | null }>>['result']

function renderRefine(ws: FakeWs, pid: string | null = PROJECT) {
  return renderHook(({ pid: p }: { pid: string | null }) => useAgentRefine(p), {
    wrapper: wrapper(ws),
    initialProps: { pid },
  })
}

/** open() an agent then start() a turn that the server accepts with refineId 'r1'. */
async function startSession(result: HookResult, refineId = 'r1') {
  act(() => {
    result.current.open('agent-1', 'base body')
  })
  ;(global.fetch as Mock).mockResolvedValueOnce(jsonResponse({ refineId }))
  await act(async () => {
    await result.current.start('make it better')
  })
}

describe('useAgentRefine', () => {
  let ws: FakeWs

  beforeEach(() => {
    ws = makeFakeWs()
  })

  it('returns initial closed state', () => {
    const { result } = renderRefine(ws)
    expect(result.current.state.uiState).toBe('closed')
    expect(result.current.state.refineId).toBeNull()
    expect(result.current.state.agentId).toBeNull()
    expect(result.current.state.history).toEqual([])
    expect(result.current.state.streamingText).toBe('')
    expect(result.current.state.draftBody).toBeNull()
    expect(result.current.state.autoTest).toBe(false)
    expect(result.current.state.errorMessage).toBeNull()
  })

  it('open() moves to composing with agentId and baseBody', () => {
    const { result } = renderRefine(ws)
    act(() => {
      result.current.open('agent-1', 'original body')
    })
    expect(result.current.state.uiState).toBe('composing')
    expect(result.current.state.agentId).toBe('agent-1')
    expect(result.current.state.baseBody).toBe('original body')
  })

  it('close() resets back to initial state', () => {
    const { result } = renderRefine(ws)
    act(() => {
      result.current.open('agent-1', 'b')
    })
    act(() => {
      result.current.close()
    })
    expect(result.current.state.uiState).toBe('closed')
    expect(result.current.state.agentId).toBeNull()
  })

  describe('start', () => {
    it('is a no-op when no agent is open', async () => {
      const { result } = renderRefine(ws)
      const fetchSpy = global.fetch as Mock
      fetchSpy.mockClear()
      await act(async () => {
        await result.current.start('hello')
      })
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(result.current.state.uiState).toBe('closed')
    })

    it('POSTs the refine endpoint and enters streaming with the user turn', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      expect(global.fetch).toHaveBeenCalledWith(
        `${API}/agent-1/refine`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ instruction: 'make it better', autoTest: false }),
        }),
      )
      expect(result.current.state.uiState).toBe('streaming')
      expect(result.current.state.phase).toBe('reading')
      expect(result.current.state.refineId).toBe('r1')
      expect(result.current.state.history).toHaveLength(1)
      expect(result.current.state.history[0]).toMatchObject({ role: 'user', content: 'make it better' })
    })

    it('surfaces server error body on non-ok response', async () => {
      const { result } = renderRefine(ws)
      act(() => {
        result.current.open('agent-1', 'b')
      })
      ;(global.fetch as Mock).mockResolvedValueOnce(jsonResponse({ error: 'nope' }, { ok: false, status: 400 }))
      await act(async () => {
        await result.current.start('x')
      })
      expect(result.current.state.uiState).toBe('error')
      expect(result.current.state.errorMessage).toBe('nope')
    })

    it('falls back to the i18n server-error string when the error body is unreadable', async () => {
      const { result } = renderRefine(ws)
      act(() => {
        result.current.open('agent-1', 'b')
      })
      ;(global.fetch as Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => { throw new Error('bad json') },
      })
      await act(async () => {
        await result.current.start('x')
      })
      expect(result.current.state.uiState).toBe('error')
      expect(result.current.state.errorMessage).toBe('Server error (500)')
    })

    it('reports connection failure when fetch rejects', async () => {
      const { result } = renderRefine(ws)
      act(() => {
        result.current.open('agent-1', 'b')
      })
      ;(global.fetch as Mock).mockRejectedValueOnce(new Error('boom'))
      await act(async () => {
        await result.current.start('x')
      })
      expect(result.current.state.uiState).toBe('error')
      expect(result.current.state.errorMessage).toBe('Connection failed: boom')
    })
  })

  describe('WebSocket events', () => {
    it('accumulates stream deltas for the active refine', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      act(() => {
        ws.emit({ type: 'agent_refine_stream', projectId: PROJECT, refineId: 'r1', delta: 'Hello ' })
        ws.emit({ type: 'agent_refine_stream', projectId: PROJECT, refineId: 'r1', delta: 'world' })
      })
      expect(result.current.state.streamingText).toBe('Hello world')
    })

    it('updates phase on agent_refine_phase', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      act(() => {
        ws.emit({ type: 'agent_refine_phase', projectId: PROJECT, refineId: 'r1', phase: 'drafting' })
      })
      expect(result.current.state.phase).toBe('drafting')
    })

    it('agent_refine_ready moves to reviewing, stores draft, strips tool markers in history', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      act(() => {
        ws.emit({
          type: 'agent_refine_ready',
          projectId: PROJECT,
          refineId: 'r1',
          draftBody: 'draft <!--tool:Read--> body',
        })
      })
      expect(result.current.state.uiState).toBe('reviewing')
      expect(result.current.state.phase).toBe('done')
      expect(result.current.state.draftBody).toBe('draft <!--tool:Read--> body')
      expect(result.current.state.streamingText).toBe('')
      const assistant = result.current.state.history.at(-1)
      expect(assistant).toMatchObject({ role: 'assistant', content: 'draft  body' })
    })

    it('agent_refine_test appends a system test_result turn', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      act(() => {
        ws.emit({
          type: 'agent_refine_test',
          projectId: PROJECT,
          refineId: 'r1',
          result: { output: 'all green', tokens: 12, durationMs: 300 },
        })
      })
      expect(result.current.state.testResult).toEqual({ output: 'all green', tokens: 12, durationMs: 300 })
      expect(result.current.state.history.at(-1)).toMatchObject({
        role: 'system',
        kind: 'test_result',
        content: 'all green',
      })
    })

    it('preserves unavailable token usage instead of fabricating zero', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      act(() => {
        ws.emit({
          type: 'agent_refine_test',
          projectId: PROJECT,
          refineId: 'r1',
          result: { output: 'done', tokens: null, durationMs: 300 },
        })
      })
      expect(result.current.state.testResult).toEqual({
        output: 'done',
        tokens: null,
        durationMs: 300,
      })
    })

    it('handles applied, cancelled and error events', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      act(() => {
        ws.emit({ type: 'agent_refine_applied', projectId: PROJECT, refineId: 'r1', version: 3 })
      })
      expect(result.current.state.uiState).toBe('applied')
      expect(result.current.state.appliedVersion).toBe(3)

      act(() => {
        ws.emit({ type: 'agent_refine_cancelled', projectId: PROJECT, refineId: 'r1' })
      })
      expect(result.current.state.uiState).toBe('cancelled')

      act(() => {
        ws.emit({ type: 'agent_refine_error', projectId: PROJECT, refineId: 'r1', error: 'exploded' })
      })
      expect(result.current.state.uiState).toBe('error')
      expect(result.current.state.errorMessage).toBe('exploded')
    })

    it('ignores messages for other projects, other refine ids, and malformed types', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      act(() => {
        ws.emit({ type: 'agent_refine_stream', projectId: 'other-project', refineId: 'r1', delta: 'X' })
        ws.emit({ type: 'agent_refine_stream', projectId: PROJECT, refineId: 'r-OTHER', delta: 'Y' })
        ws.emit({ type: 42, projectId: PROJECT, refineId: 'r1' })
      })
      expect(result.current.state.streamingText).toBe('')
    })
  })

  describe('sendTurn', () => {
    it('is a no-op without an active session', async () => {
      const { result } = renderRefine(ws)
      const fetchSpy = global.fetch as Mock
      fetchSpy.mockClear()
      await act(async () => {
        await result.current.sendTurn('again')
      })
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('POSTs the turn endpoint and appends the user turn', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      ;(global.fetch as Mock).mockResolvedValueOnce(jsonResponse({}))
      await act(async () => {
        await result.current.sendTurn('tighten the tone')
      })
      expect(global.fetch).toHaveBeenLastCalledWith(
        `${API}/agent-1/refine/r1/turn`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ instruction: 'tighten the tone' }),
        }),
      )
      expect(result.current.state.uiState).toBe('streaming')
      expect(result.current.state.history).toHaveLength(2)
      expect(result.current.state.history.at(-1)).toMatchObject({ role: 'user', content: 'tighten the tone' })
    })

    it('surfaces server error on non-ok turn response', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      ;(global.fetch as Mock).mockResolvedValueOnce(jsonResponse({ error: 'turn rejected' }, { ok: false, status: 422 }))
      await act(async () => {
        await result.current.sendTurn('x')
      })
      expect(result.current.state.uiState).toBe('error')
      expect(result.current.state.errorMessage).toBe('turn rejected')
    })

    it('reports connection failure when the turn fetch rejects', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      ;(global.fetch as Mock).mockRejectedValueOnce(new Error('net down'))
      await act(async () => {
        await result.current.sendTurn('x')
      })
      expect(result.current.state.uiState).toBe('error')
      expect(result.current.state.errorMessage).toBe('Connection failed: net down')
    })
  })

  describe('cancel', () => {
    it('is a no-op without an active session', async () => {
      const { result } = renderRefine(ws)
      const fetchSpy = global.fetch as Mock
      fetchSpy.mockClear()
      await act(async () => {
        await result.current.cancel()
      })
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('DELETEs the refine session', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      ;(global.fetch as Mock).mockResolvedValueOnce(jsonResponse({}))
      await act(async () => {
        await result.current.cancel()
      })
      expect(global.fetch).toHaveBeenLastCalledWith(
        `${API}/agent-1/refine/r1`,
        { method: 'DELETE' },
      )
    })

    it('swallows network errors (best-effort)', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      ;(global.fetch as Mock).mockRejectedValueOnce(new Error('offline'))
      await act(async () => {
        await result.current.cancel()
      })
      // No error surfaced — state untouched.
      expect(result.current.state.uiState).toBe('streaming')
      expect(result.current.state.errorMessage).toBeNull()
    })
  })

  describe('apply', () => {
    it('is a no-op without an active session', async () => {
      const { result } = renderRefine(ws)
      const fetchSpy = global.fetch as Mock
      fetchSpy.mockClear()
      await act(async () => {
        await result.current.apply()
      })
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('POSTs apply and stores the new version on success', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      ;(global.fetch as Mock).mockResolvedValueOnce(jsonResponse({ version: 7 }))
      await act(async () => {
        await result.current.apply(true)
      })
      expect(global.fetch).toHaveBeenLastCalledWith(
        `${API}/agent-1/refine/r1/apply`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ force: true }),
        }),
      )
      expect(result.current.state.uiState).toBe('applied')
      expect(result.current.state.appliedVersion).toBe(7)
    })

    it('sets applyConflict on a 409 with a known reason', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      ;(global.fetch as Mock).mockResolvedValueOnce(jsonResponse({ reason: 'disk_changed' }, { ok: false, status: 409 }))
      await act(async () => {
        await result.current.apply()
      })
      expect(result.current.state.applyConflict).toBe('disk_changed')
      expect(result.current.state.uiState).toBe('streaming') // unchanged, no error
    })

    it('falls through to error on a 409 with an unknown reason', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      ;(global.fetch as Mock).mockResolvedValueOnce(jsonResponse({ reason: 'weird' }, { ok: false, status: 409 }))
      await act(async () => {
        await result.current.apply()
      })
      expect(result.current.state.applyConflict).toBeNull()
      expect(result.current.state.uiState).toBe('error')
      expect(result.current.state.errorMessage).toBe('Apply failed (409)')
    })

    it('surfaces the i18n apply-failed string on a non-ok response', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      ;(global.fetch as Mock).mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500 }))
      await act(async () => {
        await result.current.apply()
      })
      expect(result.current.state.uiState).toBe('error')
      expect(result.current.state.errorMessage).toBe('Apply failed (500)')
    })

    it('reports connection failure when apply fetch rejects', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      ;(global.fetch as Mock).mockRejectedValueOnce(new Error('refused'))
      await act(async () => {
        await result.current.apply()
      })
      expect(result.current.state.uiState).toBe('error')
      expect(result.current.state.errorMessage).toBe('Connection failed: refused')
    })
  })

  describe('toggleAutoTest', () => {
    it('updates local state without a fetch when no session is active', async () => {
      const { result } = renderRefine(ws)
      const fetchSpy = global.fetch as Mock
      fetchSpy.mockClear()
      await act(async () => {
        await result.current.toggleAutoTest(true)
      })
      expect(result.current.state.autoTest).toBe(true)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('PATCHes the session when one is active', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      ;(global.fetch as Mock).mockResolvedValueOnce(jsonResponse({}))
      await act(async () => {
        await result.current.toggleAutoTest(true)
      })
      expect(result.current.state.autoTest).toBe(true)
      expect(global.fetch).toHaveBeenLastCalledWith(
        `${API}/agent-1/refine/r1`,
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ autoTest: true }),
        }),
      )
    })

    it('keeps the local toggle even when the PATCH fails', async () => {
      const { result } = renderRefine(ws)
      await startSession(result)
      ;(global.fetch as Mock).mockRejectedValueOnce(new Error('offline'))
      await act(async () => {
        await result.current.toggleAutoTest(true)
      })
      expect(result.current.state.autoTest).toBe(true)
      expect(result.current.state.errorMessage).toBeNull()
    })

    it('start() sends the current autoTest flag in the body', async () => {
      const { result } = renderRefine(ws)
      act(() => {
        result.current.open('agent-1', 'b')
      })
      await act(async () => {
        await result.current.toggleAutoTest(true)
      })
      ;(global.fetch as Mock).mockResolvedValueOnce(jsonResponse({ refineId: 'r9' }))
      await act(async () => {
        await result.current.start('go')
      })
      expect(global.fetch).toHaveBeenLastCalledWith(
        `${API}/agent-1/refine`,
        expect.objectContaining({
          body: JSON.stringify({ instruction: 'go', autoTest: true }),
        }),
      )
    })
  })

  describe('rehydrate', () => {
    it('loads agent body and session, restoring reviewing state', async () => {
      const { result } = renderRefine(ws)
      const session = {
        id: 'r5',
        agentId: 'agent-2',
        status: 'ready',
        phase: 'done',
        autoTest: true,
        draftBody: 'restored draft',
        history: [{ role: 'user', content: 'earlier', timestamp: 1 }],
        baseVersion: 1,
        createdAt: 1,
        updatedAt: 2,
      }
      ;(global.fetch as Mock)
        .mockResolvedValueOnce(jsonResponse({ body: 'disk body' }))
        .mockResolvedValueOnce(jsonResponse(session))
      await act(async () => {
        await result.current.rehydrate('r5', 'agent-2')
      })
      expect(global.fetch).toHaveBeenNthCalledWith(1, `${API}/agent-2`)
      expect(global.fetch).toHaveBeenNthCalledWith(2, `${API}/agent-2/refine/r5`)
      expect(result.current.state.refineId).toBe('r5')
      expect(result.current.state.agentId).toBe('agent-2')
      expect(result.current.state.baseBody).toBe('disk body')
      expect(result.current.state.draftBody).toBe('restored draft')
      expect(result.current.state.history).toEqual(session.history)
      expect(result.current.state.autoTest).toBe(true)
      expect(result.current.state.uiState).toBe('reviewing')
      expect(result.current.state.phase).toBe('done')
      // WS messages for the rehydrated session are now accepted.
      act(() => {
        ws.emit({ type: 'agent_refine_applied', projectId: PROJECT, refineId: 'r5', version: 2 })
      })
      expect(result.current.state.uiState).toBe('applied')
      expect(result.current.state.appliedVersion).toBe(2)
    })

    it('maps streaming server status to the streaming ui state', async () => {
      const { result } = renderRefine(ws)
      ;(global.fetch as Mock)
        .mockResolvedValueOnce(jsonResponse({ body: 'b' }))
        .mockResolvedValueOnce(jsonResponse({
          id: 'r6', agentId: 'agent-3', status: 'streaming', phase: 'drafting',
          autoTest: false, draftBody: null, history: [], baseVersion: 1, createdAt: 1, updatedAt: 1,
        }))
      await act(async () => {
        await result.current.rehydrate('r6', 'agent-3')
      })
      expect(result.current.state.uiState).toBe('streaming')
      expect(result.current.state.phase).toBe('drafting')
    })

    it('errors when the agent body fetch fails', async () => {
      const { result } = renderRefine(ws)
      ;(global.fetch as Mock).mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 404 }))
      await act(async () => {
        await result.current.rehydrate('r5', 'agent-2')
      })
      expect(result.current.state.uiState).toBe('error')
      expect(result.current.state.errorMessage).toBe('Failed to restore session: Failed to load agent (404)')
    })

    it('errors when the session fetch fails', async () => {
      const { result } = renderRefine(ws)
      ;(global.fetch as Mock)
        .mockResolvedValueOnce(jsonResponse({ body: 'b' }))
        .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 410 }))
      await act(async () => {
        await result.current.rehydrate('r5', 'agent-2')
      })
      expect(result.current.state.uiState).toBe('error')
      expect(result.current.state.errorMessage).toBe('Failed to restore session: Failed to load session (410)')
    })
  })

  it('resets state when the project switches', async () => {
    const { result, rerender } = renderRefine(ws)
    await startSession(result)
    expect(result.current.state.uiState).toBe('streaming')
    rerender({ pid: 'another-project' })
    expect(result.current.state.uiState).toBe('closed')
    expect(result.current.state.refineId).toBeNull()
    expect(result.current.state.agentId).toBeNull()
  })

  it('unregisters the WS handler on unmount', async () => {
    const unregister = vi.fn()
    const handlers = new Map<string, (msg: unknown) => void>()
    const trackedWs: FakeWs = {
      registerHandler: (id, fn) => handlers.set(id, fn),
      unregisterHandler: unregister,
      connectionStatus: 'connected',
      emit: (msg) => { for (const h of handlers.values()) h(msg) },
    }
    const { unmount } = renderRefine(trackedWs)
    unmount()
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(unregister).toHaveBeenCalledWith(expect.stringMatching(/^agent-refine-/))
  })
})
