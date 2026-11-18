import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import AnalyticsPage from '../../features/analytics/pages/AnalyticsPage'

vi.mock('../../lib/api', () => ({ getApiBase: () => '/api' }))

// Multi-provider project so the engine filter chips render.
vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    activeProjectId: 'proj-1',
    projects: [{ id: 'proj-1', slug: 'p', name: 'P', path: '/p', db_path: ':memory:', provider: 'claude', providers: ['claude', 'codex', 'lan-box'], added_at: '', last_seen_at: '' }],
    isLoading: false,
    setupProjectIds: new Set(),
    setActiveProjectId: vi.fn(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
    addProject: vi.fn(),
    removeProject: vi.fn(),
  }),
  projectProviders: (p: { provider: string; providers?: string[] }) =>
    p.providers && p.providers.length > 0 ? p.providers : [p.provider],
}))

vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({ registerHandler: vi.fn(), unregisterHandler: vi.fn(), connectionStatus: 'connected' }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const stub = (testid: string) => ({ default: () => <div data-testid={testid}>{testid}</div> })
vi.mock('../../features/analytics/components/SpendingHero', () => ({ SpendingHero: ({ data }: { data: unknown }) => <div data-testid="hero">{data ? 'hero-loaded' : 'hero-loading'}</div> }))
vi.mock('../../features/analytics/components/ProviderBreakdownCard', () => ({ ProviderBreakdownCard: () => <div data-testid="provider-breakdown">pb</div> }))
vi.mock('../../features/analytics/components/SpendingTimeline', () => ({ SpendingTimeline: () => <div data-testid="timeline">t</div> }))
vi.mock('../../features/analytics/components/QuickVsExploreCard', () => ({ QuickVsExploreCard: () => <div data-testid="qvse">q</div> }))
vi.mock('../../features/analytics/components/ModelBreakdown', () => ({ ModelBreakdown: () => <div data-testid="models">m</div> }))
vi.mock('../../features/analytics/components/CostScatter', () => ({ CostScatter: () => <div data-testid="scatter">s</div> }))
vi.mock('../../features/analytics/components/TopTicketsCrossSurface', () => ({ TopTicketsCrossSurface: () => <div data-testid="top">x</div> }))
vi.mock('../../features/analytics/components/InvocationsTable', () => ({ InvocationsTable: () => <div data-testid="table">tb</div> }))
vi.mock('../../features/analytics/components/ExportDropdown', () => ({ ExportDropdown: () => <button data-testid="export">Export</button> }))
void stub

// Three engines did work in the period, so the engine select renders.
const emptySpending = {
  summary: { totalCostUsd: 0, totalEstimatedCostUsd: 0, totalRuns: 0, failureRate: 0, prevTotalCostUsd: 0, deltaPct: null, avgCostPerRun: null },
  bySurface: [], byCategory: [], byModel: [], byMode: [],
  byProvider: ['claude', 'codex', 'lan-box'].map((provider) => ({ provider, count: 2, costUsd: 0, estimatedCostUsd: 0 })),
  dailyTimeline: [], scatter: [], topTickets: [],
  trackingStartedAt: null, rangeFrom: '', rangeTo: '',
}
const emptyInvocations = { rows: [], total: 0, truncated: false, totalAvailable: 0 }

describe('AnalyticsPage — multi-provider engine filter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/spending')) return Promise.resolve({ ok: true, json: async () => emptySpending })
      if (url.includes('/invocations')) return Promise.resolve({ ok: true, json: async () => emptyInvocations })
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
  })

  it('offers every engine that did work in the period in the engine select', async () => {
    const user = userEvent.setup()
    render(<AnalyticsPage />)
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    await user.click(await screen.findByTestId('analytics-provider-select'))
    const options = screen.getAllByRole('option').map((option) => option.textContent)
    expect(options).toEqual(expect.arrayContaining(['Claude', 'Codex']))
  })

  it('choosing an engine adds provider= to the spending query', async () => {
    const user = userEvent.setup()
    render(<AnalyticsPage />)
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    await user.click(await screen.findByTestId('analytics-provider-select'))
    await user.click(screen.getByRole('option', { name: 'Codex' }))
    await waitFor(() => {
      const lastSpending = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0] as string).filter((u) => u.includes('/spending')).at(-1)
      expect(lastSpending).toContain('provider=codex')
    })
  })

  it('labels a local engine with its id and a local tag', async () => {
    const user = userEvent.setup()
    render(<AnalyticsPage />)
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    await user.click(await screen.findByTestId('analytics-provider-select'))
    const local = screen.getByRole('option', { name: /lan-box/ })
    expect(local).toHaveTextContent('lan-box')
    expect(local).toHaveTextContent('local')
  })
})
