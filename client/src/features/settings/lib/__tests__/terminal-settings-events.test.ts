import { describe, it, expect, vi } from 'vitest'
import {
  TERMINAL_SETTINGS_UPDATED_EVENT,
  dispatchTerminalSettingsUpdated,
} from '../terminal-settings-events'

describe('terminal-settings-events', () => {
  it('exposes the canonical event name', () => {
    expect(TERMINAL_SETTINGS_UPDATED_EVENT).toBe('specrails:terminal-settings-updated')
  })

  it('dispatches a CustomEvent on window with the supplied detail', () => {
    const listener = vi.fn()
    window.addEventListener(TERMINAL_SETTINGS_UPDATED_EVENT, listener)
    dispatchTerminalSettingsUpdated({ mode: 'desktop', projectId: null })
    dispatchTerminalSettingsUpdated({ mode: 'project', projectId: 'p1' })
    window.removeEventListener(TERMINAL_SETTINGS_UPDATED_EVENT, listener)

    expect(listener).toHaveBeenCalledTimes(2)
    const first = listener.mock.calls[0][0] as CustomEvent
    expect(first.detail).toEqual({ mode: 'desktop', projectId: null })
    const second = listener.mock.calls[1][0] as CustomEvent
    expect(second.detail).toEqual({ mode: 'project', projectId: 'p1' })
  })

  it('no-ops when window is undefined', () => {
    const originalWindow = globalThis.window
    // @ts-expect-error simulate non-browser env
    delete globalThis.window
    expect(() =>
      dispatchTerminalSettingsUpdated({ mode: 'desktop', projectId: null }),
    ).not.toThrow()
    globalThis.window = originalWindow
  })
})
