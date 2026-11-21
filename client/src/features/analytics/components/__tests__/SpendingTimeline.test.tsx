import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '../../../../test-utils'
import { SpendingTimeline } from '../SpendingTimeline'
import type { SpendingResponse, DailyEntry } from '../../types/spending'

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ children, data }: { children: React.ReactNode; data: unknown }) => <div data-testid="bar-chart" data-chart={JSON.stringify(data)}>{children}</div>,
  Bar: ({ dataKey, fill }: { dataKey: string; fill: string }) => <div data-testid="bar" data-key={dataKey} data-fill={fill} />,
  XAxis: () => <div />,
  YAxis: () => <div />,
  Tooltip: () => <div />,
  CartesianGrid: () => <div />,
  Legend: () => <div data-testid="legend" />,
}))

function day(date: string, over: Partial<DailyEntry> = {}): DailyEntry {
  return {
    date,
    jobsCostUsd: 0,
    quickCostUsd: 0,
    exploreCostUsd: 0,
    aiEditCostUsd: 0,
    smashCostUsd: 0,
    fileSummaryCostUsd: 0,
    loopCostUsd: 0,
    totalCostUsd: 0,
    ...over,
  }
}

function emptyData(daily: SpendingResponse['dailyTimeline'] = []): SpendingResponse {
  return {
    summary: {
      totalCostUsd: 0, totalEstimatedCostUsd: 0, totalTokens: 0, totalRuns: 0,
      failureRate: 0, prevTotalCostUsd: 0, deltaPct: null, avgCostPerRun: null,
    },
    bySurface: [], byModel: [], byMode: [], byProvider: [],
    dailyTimeline: daily, scatter: [], scatterTotal: 0, scatterTruncated: false,
    topTickets: [], trackingStartedAt: null, rangeFrom: '', rangeTo: '',
  }
}

describe('SpendingTimeline', () => {
  it('renders skeleton when loading without data', () => {
    const { container } = render(<SpendingTimeline data={null} loading />)
    expect(container.querySelector('[data-skeleton]')).toBeTruthy()
  })

  it('returns null when no data and not loading', () => {
    const { container } = render(<SpendingTimeline data={null} loading={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders empty state when timeline has all zeros', () => {
    const data = emptyData([
      day('2026-05-01'),
    ])
    render(<SpendingTimeline data={data} loading={false} />)
    expect(screen.getByText(/No spend in this period/i)).toBeInTheDocument()
  })

  it('distinguishes unavailable Kimi cost telemetry from a real no-spend period', () => {
    const data = emptyData([
      day('2026-05-01', { unpricedCount: 2 }),
    ])
    render(<SpendingTimeline data={data} loading={false} />)
    expect(screen.getByTestId('timeline-cost-unavailable')).toHaveTextContent(/cost telemetry is unavailable/i)
    expect(screen.queryByText(/No spend in this period/i)).not.toBeInTheDocument()
  })

  it('stacks by category and draws only the categories with spend in the window', () => {
    const data = emptyData([
      day('2026-05-01', { jobsCostUsd: 5, totalCostUsd: 5 }),
      day('2026-05-02', { quickCostUsd: 1, exploreCostUsd: 2, aiEditCostUsd: 0.5, totalCostUsd: 3.5 }),
    ])
    render(<SpendingTimeline data={data} loading={false} />)
    const bars = screen.getAllByTestId('bar')
    expect(bars.map((b) => b.getAttribute('data-key'))).toEqual(['Implementation', 'Specs'])
    // No two series share a colour.
    const fills = bars.map((b) => b.getAttribute('data-fill'))
    expect(new Set(fills).size).toBe(fills.length)
    expect(screen.getByTestId('legend')).toBeInTheDocument()
  })

  it('prefers the server per-day category split', () => {
    const data = emptyData([day('2026-05-01', {
      jobsCostUsd: 1, totalCostUsd: 3,
      byCategory: { implementation: 1, missions: 0, specs: 0, code: 0, support: 2 },
    })])
    render(<SpendingTimeline data={data} loading={false} />)
    const chart = JSON.parse(screen.getByTestId('bar-chart').getAttribute('data-chart') ?? '[]') as Array<Record<string, number>>
    expect(chart[0]).toMatchObject({ Implementation: 1, Support: 2 })
    expect(screen.getAllByTestId('bar').map((b) => b.getAttribute('data-key'))).toEqual(['Implementation', 'Support'])
  })

  it('folds surfaces without a legacy field into Support so each day reconciles with its total', () => {
    const data = emptyData([day('2026-05-01', { jobsCostUsd: 4, totalCostUsd: 10 })])
    render(<SpendingTimeline data={data} loading={false} />)
    const chart = JSON.parse(screen.getByTestId('bar-chart').getAttribute('data-chart') ?? '[]') as Array<Record<string, number>>
    expect(chart[0].Support).toBeCloseTo(6)
  })

  it('BUG-ANALYTICS-13: renders the chart (not empty) for a smash-only day', () => {
    const data = emptyData([day('2026-05-01', { smashCostUsd: 4, totalCostUsd: 4 })])
    render(<SpendingTimeline data={data} loading={false} />)
    expect(screen.queryByText(/No spend in this period/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument()
  })

  it('BUG-ANALYTICS-13: renders the chart (not empty) for a loop-only day (codex/gemini)', () => {
    const data = emptyData([day('2026-05-01', { loopCostUsd: 3, totalCostUsd: 3 })])
    render(<SpendingTimeline data={data} loading={false} />)
    expect(screen.queryByText(/No spend in this period/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument()
  })

  it('labels the axis in the viewer language ("25 Sep"), not a raw MM-DD slice', () => {
    render(<SpendingTimeline data={emptyData([day('2026-09-25', { jobsCostUsd: 1, totalCostUsd: 1 })])} loading={false} />)
    const chart = JSON.parse(screen.getByTestId('bar-chart').getAttribute('data-chart')!)
    expect(chart[0].date).toBe('25 Sep')
  })
})
