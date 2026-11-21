import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '../../../../test-utils'
import userEvent from '@testing-library/user-event'
import AnalyticsPage, { activeEngines } from '../AnalyticsPage'

vi.mock('../../../../lib/api', () => ({
  getApiBase: () => '/api',
}))

const desktop = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; provider: string; providers?: string[] }>,
  available: {} as Record<string, boolean>,
}))

vi.mock('../../../providers/hooks/useAvailableProviders', () => ({
  useAvailableProviders: () => ({ available: desktop.available, availableIds: [], issues: {}, launchDescriptors: {}, labels: {}, loading: false }),
}))

vi.mock('../../../../hooks/useDesktop', () => ({
  projectProviders: (p: { provider: string; providers?: string[] }) => (p.providers && p.providers.length > 0 ? p.providers : [p.provider]),
  useDesktop: () => ({
    activeProjectId: 'proj-1',
    projects: desktop.projects,
    isLoading: false,
    setupProjectIds: new Set(),
    setActiveProjectId: vi.fn(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
    addProject: vi.fn(),
    removeProject: vi.fn(),
  }),
}))

vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: vi.fn(),
    unregisterHandler: vi.fn(),
    connectionStatus: 'connected',
  }),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

// Stub all dashboard child components to keep test focus on the page wiring.
vi.mock('../../components/LegacyWorkflowUsage', () => ({
  LegacyWorkflowUsage: ({ projectId }: { projectId: string }) => <div data-testid="legacy-usage">{projectId}</div>,
}))
vi.mock('../../components/SpendingHero', () => ({
  SpendingHero: ({ data }: { data: unknown }) => (
    <div data-testid="hero">{data ? 'hero-loaded' : 'hero-loading'}</div>
  ),
}))
vi.mock('../../components/SpendBreakdownCard', () => ({
  // Expose onSelectSurface so the surface-level filter (reached from the card) is testable.
  SpendBreakdownCard: ({ onSelectSurface }: { onSelectSurface?: (s: string) => void }) => (
    <div data-testid="breakdown">
      <button data-testid="breakdown-pick-mission" onClick={() => onSelectSurface?.('mission')}>mission</button>
    </div>
  ),
}))
vi.mock('../../components/ProviderBreakdownCard', () => ({
  ProviderBreakdownCard: () => <div data-testid="provider-breakdown">provider</div>,
}))
vi.mock('../../components/SpendingTimeline', () => ({
  SpendingTimeline: () => <div data-testid="timeline">timeline</div>,
}))
vi.mock('../../components/QuickVsExploreCard', () => ({
  QuickVsExploreCard: () => <div data-testid="qvse">qvse</div>,
}))
vi.mock('../../components/ModelBreakdown', () => ({
  // Expose onSelectModel via a clickable button so the page's model-filter
  // wiring (chip, URL-sync, provider-alignment) can be exercised.
  ModelBreakdown: ({ onSelectModel }: { onSelectModel: (m: string) => void }) => (
    <div data-testid="models">
      <button data-testid="model-pick" onClick={() => onSelectModel('gpt-5.5')}>pick</button>
    </div>
  ),
}))
vi.mock('../../components/CostScatter', () => ({
  CostScatter: () => <div data-testid="scatter">scatter</div>,
}))
vi.mock('../../components/TopTicketsCrossSurface', () => ({
  TopTicketsCrossSurface: () => <div data-testid="top">top</div>,
}))
vi.mock('../../components/InvocationsTable', () => ({
  // Surface the `truncated` prop so the cap/footnote fix is assertable.
  InvocationsTable: ({ truncated, totalAvailable }: { truncated: boolean; totalAvailable: number }) => (
    <div data-testid="table" data-truncated={String(truncated)} data-total={totalAvailable}>table</div>
  ),
}))
vi.mock('../../components/BudgetCard', () => ({
  // Like the real card: ready only after a tick (it renders a skeleton while loading).
  BudgetCard: ({ onReady }: { onReady?: () => void }) => {
    useEffect(() => { const timer = setTimeout(() => onReady?.(), 20); return () => clearTimeout(timer) }, [onReady])
    return <div data-testid="budget-card">budget</div>
  },
}))
vi.mock('../../components/ExportDropdown', () => ({
  ExportDropdown: ({ disabled }: { disabled?: boolean }) => (
    <button data-testid="export" disabled={disabled}>Export</button>
  ),
}))

