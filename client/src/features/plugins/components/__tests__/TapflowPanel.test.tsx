import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../../../test-utils'
import { TapflowPanel, tapflowIsOn, useTapflow, type TapflowStatus } from '../TapflowPanel'

const handlers = new Map<string, (msg: unknown) => void>()
vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (id: string, fn: (msg: unknown) => void) => handlers.set(id, fn),
    unregisterHandler: (id: string) => handlers.delete(id),
  }),
}))
// The installer terminal needs a real PTY socket; its wiring is covered server-side.
vi.mock('@xterm/xterm', () => ({ Terminal: class { cols = 80; rows = 24; loadAddon() {} open() {} write() {} focus() {} dispose() {} onData() { return { dispose() {} } } } }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const status = (over: Partial<TapflowStatus> = {}): TapflowStatus => ({
  phase: 'not-installed', managed: false, version: null, port: 4310, issue: null, installerSessionId: null,
  requirements: { ios: 'ios needs', android: 'android needs' }, ...over,
})

function Harness() {
  const tapflow = useTapflow()
  return <TapflowPanel tapflow={tapflow} />
}

let current: TapflowStatus
const calls: string[] = []

beforeEach(() => {
  current = status()
  calls.length = 0
  handlers.clear()
  vi.stubGlobal('WebSocket', class { static OPEN = 1; readyState = 0; binaryType = ''; onmessage = null; onopen = null; send() {} close() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url.replace(/^.*\/api/, '/api')}`)
    if (init?.method === 'POST' && url.endsWith('/install')) {
      current = status({ phase: 'installing', installerSessionId: 'pty-1' })
      return new Response(JSON.stringify({ ok: true, status: current, sessionId: 'pty-1' }))
    }
    if (init?.method === 'POST' && url.endsWith('/activate')) {
      current = { ...current, phase: 'running' }
      return new Response(JSON.stringify({ ok: true, status: current }))
    }
    if (init?.method === 'POST' && url.endsWith('/deactivate')) {
      return new Response(JSON.stringify({ ok: false, error: 'boom', status: current }), { status: 409 })
    }
    return new Response(JSON.stringify({ status: current }))
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('TapflowPanel', () => {
  it('offers install with the per-platform requirements when Tapflow is not installed', async () => {
    render(<Harness />)
    expect(await screen.findByTestId('tapflow-phase')).toHaveTextContent('Not installed')
    expect(screen.getByText(/iOS Simulator: macOS on Apple Silicon/)).toBeInTheDocument()
    expect(screen.getByText(/Android emulators: Apple Silicon too/)).toBeInTheDocument()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('opens the installer terminal on Install', async () => {
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: /^Install$/ }))
    await waitFor(() => expect(calls).toContain('POST /api/global-plugins/tapflow/install'))
    expect(await screen.findByTestId('tapflow-installer-terminal')).toBeInTheDocument()
    expect(screen.getByText(/Tapflow's setup runs here/)).toBeInTheDocument()
  })

  it('switches a managed install on, and shows a refusal from the server', async () => {
    current = status({ phase: 'installed', managed: true, version: '0.33.0' })
    render(<Harness />)
    const toggle = await screen.findByRole('switch')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'))
    fireEvent.click(screen.getByRole('switch'))
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
  })

  it('follows the live status pushed over the WebSocket', async () => {
    current = status({ phase: 'installed', managed: true })
    render(<Harness />)
    await screen.findByRole('switch')
    handlers.get('plugins-page-tapflow')!({ type: 'plugin.tapflow_status', status: status({ phase: 'installed', managed: true, issue: { code: 'service-exited', detail: 'Tapflow exited with code 1.' } }) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Tapflow exited with code 1.')
  })

  it('explains an unsupported computer without install or switch', async () => {
    current = status({ phase: 'unsupported', issue: { code: 'unsupported-platform', detail: 'Tapflow needs an Apple Silicon Mac; Intel Macs are not supported.' } })
    render(<Harness />)
    expect(await screen.findByText(/Intel Macs are not supported/)).toBeInTheDocument()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Install$/ })).toBeNull()
  })

  it('never lets Specrails switch off a Tapflow it did not start', async () => {
    current = status({ phase: 'running-external' })
    render(<Harness />)
    expect(await screen.findByText(/Specrails uses it and never stops it/)).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeDisabled()
    expect(tapflowIsOn('running-external')).toBe(true)
    expect(tapflowIsOn('installed')).toBe(false)
  })
})
