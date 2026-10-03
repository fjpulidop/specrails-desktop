import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SubscriptionUsageFooter } from '../components/SubscriptionUsageFooter'
import { SubscriptionUsagePanel } from '../components/SubscriptionUsagePanel'
import { SubscriptionUsageSection } from '../components/SubscriptionUsageSection'
import type { UsageSnapshot, ProviderUsage } from '../lib/types'
const fixture = vi.hoisted(() => ({ snapshot: null as UsageSnapshot | null, refresh: vi.fn(), error: false, busy: false }))
vi.mock('../lib/useSubscriptionUsage', () => ({ useSubscriptionUsage: () => fixture }))
function row(id: 'claude' | 'codex'): ProviderUsage {
  return { providerId: id, installed: true, generation: 'g', availability: 'available', refreshState: 'idle', freshness: 'fresh', plan: null,
    source: 'oauth', windows: [{ id: 'w', label: 'session', usedPercent: 0, durationMinutes: 300, resetsAt: null, model: null, scope: 'account' }],
    observedAt: new Date().toISOString(), attemptedAt: null, retryAt: null, issue: null }
}
beforeEach(() => { fixture.snapshot = { scope: 'machine', instanceId: 'test-server', revision: 1, providers: [row('claude'), row('codex')] }; fixture.error = false; fixture.busy = false; fixture.refresh.mockClear(); localStorage.clear() })
describe('subscription usage surfaces', () => {
  it('represents zero as measured and null as unavailable', () => {
    fixture.snapshot!.providers[1].windows[0].usedPercent = null
    render(<SubscriptionUsagePanel />)
    expect(screen.getByText('0% used')).toBeInTheDocument()
    expect(screen.getByText('Usage unavailable')).toBeInTheDocument()
    expect(screen.getAllByRole('progressbar')).toHaveLength(1)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })
  it('shows an explicit no-CLI state instead of fake quotas in the sidebar', () => {
    fixture.snapshot!.providers.forEach(p => { p.installed = false; p.windows = []; p.issue = { code: 'cli-missing', retryable: false } })
    render(<SubscriptionUsageSection expanded />)
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))
    expect(screen.getByText(/No Claude or Codex CLI detected/)).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Manage providers' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' })); expect(fixture.refresh).toHaveBeenCalledWith()
  })
  it('keeps the detected provider usable when the other CLI is absent', () => {
    fixture.snapshot!.providers[1].installed = false; fixture.snapshot!.providers[1].windows = []
    render(<SubscriptionUsageSection expanded />)
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))
    expect(screen.getByRole('article', { name: 'Claude' })).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Codex' })).toBeInTheDocument()
  })
  it('always shows detailed windows and ignores the old compact preference', () => {
    fixture.snapshot!.providers[0].windows.push({ ...fixture.snapshot!.providers[0].windows[0], id: 'model', model: 'Sonnet', usedPercent: 75, label: 'weekly' })
    localStorage.setItem('specrails:usage-view', 'compact'); render(<SubscriptionUsagePanel />)
    expect(screen.getByText('Sonnet · 7 days')).toBeInTheDocument(); expect(screen.getByText('75% used')).toBeInTheDocument()
    expect(screen.getAllByRole('progressbar')).toHaveLength(3)
    for (const name of ['Compact', 'Detailed', 'View details', 'Manage providers']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
  })
  it('does not simulate a zero after a passed reset', () => {
    fixture.snapshot!.providers[0].windows[0].usedPercent = 95
    fixture.snapshot!.providers[0].windows[0].resetsAt = new Date(Date.now() - 60_000).toISOString()
    render(<SubscriptionUsagePanel />)
    expect(screen.getByText('95% used')).toBeInTheDocument(); expect(screen.getByText('Reset reached; refresh to confirm')).toBeInTheDocument()
    expect(screen.getByText('Out of date')).toBeInTheDocument()
  })
  it('shows static provider cards without opening a duplicate floating panel', () => {
    const view = render(<SubscriptionUsageSection expanded />)
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))
    fireEvent.click(screen.getByRole('article', { name: 'Claude' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(2)
    view.rerender(<SubscriptionUsageSection expanded={false} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('starts collapsed and toggles from its header independently of refresh', () => {
    render(<SubscriptionUsageSection expanded />)
    const header = screen.getByRole('button', { name: 'Usage' })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Refresh usage' })).not.toBeInTheDocument()
    fixture.refresh.mockClear()
    fireEvent.click(header)
    expect(fixture.refresh).toHaveBeenCalledTimes(1)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('article')).toHaveLength(2)
    const refreshButton = screen.getByRole('button', { name: 'Refresh usage' })
    expect(refreshButton).toHaveClass('opacity-100')
    fireEvent.click(header)
    expect(refreshButton).toHaveClass('opacity-0')
    expect(refreshButton).toBeDisabled()
    expect(refreshButton).toHaveAttribute('tabindex', '-1')
    expect(fixture.refresh).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    fireEvent.click(header)
    expect(fixture.refresh).toHaveBeenCalledTimes(2)
  })
  it('shows the account weekly quota in the footer and all windows on opening', () => {
    fixture.snapshot!.providers[0].windows.push({ ...fixture.snapshot!.providers[0].windows[0], id: 'weekly', label: 'weekly', usedPercent: 58 })
    render(<SubscriptionUsageFooter />)
    const trigger = screen.getByRole('button', { name: 'Usage' })
    expect(trigger).toHaveTextContent('Claude58%')
    expect(trigger).not.toHaveTextContent('Claude0%')
    fireEvent.focus(trigger)
    expect(screen.getAllByRole('progressbar')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: 'Compact' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Detailed' })).not.toBeInTheDocument()
  })
  it('uses the menu outline halo during refresh instead of a spinner', () => {
    fixture.busy = true
    const view = render(<SubscriptionUsageFooter />)
    fireEvent.focus(screen.getByRole('button', { name: 'Usage' }))
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByTestId('builder-halo')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Refresh usage' })).not.toBeInTheDocument()
    fixture.busy = false
    view.rerender(<SubscriptionUsageFooter />)
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'false')
  })
  it('shows each reset countdown and last successful update in the menu', () => {
    fixture.snapshot!.providers[0].observedAt = new Date(Date.now() - 180_000).toISOString()
    fixture.snapshot!.providers[0].windows[0].resetsAt = new Date(Date.now() + (6 * 24 + 2) * 3600_000).toISOString()
    render(<SubscriptionUsageFooter />)
    fireEvent.focus(screen.getByRole('button', { name: 'Usage' }))
    expect(screen.getByText('Updated 3 minutes ago')).toBeInTheDocument()
    expect(screen.getByText(/Resets in 6d 2h/)).toBeInTheDocument()
    expect(screen.getByText('Reset time unavailable')).toBeInTheDocument()
  })
  it('opens footer usage on mouse hover and closes with Escape', () => {
    render(<SubscriptionUsageFooter />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Usage' }), { pointerType: 'mouse' })
    // Focus is an equivalent keyboard entry point.
    fireEvent.focus(screen.getByRole('button', { name: 'Usage' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Claude' })).toBeInTheDocument()
    expect(fixture.refresh).toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('keeps unknown plan absent and respects refresh cooldown', () => {
    fixture.snapshot!.providers.forEach(p => { p.retryAt = new Date(Date.now() + 120_000).toISOString() })
    render(<SubscriptionUsagePanel />)
    expect(screen.getByRole('button', { name: 'Refresh usage' })).toBeDisabled()
    expect(screen.queryByText('plus')).not.toBeInTheDocument()
  })
})

describe('Enterprise monthly spending surfaces', () => {
  function enterprise() {
    const provider = fixture.snapshot!.providers[0]
    provider.plan = 'enterprise'; provider.windows = []
    provider.spend = { kind: 'enterprise-on-demand', usedAmount: 20.78, limitAmount: 1000, limitStatus: 'limited', currency: 'USD', usedPercent: 2, resetsAt: new Date(Date.now() + 86400_000).toISOString() }
    return provider
  }
  it('shows measured dollar spend and assigned budget in the footer menu instead of unavailable', () => {
    enterprise()
    render(<SubscriptionUsageFooter />)
    const trigger = screen.getByRole('button', { name: 'Usage' })
    expect(trigger).toHaveTextContent('Claude2%')
    fireEvent.focus(trigger)
    expect(screen.getByText('Enterprise · On demand')).toBeInTheDocument()
    expect(screen.getByText('$20.78 of $1,000.00 spent')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Claude monthly spend' })).toHaveAttribute('aria-valuenow', '2')
    expect(screen.queryByText('Usage unavailable')).not.toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Codex' })).toHaveTextContent('5 hours')
  })
  it('shows monetary progress in settings and refreshes changed caps', () => {
    const provider = enterprise()
    const view = render(<SubscriptionUsagePanel selectedProvider="claude" />)
    expect(screen.getByText('$20.78 of $1,000.00 spent')).toBeInTheDocument()
    provider.spend = { ...provider.spend!, limitAmount: 2000, usedPercent: 1 }
    view.rerender(<SubscriptionUsagePanel selectedProvider="claude" />)
    expect(screen.getByText('$20.78 of $2,000.00 spent')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1')
  })
  it('keeps zero spending distinct from missing amounts and unlimited caps', () => {
    const provider = enterprise()
    provider.spend = { ...provider.spend!, usedAmount: 0, usedPercent: 0 }
    const view = render(<SubscriptionUsagePanel selectedProvider="claude" />)
    expect(screen.getByText('$0.00 of $1,000.00 spent')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    provider.spend = { ...provider.spend, limitAmount: null, limitStatus: 'unlimited', usedPercent: null }
    view.rerender(<SubscriptionUsagePanel selectedProvider="claude" />)
    expect(screen.getByText('No monthly limit')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    provider.spend = { ...provider.spend, limitStatus: 'unknown' }
    view.rerender(<SubscriptionUsagePanel selectedProvider="claude" />)
    expect(screen.getByText('Monthly limit unavailable')).toBeInTheDocument()
    provider.spend = { ...provider.spend, usedAmount: null, limitAmount: 1000, limitStatus: 'limited' }
    view.rerender(<SubscriptionUsagePanel selectedProvider="claude" />)
    expect(screen.getByText('— of $1,000.00 spent')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })
  it('preserves over-budget values, formats currency and marks passed resets stale', () => {
    const provider = enterprise()
    provider.spend = { ...provider.spend!, usedAmount: 1200, usedPercent: 120, currency: 'EUR' }
    const view = render(<SubscriptionUsagePanel selectedProvider="claude" />)
    expect(screen.getByText('€1,200.00 of €1,000.00 spent')).toBeInTheDocument()
    expect(screen.getByText('120%')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByText('Limit reached')).toBeInTheDocument()
    provider.spend = { ...provider.spend, resetsAt: new Date(Date.now() - 1000).toISOString() }
    view.rerender(<SubscriptionUsagePanel selectedProvider="claude" />)
    expect(screen.getByText('Out of date')).toBeInTheDocument()
    expect(screen.getByText('Reset reached; refresh to confirm')).toBeInTheDocument()
    expect(screen.queryByText('Limit reached')).not.toBeInTheDocument()
  })
})