const emptySpending = {
  summary: {
    totalCostUsd: 0,
    totalEstimatedCostUsd: 0,
    totalRuns: 0,
    failureRate: 0,
    prevTotalCostUsd: 0,
    deltaPct: null,
    avgCostPerRun: null,
  },
  bySurface: [], byModel: [], byMode: [], byProvider: [], dailyTimeline: [], scatter: [], topTickets: [],
  trackingStartedAt: null, rangeFrom: '', rangeTo: '',
}
const emptyInvocations = { rows: [], total: 0, truncated: false, totalAvailable: 0 }

function mockFetch() {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/spending')) return Promise.resolve({ ok: true, json: async () => emptySpending })
    if (url.includes('/invocations')) return Promise.resolve({ ok: true, json: async () => emptyInvocations })
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

function renderPage() {
  return render(<AnalyticsPage />)
}

describe('AnalyticsPage', () => {
  beforeEach(() => { vi.clearAllMocks(); mockFetch(); desktop.projects = []; desktop.available = {} })

  it('renders the seven dashboard blocks once data loads', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    expect(screen.getByTestId('breakdown')).toBeInTheDocument()
    expect(screen.getByTestId('timeline')).toBeInTheDocument()
    expect(screen.getByTestId('qvse')).toBeInTheDocument()
    expect(screen.getByTestId('models')).toBeInTheDocument()
    expect(screen.getByTestId('scatter')).toBeInTheDocument()
    expect(screen.getByTestId('top')).toBeInTheDocument()
    expect(screen.getByTestId('table')).toBeInTheDocument()
    expect(screen.getByTestId('legacy-usage')).toHaveTextContent('proj-1')
  })

  const withProviders = (byProvider: Array<{ provider: string; count: number }>) => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/spending')) return Promise.resolve({ ok: true, json: async () => ({ ...emptySpending, byProvider: byProvider.map((p) => ({ ...p, costUsd: 0, estimatedCostUsd: 0 })) }) })
      if (url.includes('/invocations')) return Promise.resolve({ ok: true, json: async () => emptyInvocations })
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
  }

  it('offers the engine filter only for engines with activity in the period, never the internal runtime', async () => {
    desktop.projects = [{ id: 'proj-1', provider: 'claude', providers: ['claude', 'codex', 'gemini'] }]
    withProviders([{ provider: 'claude', count: 4 }, { provider: 'codex', count: 2 }, { provider: 'gemini', count: 0 }, { provider: 'agent-runtime', count: 9 }])
    renderPage()
    const select = await screen.findByTestId('analytics-provider-select')
    expect(select).toBeInTheDocument()
    expect(activeEngines([
      { provider: 'claude', count: 4, costUsd: 0, estimatedCostUsd: 0 },
      { provider: 'gemini', count: 0, costUsd: 0, estimatedCostUsd: 0 },
      { provider: 'agent-runtime', count: 9, costUsd: 0, estimatedCostUsd: 0 },
    ])).toEqual(['claude'])
  })

  it('hides the engine filter when fewer than two engines did work, even if more are configured', async () => {
    desktop.projects = [{ id: 'proj-1', provider: 'claude', providers: ['claude', 'codex', 'gemini'] }]
    withProviders([{ provider: 'claude', count: 4 }, { provider: 'codex', count: 0 }, { provider: 'agent-runtime', count: 3 }])
    renderPage()
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    expect(screen.queryByTestId('analytics-provider-select')).not.toBeInTheDocument()
  })

  it('keeps the whole filter row on one header with the subtitle as a hint', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    const header = screen.getByTestId('analytics-header')
    expect(within(header).getByTestId('analytics-category-chips')).toBeInTheDocument()
    expect(within(header).getByTestId('export')).toBeInTheDocument()
    expect(within(header).getByTestId('analytics-subtitle')).toHaveTextContent(/Where the spend goes/)
  })

  it('disables export when there are no invocations', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    expect(screen.getByTestId('export')).toBeDisabled()
  })

  it('changing the period triggers a refetch', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    const callsBefore = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length
    await user.click(screen.getByRole('button', { name: '7d' }))
    await waitFor(() => {
      const callsAfter = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length
      expect(callsAfter).toBeGreaterThan(callsBefore)
    })
    const lastSpendingCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string)
      .filter((u) => u.includes('/spending')).at(-1)
    expect(lastSpendingCall).toContain('period=7d')
  })

  it('reads top-down: how much → why → when → engines/models → limits → specs → calls → more', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    await waitFor(() => expect(screen.getByTestId('budget-card')).toBeInTheDocument())
    const order = ['hero', 'breakdown', 'timeline', 'provider-breakdown', 'models', 'budget-card', 'top', 'table', 'analytics-more-breakdowns']
    const nodes = order.map((id) => screen.getByTestId(id))
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i - 1].compareDocumentPosition(nodes[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    // Secondary cards live in the collapsed "more breakdowns" section.
    const more = screen.getByTestId('analytics-more-breakdowns')
    expect(more).toContainElement(screen.getByTestId('qvse'))
    expect(more).toContainElement(screen.getByTestId('scatter'))
    expect(screen.queryByTestId('agent-missions-card')).not.toBeInTheDocument()
  })

  it('shows All + the five category chips instead of surface chips', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    const chips = screen.getByTestId('analytics-category-chips')
    const labels = Array.from(chips.querySelectorAll('button')).map((b) => b.firstChild?.textContent)
    expect(labels).toEqual(['All', 'Implementation', 'Missions', 'Specs', 'Code', 'Support'])
    // The one-line why is exposed to assistive tech on each chip.
    expect(screen.getByRole('button', { name: /Missions/ })).toHaveAccessibleDescription('Talking to the agent and Intent mode')
    expect(screen.queryByRole('button', { name: 'Jobs' })).not.toBeInTheDocument()
  })

  it('toggling a category chip sends the category filter and persists it in the URL', async () => {
    function LocationProbe() {
      const location = useLocation()
      return <output data-testid="loc">{location.search}</output>
    }
    const user = userEvent.setup()
    render(<><AnalyticsPage /><LocationProbe /></>)
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    await user.click(screen.getByRole('button', { name: /Missions/ }))
    await waitFor(() => {
      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string)
      expect(calls.filter((u) => u.includes('/spending')).at(-1)).toContain('category=missions')
      expect(calls.filter((u) => u.includes('/invocations')).at(-1)).toContain('category=missions')
    })
    expect(screen.getByTestId('loc').textContent).toContain('category=missions')
    expect(screen.getByRole('button', { name: /Missions/ })).toHaveAttribute('aria-pressed', 'true')
    await user.click(within(screen.getByTestId('analytics-category-chips')).getByRole('button', { name: 'All' }))
    await waitFor(() => {
      const last = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0] as string).filter((u) => u.includes('/spending')).at(-1)
      expect(last).not.toContain('category=')
    })
  })

  it('reaches the surface filter from the breakdown card and clears it from the header chip', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    await user.click(screen.getByTestId('breakdown-pick-mission'))
    await waitFor(() => {
      const last = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0] as string).filter((u) => u.includes('/spending')).at(-1)
      expect(last).toContain('surface=mission')
    })
    expect(screen.getByTestId('analytics-surface-chip')).toHaveTextContent('Missions')
    await user.click(screen.getByTestId('analytics-surface-chip'))
    await waitFor(() => expect(screen.queryByTestId('analytics-surface-chip')).not.toBeInTheDocument())
  })

  it('honours ?surface= and ?category= from the URL', async () => {
    render(<AnalyticsPage />, { route: '/analytics?surface=intent&category=missions,bogus' })
    await waitFor(() => {
      const last = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0] as string).filter((u) => u.includes('/spending')).at(-1)
      expect(last).toContain('surface=intent')
      expect(last).toContain('category=missions')
      expect(last).not.toContain('bogus')
    })
  })

  // BUG-ANALYTICS-19: >100 invocations must surface the truncation footnote even
  // though the server `truncated` flag is false on the limit path.
  it('marks the table truncated when totalAvailable exceeds rows shown', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/spending')) return Promise.resolve({ ok: true, json: async () => emptySpending })
      if (url.includes('/invocations')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ rows: [{ id: 'a' }], total: 1, truncated: false, totalAvailable: 250 }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('table').getAttribute('data-truncated')).toBe('true'))
    expect(screen.getByTestId('table').getAttribute('data-total')).toBe('250')
  })

  it('does NOT mark truncated when all rows fit', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/spending')) return Promise.resolve({ ok: true, json: async () => emptySpending })
      if (url.includes('/invocations')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ rows: [{ id: 'a' }, { id: 'b' }], total: 2, truncated: false, totalAvailable: 2 }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('table')).toBeInTheDocument())
    expect(screen.getByTestId('table').getAttribute('data-truncated')).toBe('false')
  })

  // BUG-ANALYTICS-22 + BUG-ANALYTICS-30: clicking a model renders a removable
  // header chip and threads the provider-aligned modelProvider into the query.
  it('shows a removable model chip and sends provider-aligned model filter', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/spending')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ...emptySpending, byModel: [{ model: 'gpt-5.5', provider: 'codex', count: 3, costUsd: 1, estimatedCostUsd: 1 }] }),
        })
      }
      if (url.includes('/invocations')) return Promise.resolve({ ok: true, json: async () => emptyInvocations })
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    await user.click(screen.getByTestId('model-pick'))
    // Chip appears.
    await waitFor(() => expect(screen.getByTestId('analytics-model-chip')).toBeInTheDocument())
    // The spending query carries model + the codex provider qualifier.
    await waitFor(() => {
      const last = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0] as string).filter((u) => u.includes('/spending')).at(-1)
      expect(last).toContain('model=gpt-5.5')
      expect(last).toContain('modelProvider=codex')
    })
    // Clicking the chip clears the model filter.
    await user.click(screen.getByTestId('analytics-model-chip'))
    await waitFor(() => expect(screen.queryByTestId('analytics-model-chip')).not.toBeInTheDocument())
  })

  // BUG-ANALYTICS-35: switching to cost ordering sends sortBy=cost to /invocations.
  it('cost-sort toggle sends sortBy=cost to the invocations query', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    // Default ordering is recency.
    const firstInvoke = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string).filter((u) => u.includes('/invocations')).at(-1)
    expect(firstInvoke).toContain('sortBy=recency')
    await user.click(screen.getByTestId('analytics-table-sort-cost'))
    await waitFor(() => {
      const last = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0] as string).filter((u) => u.includes('/invocations')).at(-1)
      expect(last).toContain('sortBy=cost')
    })
  })

  // BUG-ANALYTICS-21 plumbing: the spending query carries the client tz offset so
  // dailyTimeline buckets line up with the user's local "today".
  it('threads tzOffsetMinutes into the spending query', async () => {
    renderPage()
    await waitFor(() => {
      const last = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0] as string).filter((u) => u.includes('/spending')).at(-1)
      expect(last).toContain('tzOffsetMinutes=')
    })
  })

  // "Raise limit" lands on ?panel=budget: the filter-persisting effect used to rewrite the URL and cancel the scroll.
  describe('?panel=budget landing', () => {
    function LocationProbe() {
      const location = useLocation()
      return <output data-testid="loc">{location.search}</output>
    }

    it('scrolls to the budget card once it is ready and keeps the param meanwhile', async () => {
      const scrollIntoView = vi.fn()
      window.HTMLElement.prototype.scrollIntoView = scrollIntoView
      render(<><AnalyticsPage /><LocationProbe /></>, { route: '/analytics?panel=budget' })
      await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
      // The filter effect has rewritten the query string, yet the landing request survived it.
      expect(screen.getByTestId('loc').textContent).toContain('panel=budget')
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
      const target = scrollIntoView.mock.instances[0] as HTMLElement
      expect(target.querySelector('[data-testid="budget-card"]')).not.toBeNull()
      // Landed: the param is dropped so a later refresh does not scroll again.
      await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('panel=budget'))
    })

    it('does not scroll without the param', async () => {
      const scrollIntoView = vi.fn()
      window.HTMLElement.prototype.scrollIntoView = scrollIntoView
      renderPage()
      await waitFor(() => expect(screen.getByTestId('budget-card')).toBeInTheDocument())
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(scrollIntoView).not.toHaveBeenCalled()
    })
  })
})
