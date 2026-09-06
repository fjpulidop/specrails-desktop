import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('WS_URL', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('returns __WS_URL__ value when defined (dev mode)', async () => {
    // In vitest config, __WS_URL__ is defined as 'ws://localhost:4200'
    // The module-level getWsUrl() runs at import time
    const { WS_URL } = await import('../ws-url')
    expect(WS_URL).toBe('ws://localhost:4200')
  })

  it('WS_URL is a non-empty string', async () => {
    const { WS_URL } = await import('../ws-url')
    expect(typeof WS_URL).toBe('string')
    expect(WS_URL.length).toBeGreaterThan(0)
  })

  it('WS_URL starts with ws: or wss:', async () => {
    const { WS_URL } = await import('../ws-url')
    expect(WS_URL).toMatch(/^wss?:/)
  })

  it('targets the sidecar on Windows before the native bridge becomes available', async () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', hostname: 'tauri.localhost', host: 'tauri.localhost', origin: 'http://tauri.localhost' } })
    const { getWsUrl } = await import('../ws-url')
    const { API_ORIGIN } = await import('../origin')
    expect(getWsUrl('')).toBe('ws://127.0.0.1:4200')
    expect(API_ORIGIN).toBe('http://127.0.0.1:4200')
  })

  it('keeps HTTPS browser deployments on their own secure origin', async () => {
    vi.stubGlobal('window', { location: { protocol: 'https:', hostname: 'dashboard.example', host: 'dashboard.example', origin: 'https://dashboard.example' } })
    const { getWsUrl } = await import('../ws-url')
    const { API_ORIGIN } = await import('../origin')
    expect(getWsUrl('')).toBe('wss://dashboard.example')
    expect(API_ORIGIN).toBe('')
  })

  it('honors the same explicit development port for native API and WS', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, location: { protocol: 'http:', hostname: 'localhost', host: 'localhost:4301' } })
    const { getApiOrigin } = await import('../origin')
    const { getWsUrl } = await import('../ws-url')
    expect(getApiOrigin('http://127.0.0.1:4300')).toBe('http://127.0.0.1:4300')
    expect(getWsUrl('ws://127.0.0.1:4300')).toBe('ws://127.0.0.1:4300')
    expect(getApiOrigin('')).toBe('http://127.0.0.1:4200')
  })

  it('keeps development browser API requests on the frontend proxy', async () => {
    const { getApiOrigin } = await import('../origin')
    expect(getApiOrigin('http://127.0.0.1:4300')).toBe('')
  })
})
