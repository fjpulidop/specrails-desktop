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
