import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '../../test-utils'
import { SLOW_START_MS, StatusBar, TodaySpend } from '../StatusBar'

vi.mock('../../features/subscription-usage/components/SubscriptionUsageFooter', () => ({ SubscriptionUsageFooter: () => <span data-testid="usage" /> }))
vi.mock('../../features/background/components/AppResourcesFooter', () => ({ AppResourcesFooter: () => <span data-testid="resources" /> }))

vi.mock('../../lib/api', () => ({
  getApiBase: () => '/api',
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const stats = (body: Record<string, unknown>) => vi.fn().mockResolvedValue({ ok: true, json: async () => body })

describe('StatusBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn().mockResolvedValue({ ok: false })
  })
  afterEach(() => { vi.useRealTimers() })

  it('says nothing on the left while connected (no "connected" label, no dash)', () => {
    render(<StatusBar connectionStatus="connected" />)
    expect(screen.getByRole('status')).toHaveClass('sr-only')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(document.querySelector('footer')).not.toHaveTextContent('—')
    expect(document.querySelector('footer')).not.toHaveTextContent(/connected/i)
  })

  it('shows "Offline" in red when disconnected', () => {
    render(<StatusBar connectionStatus="disconnected" />)
    expect(screen.getByText('Offline')).toHaveClass('text-destructive')
    expect(document.querySelector('.bg-destructive')).toBeInTheDocument()
  })

  it('names a reconnect after the app was connected', () => {
    const { rerender } = render(<StatusBar connectionStatus="connected" />)
    rerender(<StatusBar connectionStatus="connecting" />)
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument()
    expect(document.querySelector('.bg-accent-warning')).toBeInTheDocument()
  })

  it('keeps a first connect quiet unless it takes long', () => {
    vi.useFakeTimers()
    render(<StatusBar connectionStatus="connecting" />)
    expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(SLOW_START_MS) })
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument()
  })

  it('never fetches project stats for the bar itself', () => {
    render(<StatusBar connectionStatus="connected" />)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('renders the terminal toggle slot', () => {
    render(<StatusBar connectionStatus="connected" rightSlot={<button type="button">Terminal</button>} />)
    expect(screen.getByRole('button', { name: 'Terminal' })).toBeInTheDocument()
  })

  it('shows "Connection restored" toast after a real outage (>= 3 s offline)', async () => {
    const { toast } = await import('sonner')
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const { rerender } = render(<StatusBar connectionStatus="connected" />)
    rerender(<StatusBar connectionStatus="disconnected" />)
    now.mockReturnValue(1_004_000)
    rerender(<StatusBar connectionStatus="connected" />)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Connection restored'))
    expect(screen.getByText('Syncing…')).toBeInTheDocument()
    now.mockRestore()
  })

  it('stays quiet on a short blip and on a plain reload', async () => {
    const { toast } = await import('sonner')
    vi.mocked(toast.success).mockClear()
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    const { rerender } = render(<StatusBar connectionStatus="connecting" />)
    rerender(<StatusBar connectionStatus="connected" />)
    rerender(<StatusBar connectionStatus="disconnected" />)
    now.mockReturnValue(2_001_000)
    rerender(<StatusBar connectionStatus="connected" />)
    expect(toast.success).not.toHaveBeenCalled()
    now.mockRestore()
  })
})

describe('TodaySpend (inside the usage popover)', () => {
  it("shows today's spend", async () => {
    global.fetch = stats({ costToday: 0.25, totalCostUsd: 1.5 })
    render(<TodaySpend />)
    expect(await screen.findByText('$0.25')).toBeInTheDocument()
    expect(screen.getByText('Spent today')).toBeInTheDocument()
  })

  it('prefixes ~ and marks data-estimated when today includes an estimate (BUG-27)', async () => {
    global.fetch = stats({ costToday: 0.5, estimatedCostToday: 0.3 })
    render(<TodaySpend />)
    const el = await screen.findByText('~$0.50')
    expect(el).toHaveAttribute('data-estimated', 'true')
  })

  it('does not prefix ~ on an authoritative cost', async () => {
    global.fetch = stats({ costToday: 0.5 })
    render(<TodaySpend />)
    const el = await screen.findByText('$0.50')
    expect(el).not.toHaveAttribute('data-estimated')
  })

  it('renders nothing at zero or on a failed read', async () => {
    global.fetch = stats({ costToday: 0 })
    const { container, unmount } = render(<TodaySpend />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container).toBeEmptyDOMElement()
    unmount()
    global.fetch = vi.fn().mockRejectedValue(new Error('network'))
    const second = render(<TodaySpend />)
    await new Promise((r) => setTimeout(r, 20))
    expect(second.container).toBeEmptyDOMElement()
  })

  it('says unavailable for an all-unpriced ledger and marks a lower bound when some runs are unpriced', async () => {
    global.fetch = stats({ costToday: 0, pricedRuns: 0, unpricedRuns: 2 })
    const { unmount } = render(<TodaySpend />)
    expect(await screen.findByText('unavailable')).toBeInTheDocument()
    unmount()
    global.fetch = stats({ costToday: 1.5, pricedRuns: 1, unpricedRuns: 1 })
    render(<TodaySpend />)
    expect(await screen.findByText('≥$1.50')).toBeInTheDocument()
  })
})
