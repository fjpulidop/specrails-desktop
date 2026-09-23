import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useProviderDetection } from '../useProviderDetection'
import { SharedWebSocketContext } from '../../../../hooks/useSharedWebSocket'
import { modelsForProvider, resetDynamicModelCatalogs } from '../../../loops/lib/loop-run-models'

const localInfo = { id: 'lan-box', displayName: 'lan-box', installed: true, executable: true, authState: 'authenticated' as const, usable: true, kind: 'local' as const, models: ['qwen', 'llama'] }

beforeEach(() => resetDynamicModelCatalogs())

describe('useProviderDetection', () => {
  it('loads the snapshot and publishes local engine models to the dynamic catalog', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ detected: ['claude', 'lan-box'], providers: { 'lan-box': localInfo } }) } as Response)
    const { result } = renderHook(() => useProviderDetection())
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.detected).toEqual(['claude', 'lan-box'])
    expect(modelsForProvider('lan-box').map((m) => m.value)).toEqual(['qwen', 'llama'])
  })

  it('tolerates a failed fetch and converges on the detected_changed broadcast', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('offline'))
    const handlers = new Map<string, (raw: unknown) => void>()
    const ws = { registerHandler: (key: string, fn: (raw: unknown) => void) => handlers.set(key, fn), unregisterHandler: (key: string) => handlers.delete(key) }
    const wrapper = ({ children }: { children: ReactNode }) => <SharedWebSocketContext.Provider value={ws as never}>{children}</SharedWebSocketContext.Provider>
    const { result, unmount } = renderHook(() => useProviderDetection(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.detected).toEqual([])
    act(() => handlers.get('provider-detection')?.({ type: 'other' }))
    act(() => handlers.get('provider-detection')?.({ type: 'providers.detected_changed', detected: ['lan-box'], providers: { 'lan-box': { ...localInfo, models: ['only'] } } }))
    expect(result.current.detected).toEqual(['lan-box'])
    expect(modelsForProvider('lan-box').map((m) => m.value)).toEqual(['only'])
    unmount()
    expect(handlers.size).toBe(0)
  })
})
