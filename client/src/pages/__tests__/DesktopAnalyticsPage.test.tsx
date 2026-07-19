import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { render } from '../../test-utils'

// Mock recharts
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Line: () => null,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}))

// Mock useSharedWebSocket — capture the registered handler so tests can drive
// the app-level refetch triggers (MED-11).
const wsMock = vi.hoisted(() => {
  let handler: ((msg: unknown) => void) | null = null
  return {
    register: (_id: string, fn: (msg: unknown) => void) => { handler = fn },
    unregister: () => {},
    emit: (msg: unknown) => handler?.(msg),
  }
})
vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: wsMock.register,
    unregisterHandler: wsMock.unregister,
    connectionStatus: 'connected' as const,
  }),
}))

const mockAnalyticsData = {
  period: { label: 'Last 7 days', from: null, to: null },
  kpi: {
    totalCostUsd: 2.5,
    totalJobs: 50,
    successRate: 0.88,
    costToday: 0.12,
    jobsToday: 5,
  },
  costTimeline: [
    { date: '2024-01-01', costUsd: 0.5 },
    { date: '2024-01-02', costUsd: 0.8 },
  ],
  projectBreakdown: [
    {
      projectId: 'proj-1',
      projectName: 'Project Alpha',
      totalCostUsd: 1.5,
      totalJobs: 30,
      successRate: 0.9,
      avgDurationMs: 60000,
    },
  ],
}

