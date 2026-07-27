import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isNativeBrowserAvailable,
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
    expect(normalizeAddress('localhost:5173')).toBe('https://localhost:5173/')
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
    await nativeBrowser.open('https://example.com/', bounds)
    await nativeBrowser.navigate('https://example.com/next')
    await nativeBrowser.setBounds(bounds)
    await nativeBrowser.zoom(1.5)
    await nativeBrowser.back()
    await nativeBrowser.forward()
    await nativeBrowser.reload()
    await nativeBrowser.show()
    await nativeBrowser.hide()
    await nativeBrowser.close()
    await nativeBrowser.devtools()

    expect(invoke.mock.calls).toEqual([
      ['browser_open', { url: 'https://example.com/', bounds }],
      ['browser_navigate', { url: 'https://example.com/next' }],
      ['browser_set_bounds', { bounds }],
      ['browser_zoom', { factor: 1.5 }],
      ['browser_back', undefined],
      ['browser_forward', undefined],
      ['browser_reload', undefined],
      ['browser_show', undefined],
      ['browser_hide', undefined],
      ['browser_close', undefined],
      ['browser_devtools', undefined],
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

    const dispose = await nativeBrowser.onEvent((e) => received.push(e))
    captured?.({ payload: { kind: 'nav', url: 'https://example.com/' } })
    captured?.({ payload: { kind: 'load-finished', url: 'https://example.com/' } })
    dispose()

    expect(received).toEqual([
      { kind: 'nav', url: 'https://example.com/' },
      { kind: 'load-finished', url: 'https://example.com/' },
    ])
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
