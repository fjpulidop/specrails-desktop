import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isNativeBrowserAvailable,
  isNativeBrowserCaptureAvailable,
  nativeBrowser,
  normalizeAddress,
  rectToBounds,
  NATIVE_BROWSER_EVENT,
  _setNativeBrowserIpcForTests,
  type InvokeFn,
  type NativeBrowserEvent,
} from '../native-browser'

afterEach(() => {
  _setNativeBrowserIpcForTests(null)
})

describe('normalizeAddress', () => {
  it('upgrades a bare host to https', () => {
    expect(normalizeAddress('example.com')).toBe('https://example.com/')
    expect(normalizeAddress('example.com/path?q=1')).toBe('https://example.com/path?q=1')
  })

  it('keeps explicit http/https URLs', () => {
    expect(normalizeAddress('http://localhost:4201')).toBe('http://localhost:4201/')
    expect(normalizeAddress('https://example.com/x')).toBe('https://example.com/x')
  })

  it('allows loopback and private hosts (dev-server preview)', () => {
    expect(normalizeAddress('localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeAddress('127.0.0.1:3000/test')).toBe('http://127.0.0.1:3000/test')
    expect(normalizeAddress('[::1]:3000')).toBe('http://[::1]:3000/')
    expect(normalizeAddress('demo.localhost:3000')).toBe('http://demo.localhost:3000/')
    expect(normalizeAddress('http://192.168.1.20:3000')).toBe('http://192.168.1.20:3000/')
  })

  it('allows about:blank verbatim', () => {
    expect(normalizeAddress('about:blank')).toBe('about:blank')
    expect(normalizeAddress('  about:blank  ')).toBe('about:blank')
  })

  it('rejects disallowed schemes', () => {
    expect(normalizeAddress('file:///etc/passwd')).toBeNull()
    expect(normalizeAddress('javascript:alert(1)')).toBeNull()
    expect(normalizeAddress('data:text/html,x')).toBeNull()
    expect(normalizeAddress('chrome://settings')).toBeNull()
  })

  it('rejects empty and unparsable input', () => {
    expect(normalizeAddress('')).toBeNull()
    expect(normalizeAddress('   ')).toBeNull()
    expect(normalizeAddress('not a url')).toBeNull()
  })
})

describe('rectToBounds', () => {
  it('rounds and clamps to a valid pane rect', () => {
    expect(rectToBounds({ left: 10.4, top: 20.6, width: 300.5, height: 199.4 })).toEqual({
      x: 10,
      y: 21,
      width: 301,
      height: 199,
    })
  })

  it('never yields negative origin or a degenerate size', () => {
    expect(rectToBounds({ left: -5, top: -1, width: 0, height: 0.2 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    })
  })

  it('never sends non-finite layout values over IPC', () => {
    expect(rectToBounds({ left: NaN, top: Infinity, width: NaN, height: -Infinity })).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })
})

describe('isNativeBrowserAvailable', () => {
  it('is false when the feature flag is off', async () => {
    const invoke = vi.fn()
    _setNativeBrowserIpcForTests(invoke as unknown as InvokeFn)
    await expect(isNativeBrowserAvailable({ flag: false, tauri: true })).resolves.toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('is false outside Tauri', async () => {
    const invoke = vi.fn()
    _setNativeBrowserIpcForTests(invoke as unknown as InvokeFn)
    await expect(isNativeBrowserAvailable({ flag: true, tauri: false })).resolves.toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('probes browser_supported once and memoizes the result', async () => {
    const invoke = vi.fn().mockResolvedValue(true)
    _setNativeBrowserIpcForTests(invoke as unknown as InvokeFn)
    await expect(isNativeBrowserAvailable({ flag: true, tauri: true })).resolves.toBe(true)
    await expect(isNativeBrowserAvailable({ flag: true, tauri: true })).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('browser_supported')
  })

  it('resolves false when the probe rejects (fallback ladder)', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('no ipc'))
    _setNativeBrowserIpcForTests(invoke as unknown as InvokeFn)
    await expect(isNativeBrowserAvailable({ flag: true, tauri: true })).resolves.toBe(false)
  })

  it('recovers a transient startup failure without restarting the app', async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error('starting')).mockResolvedValue(true)
    _setNativeBrowserIpcForTests(invoke as unknown as InvokeFn)
    await expect(isNativeBrowserAvailable({ flag: true, tauri: true })).resolves.toBe(false)
    await expect(isNativeBrowserCaptureAvailable({ flag: true, tauri: true })).resolves.toBe(true)
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['browser_supported', 'browser_supported', 'browser_capture_supported'])
  })

  it('does not select native capture on a platform that only supports browsing', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    _setNativeBrowserIpcForTests(invoke as unknown as InvokeFn)
    await expect(isNativeBrowserCaptureAvailable({ flag: true, tauri: true })).resolves.toBe(false)
    await expect(isNativeBrowserCaptureAvailable({ flag: true, tauri: true })).resolves.toBe(false)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('resolves false when the platform reports unsupported', async () => {
    const invoke = vi.fn().mockResolvedValue(false)
    _setNativeBrowserIpcForTests(invoke as unknown as InvokeFn)
    await expect(isNativeBrowserAvailable({ flag: true, tauri: true })).resolves.toBe(false)
  })

  it('re-probes after the test seam resets the memo', async () => {
    const first = vi.fn().mockResolvedValue(false)
    _setNativeBrowserIpcForTests(first as unknown as InvokeFn)
    await expect(isNativeBrowserAvailable({ flag: true, tauri: true })).resolves.toBe(false)
    const second = vi.fn().mockResolvedValue(true)
    _setNativeBrowserIpcForTests(second as unknown as InvokeFn)
    await expect(isNativeBrowserAvailable({ flag: true, tauri: true })).resolves.toBe(true)
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('nativeBrowser command wrappers', () => {
  it('forwards commands and args to invoke', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    _setNativeBrowserIpcForTests(invoke as unknown as InvokeFn)

    const bounds = { x: 1, y: 2, width: 3, height: 4 }
    await nativeBrowser.open('pane-a', 'https://example.com/', bounds)
    await nativeBrowser.navigate('pane-a', 'https://example.com/next')
    await nativeBrowser.setBounds('pane-a', bounds)
    await nativeBrowser.zoom('pane-a', 1.5)
    await nativeBrowser.back('pane-a')
    await nativeBrowser.forward('pane-a')
    await nativeBrowser.reload('pane-a')
    await nativeBrowser.show('pane-a')
    await nativeBrowser.hide('pane-a')
    await nativeBrowser.close('pane-a')
    await nativeBrowser.devtools('pane-a')

    expect(invoke.mock.calls).toEqual([
      ['browser_open', { ownerId: 'pane-a', url: 'https://example.com/', bounds }],
      ['browser_navigate', { ownerId: 'pane-a', url: 'https://example.com/next' }],
      ['browser_set_bounds', { ownerId: 'pane-a', bounds }],
      ['browser_zoom', { ownerId: 'pane-a', factor: 1.5 }],
      ['browser_back', { ownerId: 'pane-a' }],
      ['browser_forward', { ownerId: 'pane-a' }],
      ['browser_reload', { ownerId: 'pane-a' }],
      ['browser_show', { ownerId: 'pane-a' }],
      ['browser_hide', { ownerId: 'pane-a' }],
      ['browser_close', { ownerId: 'pane-a' }],
      ['browser_devtools', { ownerId: 'pane-a' }],
    ])
  })

  it('subscribes to pane events through the injected listener', async () => {
    const received: NativeBrowserEvent[] = []
    const unlisten = vi.fn()
    let captured: ((e: { payload: NativeBrowserEvent }) => void) | null = null
    _setNativeBrowserIpcForTests(
      vi.fn() as unknown as InvokeFn,
      async (event, cb) => {
        expect(event).toBe(NATIVE_BROWSER_EVENT)
        captured = cb
        return unlisten
      },
    )

    const dispose = await nativeBrowser.onEvent('pane-a', (e) => received.push(e))
    captured?.({ payload: { ownerId: 'pane-a', kind: 'nav', url: 'https://example.com/' } })
    captured?.({ payload: { ownerId: 'pane-a', kind: 'load-finished', url: 'https://example.com/' } })
    captured?.({ payload: { ownerId: 'obsolete-pane', kind: 'nav', url: 'https://unrelated.example/' } })
    dispose()

    expect(received).toEqual([
      { ownerId: 'pane-a', kind: 'nav', url: 'https://example.com/' },
      { ownerId: 'pane-a', kind: 'load-finished', url: 'https://example.com/' },
    ])
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('serializes close and reopen behind an outstanding native open', async () => {
    let resolveOpen!: () => void
    const invoke = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { resolveOpen = resolve })).mockResolvedValue(undefined)
    _setNativeBrowserIpcForTests(invoke as unknown as InvokeFn)
    const bounds = { x: 0, y: 0, width: 500, height: 400 }
    const first = nativeBrowser.open('pane-a', 'about:blank', bounds)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    const close = nativeBrowser.close('pane-a')
    const next = nativeBrowser.open('pane-b', 'http://localhost:3000', bounds)
    expect(invoke).toHaveBeenCalledTimes(1)
    resolveOpen()
    await Promise.all([first, close, next])
    expect(invoke.mock.calls.map(call => [call[0], call[1].ownerId])).toEqual([
      ['browser_open', 'pane-a'], ['browser_close', 'pane-a'], ['browser_open', 'pane-b'],
    ])
  })

  it('passes ownership to selection and native capture operations', async () => {
    const invoke = vi.fn().mockResolvedValue(null)
    _setNativeBrowserIpcForTests(invoke as unknown as InvokeFn)
    await nativeBrowser.setSelectMode('pane-a', true)
    await nativeBrowser.selection('pane-a')
    await nativeBrowser.capture('pane-a', true)
    expect(invoke.mock.calls).toEqual([
      ['browser_set_select_mode', { ownerId: 'pane-a', enabled: true }],
      ['browser_selection', { ownerId: 'pane-a' }],
      ['browser_capture', { ownerId: 'pane-a', selectionOnly: true }],
    ])
  })
})
