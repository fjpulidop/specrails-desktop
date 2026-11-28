import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../../../test-utils'
import { AgentMobileTestOfferCard, parseMobileTestOfferRow } from '../AgentMobileTestOfferCard'

const row = (over: Record<string, unknown> = {}) => JSON.stringify({ kind: 'mobile-test-offer', projectId: 'p1', deliveryId: 'd1', platforms: ['ios', 'android'], recommended: 'ios', state: 'offered', at: 'x', ...over })
const posted: Array<{ url: string; body: unknown }> = []

beforeEach(() => {
  posted.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    posted.push({ url: url.replace(/^.*\/api/, '/api'), body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(JSON.stringify({ runId: 'r1' }), { status: 202 })
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('mobile test offer card', () => {
  it('parses only well-formed offer rows', () => {
    expect(parseMobileTestOfferRow(row())).toMatchObject({ deliveryId: 'd1', platforms: ['ios', 'android'], recommended: 'ios', state: 'offered', devices: [] })
    expect(parseMobileTestOfferRow(row({ state: 'bogus' }))).toBeNull()
    expect(parseMobileTestOfferRow('{"kind":"pr-ci-offer"}')).toBeNull()
    expect(parseMobileTestOfferRow('plain text')).toBeNull()
  })

  it('asks the platform of a multiplatform project, recommending one, and starts the chosen one', async () => {
    render(<AgentMobileTestOfferCard row={parseMobileTestOfferRow(row())!} />)
    expect(screen.getByTestId('agent-mobile-test-start-ios')).toHaveClass('bg-accent-primary')
    expect(screen.getByTestId('agent-mobile-test-start-both')).not.toHaveClass('bg-accent-primary')
    fireEvent.click(screen.getByTestId('agent-mobile-test-start-both'))
    await waitFor(() => expect(posted).toEqual([{ url: '/api/projects/p1/mobile-test/start', body: { deliveryId: 'd1', platforms: ['ios', 'android'] } }]))
    expect(await screen.findByText('Building and installing on the device…')).toBeInTheDocument()
  })

  it('offers one start for a single-platform project', () => {
    render(<AgentMobileTestOfferCard row={parseMobileTestOfferRow(row({ platforms: ['android'], recommended: 'android' }))!} />)
    expect(screen.getByTestId('agent-mobile-test-start-android')).toHaveTextContent('Test on the device')
    expect(screen.queryByTestId('agent-mobile-test-start-both')).toBeNull()
  })

  it('shows where the app runs, and the reason with one retry when it failed', () => {
    const { unmount } = render(<AgentMobileTestOfferCard row={parseMobileTestOfferRow(row({ state: 'launched', runId: 'r1', devices: [{ platform: 'ios', name: 'iPhone 17' }] }))!} />)
    expect(screen.getByText('Running iOS on iPhone 17')).toBeInTheDocument()
    unmount()
    render(<AgentMobileTestOfferCard row={parseMobileTestOfferRow(row({ state: 'failed', runId: 'r1', reason: 'The build failed: xcodebuild exited with 65' }))!} />)
    expect(screen.getByText('The build failed: xcodebuild exited with 65')).toBeInTheDocument()
    expect(screen.getAllByText('Try again')).toHaveLength(1)
  })
})

const opened: unknown[] = []
vi.mock('../../lib/device-windows', () => ({ openDeviceWindow: async (target: unknown) => { opened.push(target) } }))

describe('mobile test offer card: device window', () => {
  it('opens the device the app runs on, in its own window', async () => {
    render(<AgentMobileTestOfferCard row={parseMobileTestOfferRow(row({ state: 'launched', runId: 'r1', devices: [{ platform: 'ios', name: 'iPhone 17', id: 'U1', sessionId: 'S1', buildId: 2 }] }))!} />)
    fireEvent.click(screen.getByTestId('agent-mobile-test-open-device-ios'))
    await waitFor(() => expect(opened).toEqual([{ deviceId: 'U1', sessionId: 'S1', buildId: 2, platform: 'ios', name: 'iPhone 17' }]))
  })

  it('offers no window for a device without its session (an older row)', () => {
    render(<AgentMobileTestOfferCard row={parseMobileTestOfferRow(row({ state: 'launched', devices: [{ platform: 'ios', name: 'iPhone 17' }] }))!} />)
    expect(screen.queryByTestId('agent-mobile-test-open-device-ios')).toBeNull()
  })

  it('[spec:mobile-device-testing/agent-runs-the-app] follows a run the agent started, without Retry, and opens the device once when it runs', async () => {
    opened.length = 0
    localStorage.clear()
    const device = { platform: 'android', name: 'tapflow-phone', id: 'avd:tapflow-phone', sessionId: 's1', buildId: 8 }
    const started = parseMobileTestOfferRow(row({ deliveryId: '', state: 'started', runId: 'r-agent', platforms: ['android'], autoOpen: true, at: new Date().toISOString() }))!
    const { rerender } = render(<AgentMobileTestOfferCard row={started} />)
    expect(screen.getByText(/this session/i)).toBeInTheDocument()
    expect(screen.queryByTestId(/agent-mobile-test-start-/)).not.toBeInTheDocument()
    const launched = parseMobileTestOfferRow(row({ deliveryId: '', state: 'launched', runId: 'r-agent', platforms: ['android'], autoOpen: true, devices: [device], at: new Date().toISOString() }))!
    rerender(<AgentMobileTestOfferCard row={launched} />)
    await waitFor(() => expect(opened).toEqual([{ deviceId: 'avd:tapflow-phone', sessionId: 's1', buildId: 8, platform: 'android', name: 'tapflow-phone' }]))
    // Re-rendered (or reopened in another window): never a second automatic window.
    rerender(<AgentMobileTestOfferCard row={{ ...launched }} />)
    expect(opened).toHaveLength(1)
    const failed = parseMobileTestOfferRow(row({ deliveryId: '', state: 'failed', runId: 'r-2', reason: 'Android: Tapflow is off.', platforms: ['android'] }))!
    rerender(<AgentMobileTestOfferCard row={failed} />)
    expect(screen.getByText(/Ask the agent to run it again/)).toBeInTheDocument()
    expect(screen.queryByText('Retry')).not.toBeInTheDocument()
  })

  it('never opens a launch that is not recent (a reload of an old mission)', async () => {
    opened.length = 0
    localStorage.clear()
    const old = parseMobileTestOfferRow(row({ deliveryId: '', state: 'launched', runId: 'r-old', platforms: ['ios'], autoOpen: true, devices: [{ platform: 'ios', name: 'iPhone 17 Pro', id: 'UDID', sessionId: 's', buildId: 3 }], at: '2026-01-01T00:00:00Z' }))!
    render(<AgentMobileTestOfferCard row={old} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(opened).toEqual([])
    expect(screen.getByTestId('agent-mobile-test-open-device-ios')).toBeInTheDocument()
  })
})
