import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import { useTrayLabels } from '../useTrayLabels'

describe('useTrayLabels', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    // Clean up the Tauri runtime flag between cases.
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('no-ops outside the Tauri runtime', () => {
    renderHook(() => useTrayLabels())
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('pushes localized Open / Exit labels when running under Tauri', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    renderHook(() => useTrayLabels())
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('set_tray_labels', {
      open: 'Open',
      exit: 'Exit',
    }))
  })

  it('swallows invoke failures (older host without the command)', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    invokeMock.mockRejectedValueOnce(new Error('command not found'))
    expect(() => renderHook(() => useTrayLabels())).not.toThrow()
    await waitFor(() => expect(invokeMock).toHaveBeenCalled())
  })
})