describe('DesktopAnalyticsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => mockAnalyticsData,
    })
  })

  it('renders Desktop Analytics heading', async () => {
    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)
    expect(screen.getByText('Desktop Analytics')).toBeInTheDocument()
  })

  it('renders loading skeleton initially', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {}) // never resolves
    )

    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)
    // Loading skeleton uses animate-pulse
    const skeletons = document.querySelectorAll('.animate-pulse')
    expect(skeletons.length).toBeGreaterThan(0)
  })

  it('renders KPI cards after loading', async () => {
    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)

    await waitFor(() => {
      expect(screen.getByText('Total Cost')).toBeInTheDocument()
    })
    expect(screen.getByText('Total Jobs')).toBeInTheDocument()
    expect(screen.getByText('Success Rate')).toBeInTheDocument()
  })

  it('renders project comparison section', async () => {
    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)

    await waitFor(() => {
      expect(screen.getByText('Project Comparison')).toBeInTheDocument()
    })
    expect(screen.getByText('Project Alpha')).toBeInTheDocument()
  })

  it('renders error state when fetch fails', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
    })

    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)

    await waitFor(() => {
      expect(screen.getByText(/failed to load analytics/i)).toBeInTheDocument()
    })
  })

  it('renders period selector buttons', async () => {
    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)

    await waitFor(() => {
      expect(screen.getByText('7d')).toBeInTheDocument()
    })
    expect(screen.getByText('30d')).toBeInTheDocument()
  })

  it('renders refresh button', async () => {
    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)

    await waitFor(() => {
      expect(screen.getByLabelText('Refresh analytics')).toBeInTheDocument()
    })
  })

  it('changes period when a preset button is clicked', async () => {
    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)

    await waitFor(() => {
      expect(screen.getByText('30d')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('30d'))

    await waitFor(() => {
      // fetch should have been called again with period=30d
      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      const has30d = calls.some(([url]: [string]) => url.includes('period=30d'))
      expect(has30d).toBe(true)
    })
  })

  it('renders cost data values in KPI cards', async () => {
    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)

    await waitFor(() => {
      expect(screen.getByText('$2.5000')).toBeInTheDocument()
    })
  })

  it('renders unavailable instead of $0 for Kimi-only cost telemetry', async () => {
    const kimiData = {
      ...mockAnalyticsData,
      kpi: {
        ...mockAnalyticsData.kpi,
        totalCostUsd: 0,
        costToday: 0,
        totalJobs: 1,
        jobsToday: 1,
        pricedRuns: 0,
        unpricedRuns: 1,
        pricedTodayRuns: 0,
        unpricedTodayRuns: 1,
      },
      costTimeline: [{ date: '2024-01-01', costUsd: 0, unpricedCount: 1 }],
      projectBreakdown: [{
        ...mockAnalyticsData.projectBreakdown[0],
        projectName: 'Kimi Project',
        totalCostUsd: 0,
        totalJobs: 1,
        pricedRuns: 0,
        unpricedRuns: 1,
      }],
    }
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => kimiData,
    })

    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)

    await waitFor(() => {
      expect(screen.getByTestId('kpi-cost-coverage-note')).toHaveTextContent(/cost telemetry is unavailable/i)
    })
    expect(screen.getByTestId('desktop-timeline-cost-unavailable')).toBeInTheDocument()
    expect(screen.getByTestId('desktop-project-cost-unavailable')).toBeInTheDocument()
    expect(screen.queryByText('$0.0000')).not.toBeInTheDocument()
  })

  it('renders "No projects registered." when projectBreakdown is empty', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ...mockAnalyticsData, projectBreakdown: [] }),
    })

    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)

    await waitFor(() => {
      expect(screen.getByText('No projects registered.')).toBeInTheDocument()
    })
  })

  // ─── Estimated (codex/gemini) split — BUG-ANALYTICS-24/25/26/28 ──────────────

  const estimatedData = {
    period: { label: 'Last 7 days', from: null, to: null },
    kpi: {
      totalCostUsd: 3.0,
      totalJobs: 40,
      successRate: 0.9,
      costToday: 0.5,
      jobsToday: 4,
      estimatedCostUsd: 1.2, // codex/gemini rate-card portion
      estimatedCostToday: 0.3,
      includesEstimated: true,
    },
    costTimeline: [
      { date: '2024-01-01', costUsd: 1.0, estimatedCostUsd: 0.4 },
      { date: '2024-01-02', costUsd: 2.0, estimatedCostUsd: 0 },
    ],
    projectBreakdown: [
      {
        projectId: 'proj-codex',
        projectName: 'Codex Project',
        totalCostUsd: 2.0,
        totalJobs: 25,
        successRate: 0.8,
        avgDurationMs: 50000,
        estimatedCostUsd: 2.0, // wholly estimated
      },
      {
        projectId: 'proj-claude',
        projectName: 'Claude Project',
        totalCostUsd: 1.0,
        totalJobs: 15,
        successRate: 1.0,
        avgDurationMs: 40000,
        estimatedCostUsd: 0, // wholly authoritative
      },
    ],
  }

  it('marks grand-total cost with ~ and shows estimated footnote (BUG-24)', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => estimatedData,
    })
    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)

    await waitFor(() => {
      expect(screen.getByText('~$3.0000')).toBeInTheDocument()
    })
    expect(screen.getByTestId('kpi-estimated-footnote')).toBeInTheDocument()
  })

  it('marks avg-cost-per-job with ~ when total includes estimate (BUG-28)', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => estimatedData,
    })
    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)

    // 3.0 / 40 = 0.07500
    await waitFor(() => {
      expect(screen.getByText('~$0.07500')).toBeInTheDocument()
    })
  })

  it('badges estimate-heavy project rows and prefixes ~ (BUG-25)', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => estimatedData,
    })
    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)

    await waitFor(() => {
      expect(screen.getByText('Codex Project')).toBeInTheDocument()
    })
    // The codex project is wholly estimated → exactly one estimated badge + ~ figure
    const badges = screen.getAllByTestId('project-estimated-badge')
    expect(badges).toHaveLength(1)
    expect(screen.getByText('~$2.0000')).toBeInTheDocument()
    // Claude project shows an authoritative figure (no ~)
    expect(screen.getByText('$1.0000')).toBeInTheDocument()
  })

  it('shows the timeline estimated note when any day is estimated (BUG-26)', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => estimatedData,
    })
    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)

    await waitFor(() => {
      expect(screen.getByTestId('timeline-estimated-note')).toBeInTheDocument()
    })
  })

  // ── MED-10 · window label on the "Total cost" KPI ────────────────────────────

  it('MED-10: shows the active window next to the Total cost KPI (default 7d)', async () => {
    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)
    await waitFor(() => expect(screen.getByText('Total Cost')).toBeInTheDocument())
    expect(screen.getByTestId('kpi-window-label')).toHaveTextContent('Last 7 days')
  })

  // ── MED-11 · app-level auto-refresh on real broadcasts ───────────────────────

  it('MED-11: refetches on spending.invalidated (any project) and rail.job_completed', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)
    await waitFor(() => expect(screen.getByText('Total Cost')).toBeInTheDocument())

    const before = fetchMock.mock.calls.length
    // Cross-project page: a spend broadcast from ANY project must refetch.
    wsMock.emit({ type: 'spending.invalidated', projectId: 'some-other-project' })
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before))

    const mid = fetchMock.mock.calls.length
    wsMock.emit({ type: 'rail.job_completed', projectId: 'x', jobId: 'j', status: 'completed' })
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(mid))
  })

  it('MED-11: ignores the legacy log/job_done message the server never emits', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)
    await waitFor(() => expect(screen.getByText('Total Cost')).toBeInTheDocument())

    const before = fetchMock.mock.calls.length
    wsMock.emit({ type: 'log', event_type: 'job_done' })
    // Give any (erroneous) refetch a chance to fire, then assert none did.
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('does NOT mark anything estimated on a claude-only rollup (legacy)', async () => {
    // mockAnalyticsData has no estimated fields → byte-identical legacy behaviour
    const DesktopAnalyticsPage = (await import('../DesktopAnalyticsPage')).default
    render(<DesktopAnalyticsPage />)

    await waitFor(() => {
      expect(screen.getByText('$2.5000')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('kpi-estimated-footnote')).not.toBeInTheDocument()
    expect(screen.queryByTestId('timeline-estimated-note')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-estimated-badge')).not.toBeInTheDocument()
    // No ~-prefixed figure anywhere
    expect(screen.queryByText(/^~\$/)).not.toBeInTheDocument()
  })
})
