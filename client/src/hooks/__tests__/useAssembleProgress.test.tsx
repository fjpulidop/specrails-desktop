import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { SharedWebSocketContext } from '../useSharedWebSocket'
import { useAssembleProgress } from '../useAssembleProgress'

let handler: ((msg: unknown) => void) | null = null
const fakeWs = {
  registerHandler: vi.fn((_id: string, fn: (msg: unknown) => void) => { handler = fn }),
  unregisterHandler: vi.fn(() => { handler = null }),
  connectionStatus: 'connected' as const,
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SharedWebSocketContext.Provider value={fakeWs}>
      {children}
    </SharedWebSocketContext.Provider>
  )
}

function emit(projectId: string, provider: string, status: string) {
  act(() => {
    handler?.({ type: 'project.assemble_progress', projectId, provider, status })
  })
}

beforeEach(() => {
  handler = null
  vi.clearAllMocks()
})

describe('useAssembleProgress', () => {
  it('unknown project reads as ready', () => {
    const { result } = renderHook(() => useAssembleProgress(), { wrapper })
    expect(result.current.statusFor('p1')).toBe('ready')
  })

  it('aggregates running → done per provider', () => {
    const { result } = renderHook(() => useAssembleProgress(), { wrapper })
    emit('p1', 'claude', 'running')
    expect(result.current.statusFor('p1')).toBe('assembling')
    emit('p1', 'codex', 'running')
    emit('p1', 'claude', 'done')
    expect(result.current.statusFor('p1')).toBe('assembling')
    emit('p1', 'codex', 'done')
    expect(result.current.statusFor('p1')).toBe('ready')
  })

  it('a failed provider reads failed once nothing is running; a retry clears it', () => {
    const { result } = renderHook(() => useAssembleProgress(), { wrapper })
    emit('p1', 'codex', 'running')
    emit('p1', 'codex', 'failed')
    expect(result.current.statusFor('p1')).toBe('failed')
    // Retry re-runs the provider: running clears its failed flag.
    emit('p1', 'codex', 'running')
    expect(result.current.statusFor('p1')).toBe('assembling')
    emit('p1', 'codex', 'done')
    expect(result.current.statusFor('p1')).toBe('ready')
  })

  it('projects are independent and malformed events are ignored', () => {
    const { result } = renderHook(() => useAssembleProgress(), { wrapper })
    emit('p1', 'claude', 'running')
    expect(result.current.statusFor('p2')).toBe('ready')
    act(() => {
      handler?.({ type: 'project.assemble_progress' }) // no projectId/provider
      handler?.({ type: 'other' })
    })
    expect(result.current.statusFor('p1')).toBe('assembling')
  })

  it('retry POSTs the assemble-retry route', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)
    try {
      const { result } = renderHook(() => useAssembleProgress(), { wrapper })
      await act(async () => { await result.current.retry('p9') })
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects/p9/assemble-retry'),
        { method: 'POST' },
      )
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
