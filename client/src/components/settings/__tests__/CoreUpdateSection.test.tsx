import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) } }))

// Capture the registered WS handler so tests can push core_update.progress events.
let wsHandler: ((msg: unknown) => void) | null = null
vi.mock('../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (msg: unknown) => void) => { wsHandler = fn },
    unregisterHandler: () => { wsHandler = null },
    connectionStatus: 'connected',
  }),
}))

import { CoreUpdateSection } from '../CoreUpdateSection'

type Resp = { ok: boolean; status?: number; body: unknown }
function routeFetch(map: Record<string, Resp | Resp[]>) {
  const counters: Record<string, number> = {}
  global.fetch = vi.fn().mockImplementation((url: string) => {
    const key = Object.keys(map).find((k) => String(url).includes(k))
    if (!key) return Promise.reject(new Error(`unmapped ${url}`))
    counters[key] ??= 0
    const entry = map[key]
    const r = Array.isArray(entry) ? entry[counters[key]++] ?? entry[entry.length - 1] : entry
    return Promise.resolve({ ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.body })
  }) as never
}

const STATUS = (over: Record<string, unknown> = {}) => ({
  available: true,
  currentVersion: '4.8.0',
  bundledVersion: '4.8.0',
  latestVersion: null,
  updateAvailable: false,
  updating: false,
  lastCheckedAt: null,
  ...over,
})

beforeEach(() => {
  toastSuccess.mockClear()
  toastError.mockClear()
  wsHandler = null
})

describe('CoreUpdateSection', () => {
  it('distinguishes the active framework, selected runtime and older bundled version', async () => {
    routeFetch({ '/core-update/status': { ok: true, body: STATUS({ currentVersion: '5.0.0', runtimeVersion: '5.0.1', runtimeSource: 'global', bundledVersion: '4.12.0' }) } })
    render(<CoreUpdateSection />)
    expect(await screen.findByText('5.0.0')).toBeTruthy()
    expect(screen.getByText(/Runtime: 5.0.1/)).toBeTruthy()
    expect(screen.getByText(/External CLI/)).toBeTruthy()
    expect(screen.getByText('Included in Desktop: 4.12.0')).toBeTruthy()
  })

  it('does not let an old status response overwrite a completed update', async () => {
    let finishOld!: (response: unknown) => void
    global.fetch = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockResolvedValue({ ok: true, json: async () => STATUS({ currentVersion: '5.0.0' }) }) as never
    render(<CoreUpdateSection />)
    await waitFor(() => expect(wsHandler).toBeTypeOf('function'))
    act(() => wsHandler?.({ type: 'framework.updated', version: '5.0.0' }))
    await screen.findByText('5.0.0')
    await act(async () => finishOld({ ok: true, json: async () => STATUS() }))
    expect(screen.queryByText('4.8.0')).toBeNull()
    expect(screen.getByText('5.0.0')).toBeTruthy()
  })

  it('offers an offline repair for a persisted partial project update', async () => {
    routeFetch({
      '/core-update/status': { ok: true, body: STATUS({ currentVersion: '5.0.0', pendingVersion: '5.0.0', migrationError: 'Project fixture requires repair', updateAvailable: true, latestVersion: null }) },
      '/core-update/update': { ok: true, status: 202, body: { accepted: true } },
    })
    render(<CoreUpdateSection />)
    fireEvent.click(await screen.findByText('Finish updating 5.0.0'))
    expect(screen.getByRole('alert').textContent).toContain('requires repair')
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/core-update/update', expect.objectContaining({ method: 'POST' })))
  })

  it('shows a retry action when initial status loading fails', async () => {
    routeFetch({ '/core-update/status': [
      { ok: false, status: 500, body: {} },
      { ok: true, body: STATUS() },
    ] })
    render(<CoreUpdateSection />)
    fireEvent.click(await screen.findByText('Could not refresh Core status. Retry'))
    expect(await screen.findByText('4.8.0')).toBeTruthy()
  })
  it('renders unavailable note when no bundled core', async () => {
    routeFetch({ '/core-update/status': { ok: true, body: STATUS({ available: false, currentVersion: null, bundledVersion: null }) } })
    render(<CoreUpdateSection />)
    await screen.findByText('Specrails Core')
    expect(screen.getByText("Core updates aren't available in this build.")).toBeTruthy()
    expect(screen.queryByText('Check for updates')).toBeNull()
  })

  it('shows installed version + Check button when up to date', async () => {
    routeFetch({ '/core-update/status': { ok: true, body: STATUS() } })
    render(<CoreUpdateSection />)
    await screen.findByText('Specrails Core')
    expect(screen.getByText('4.8.0')).toBeTruthy()
    expect(screen.getByText('Check for updates')).toBeTruthy()
  })

  it('Check reports up-to-date with a success toast', async () => {
    routeFetch({
      '/core-update/status': { ok: true, body: STATUS() },
      '/core-update/check': { ok: true, body: STATUS({ latestVersion: '4.8.0', lastCheckedAt: 1 }) },
    })
    render(<CoreUpdateSection />)
    const btn = await screen.findByText('Check for updates')
    fireEvent.click(btn)
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  it('surfaces an available update and applies it via WS done event', async () => {
    routeFetch({
      '/core-update/status': [
        { ok: true, body: STATUS() },
        // refetch after WS done reflects the new version
        { ok: true, body: STATUS({ currentVersion: '4.9.0', updateAvailable: false }) },
      ],
      '/core-update/check': { ok: true, body: STATUS({ latestVersion: '4.9.0', updateAvailable: true, lastCheckedAt: 1 }) },
      '/core-update/update': { ok: true, status: 202, body: { accepted: true } },
    })
    render(<CoreUpdateSection />)
    fireEvent.click(await screen.findByText('Check for updates'))
    const updateBtn = await screen.findByText('Update to 4.9.0')
    fireEvent.click(updateBtn)
    // Simulate the server streaming completion.
    await waitFor(() => expect(wsHandler).toBeTypeOf('function'))
    act(() => wsHandler?.({ type: 'core_update.progress', phase: 'done', version: '4.9.0' }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  it('shows an error toast when the check request fails', async () => {
    routeFetch({
      '/core-update/status': { ok: true, body: STATUS() },
      '/core-update/check': { ok: false, status: 502, body: {} },
    })
    render(<CoreUpdateSection />)
    fireEvent.click(await screen.findByText('Check for updates'))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })

  it('shows an error toast on a WS error event', async () => {
    routeFetch({ '/core-update/status': { ok: true, body: STATUS() } })
    render(<CoreUpdateSection />)
    await screen.findByText('Specrails Core')
    await waitFor(() => expect(wsHandler).toBeTypeOf('function'))
    act(() => wsHandler?.({ type: 'core_update.progress', phase: 'error', message: 'boom' }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })
})
