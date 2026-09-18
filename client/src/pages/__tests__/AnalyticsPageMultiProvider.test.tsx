import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '../../test-utils'
import { within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AnalyticsPage from '../AnalyticsPage'

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
vi.mock('../../components/analytics/SpendingHero', () => ({ SpendingHero: ({ data }: { data: unknown }) => <div data-testid="hero">{data ? 'hero-loaded' : 'hero-loading'}</div> }))
vi.mock('../../components/analytics/ProviderBreakdownCard', () => ({ ProviderBreakdownCard: () => <div data-testid="provider-breakdown">pb</div> }))
vi.mock('../../components/analytics/SpendingTimeline', () => ({ SpendingTimeline: () => <div data-testid="timeline">t</div> }))
vi.mock('../../components/analytics/QuickVsExploreCard', () => ({ QuickVsExploreCard: () => <div data-testid="qvse">q</div> }))
vi.mock('../../components/analytics/ModelBreakdown', () => ({ ModelBreakdown: () => <div data-testid="models">m</div> }))
vi.mock('../../components/analytics/CostScatter', () => ({ CostScatter: () => <div data-testid="scatter">s</div> }))
vi.mock('../../components/analytics/TopTicketsCrossSurface', () => ({ TopTicketsCrossSurface: () => <div data-testid="top">x</div> }))
vi.mock('../../components/analytics/InvocationsTable', () => ({ InvocationsTable: () => <div data-testid="table">tb</div> }))
vi.mock('../../components/ExportDropdown', () => ({ ExportDropdown: () => <button data-testid="export">Export</button> }))
void stub

const emptySpending = {
  summary: { totalCostUsd: 0, totalEstimatedCostUsd: 0, totalRuns: 0, failureRate: 0, prevTotalCostUsd: 0, deltaPct: null, avgCostPerRun: null },
  bySurface: [], byModel: [], byMode: [], byProvider: [], dailyTimeline: [], scatter: [], topTickets: [],
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

  it('renders engine provider chips when the project has more than one provider', async () => {
    render(<AnalyticsPage />)
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    const chips = screen.getByTestId('analytics-provider-chips')
    expect(chips).toBeInTheDocument()
    expect(chips).toHaveTextContent('Claude')
    expect(chips).toHaveTextContent('Codex')
  })

  it('clicking a provider chip adds provider= to the spending query', async () => {
    const user = userEvent.setup()
    render(<AnalyticsPage />)
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    const chips = screen.getByTestId('analytics-provider-chips')
    // Click the "Codex" chip within the engine chip row.
    await user.click(within(chips).getByRole('button', { name: 'Codex' }))
    await waitFor(() => {
      const lastSpending = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0] as string).filter((u) => u.includes('/spending')).at(-1)
      expect(lastSpending).toContain('provider=codex')
    })
  })

  it('renders a local engine chip with the id and a local tag', async () => {
    render(<AnalyticsPage />)
    await waitFor(() => expect(screen.getByTestId('hero').textContent).toBe('hero-loaded'))
    const chip = within(screen.getByTestId('analytics-provider-chips')).getByRole('button', { name: /lan-box/ })
    expect(chip).toHaveTextContent('lan-box')
    expect(chip).toHaveTextContent('local')
  })
})
