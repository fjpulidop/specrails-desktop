import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
// The live device-list refresh subscribes to the shared socket; stub it so the
// section renders without a SharedWebSocketProvider.
vi.mock('../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({ registerHandler: vi.fn(), unregisterHandler: vi.fn(), connectionStatus: 'connected' }),
}))

import { MobileAccessSection } from '../MobileAccessSection'

interface Handler { match: (u: string, m: string) => boolean; ok?: boolean; status?: number; body?: unknown }

function mockApi(handlers: Handler[]) {
  global.fetch = vi.fn(async (url: unknown, opts?: { method?: string }) => {
    const u = String(url)
    const m = (opts?.method ?? 'GET').toUpperCase()
    const h = handlers.find((x) => x.match(u, m))
    return {
      ok: h?.ok ?? true,
      status: h?.status ?? 200,
      json: async () => h?.body ?? {},
    } as Response
  }) as never
}

const OFF = { enabled: false, running: false, port: 4202, certFingerprint: null, desktopName: 'Mac' }
const ON = { enabled: true, running: true, port: 4202, certFingerprint: 'a'.repeat(64), desktopName: 'Mac' }

beforeEach(() => { vi.clearAllMocks() })

describe('MobileAccessSection', () => {
  it('renders the off state with a Turn on button', async () => {
    mockApi([
      { match: (u) => u.endsWith('/status'), body: OFF },
      { match: (u) => u.endsWith('/devices'), body: { devices: [] } },
    ])
    render(<MobileAccessSection />)
    await screen.findByText('Mobile companion')
    expect(screen.getByText('Mobile access off')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeInTheDocument()
  })

  it('enabling reveals the pair button + fingerprint', async () => {
    mockApi([
      { match: (u, m) => u.endsWith('/status') && m === 'GET', body: OFF },
      { match: (u) => u.endsWith('/devices'), body: { devices: [] } },
      { match: (u, m) => u.endsWith('/enable') && m === 'POST', body: ON },
    ])
    render(<MobileAccessSection />)
    const turnOn = await screen.findByRole('button', { name: 'Turn on' })
    fireEvent.click(turnOn)
    await screen.findByRole('button', { name: /Pair web companion/ })
    expect(screen.getByText(/aaaaaaaa…aaaaaaaa/)).toBeInTheDocument()
  })

  it('lists paired devices and calls DELETE on revoke', async () => {
    const devices = [{ id: 'd1', name: 'iPhone', platform: 'ios', createdAt: '', lastSeenAt: null, revoked: false }]
    mockApi([
      { match: (u) => u.endsWith('/status'), body: ON },
      { match: (u, m) => u.endsWith('/devices') && m === 'GET', body: { devices } },
      { match: (u, m) => u.includes('/devices/d1') && m === 'DELETE', body: { ok: true } },
    ])
    render(<MobileAccessSection />)
    await screen.findByText('iPhone')
    fireEvent.click(screen.getByRole('button', { name: 'Revoke iPhone' }))
    await waitFor(() => {
      const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      const del = calls.find((c) => String(c[0]).includes('/devices/d1') && (c[1] as { method?: string })?.method === 'DELETE')
      expect(del).toBeTruthy()
    })
  })

  it('reset identity rotates the cert after confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const ROT = { ...ON, certFingerprint: 'b'.repeat(64) }
    mockApi([
      { match: (u) => u.endsWith('/status'), body: ON },
      { match: (u) => u.endsWith('/devices'), body: { devices: [] } },
      { match: (u, m) => u.endsWith('/cert/rotate') && m === 'POST', body: ROT },
    ])
    render(<MobileAccessSection />)
    const reset = await screen.findByRole('button', { name: 'Reset' })
    fireEvent.click(reset)
    await waitFor(() => expect(screen.getByText(/bbbbbbbb…bbbbbbbb/)).toBeInTheDocument())
    confirmSpy.mockRestore()
  })
})
