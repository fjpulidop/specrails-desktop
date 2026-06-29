import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '../../../test-utils'
import { CostScatter } from '../CostScatter'
import type { SpendingResponse } from '../../../types/spending'

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScatterChart: ({ children }: { children: React.ReactNode }) => <div data-testid="scatter-chart">{children}</div>,
  Scatter: ({ data }: { data: unknown[] }) => <div data-testid={`scatter-set-${data.length}`} />,
  XAxis: () => <div />,
  YAxis: () => <div />,
  CartesianGrid: () => <div />,
  Tooltip: () => <div />,
  ZAxis: () => <div />,
}))

function emptyData(
  scatter: SpendingResponse['scatter'] = [],
  over: Partial<SpendingResponse> = {}
): SpendingResponse {
  return {
    summary: {
      totalCostUsd: 0, totalEstimatedCostUsd: 0, totalTokens: 0, totalRuns: 0,
      failureRate: 0, prevTotalCostUsd: 0, deltaPct: null, avgCostPerRun: null,
    },
    bySurface: [], byModel: [], byMode: [], byProvider: [], dailyTimeline: [],
    scatter, scatterTotal: scatter.length, scatterTruncated: false, topTickets: [],
    trackingStartedAt: null, rangeFrom: '', rangeTo: '',
    ...over,
  }
}

describe('CostScatter', () => {
  it('renders skeleton when loading without data', () => {
    const { container } = render(<CostScatter data={null} loading onSelectPoint={() => {}} />)
    expect(container.querySelector('.animate-pulse')).toBeTruthy()
  })

  it('returns null when no data', () => {
    const { container } = render(<CostScatter data={null} loading={false} onSelectPoint={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders empty state when no scatter points', () => {
    render(<CostScatter data={emptyData([])} loading={false} onSelectPoint={() => {}} />)
    expect(screen.getByText(/No invocations to plot/i)).toBeInTheDocument()
  })

  it('groups points by surface and renders one Scatter per surface', () => {
    const scatter: SpendingResponse['scatter'] = [
      { id: '1', surface: 'job', costUsd: 1, numTurns: 3, durationMs: 1000, ticketId: null, startedAt: '2026-05-06T00:00:00Z' },
      { id: '2', surface: 'job', costUsd: 2, numTurns: 4, durationMs: 1500, ticketId: 7, startedAt: '2026-05-06T00:00:00Z' },
      { id: '3', surface: 'explore-spec', costUsd: 0.5, numTurns: null, durationMs: 5000, ticketId: 7, startedAt: '2026-05-06T00:00:00Z' },
    ]
    render(<CostScatter data={emptyData(scatter)} loading={false} onSelectPoint={() => {}} />)
    expect(screen.getByTestId('scatter-chart')).toBeInTheDocument()
    expect(screen.getByTestId('scatter-set-2')).toBeInTheDocument() // 2 jobs
    expect(screen.getByTestId('scatter-set-1')).toBeInTheDocument() // 1 explore
  })

  it('BUG-ANALYTICS-15: plots file-summary + loop points (previously dropped)', () => {
    const scatter: SpendingResponse['scatter'] = [
      { id: 'f1', surface: 'file-summary', costUsd: 0.2, numTurns: 1, durationMs: 800, ticketId: null, startedAt: '2026-05-06T00:00:00Z' },
      { id: 'l1', surface: 'loop', costUsd: 1.1, numTurns: 5, durationMs: 9000, ticketId: 9, startedAt: '2026-05-06T00:00:00Z' },
      { id: 'l2', surface: 'loop', costUsd: 0.9, numTurns: 3, durationMs: 4000, ticketId: 9, startedAt: '2026-05-06T00:00:00Z' },
    ]
    render(<CostScatter data={emptyData(scatter)} loading={false} onSelectPoint={() => {}} />)
    // one Scatter set with the 2 loop points, one with the 1 file-summary point.
    expect(screen.getByTestId('scatter-set-2')).toBeInTheDocument() // 2 loops
    expect(screen.getByTestId('scatter-set-1')).toBeInTheDocument() // 1 file-summary
    // legend now lists both surfaces.
    expect(screen.getByText('Loops')).toBeInTheDocument()
    expect(screen.getByText('File summaries')).toBeInTheDocument()
  })

  it('BUG-ANALYTICS-34: shows a truncation notice when the scatter was recency-capped', () => {
    const scatter: SpendingResponse['scatter'] = [
      { id: '1', surface: 'job', costUsd: 1, numTurns: 3, durationMs: 1000, ticketId: null, startedAt: '2026-05-06T00:00:00Z' },
    ]
    render(
      <CostScatter
        data={emptyData(scatter, { scatterTotal: 873, scatterTruncated: true })}
        loading={false}
        onSelectPoint={() => {}}
      />
    )
    expect(screen.getByTestId('scatter-truncation-notice')).toBeInTheDocument()
  })

  it('BUG-ANALYTICS-34: no truncation notice when not truncated', () => {
    const scatter: SpendingResponse['scatter'] = [
      { id: '1', surface: 'job', costUsd: 1, numTurns: 3, durationMs: 1000, ticketId: null, startedAt: '2026-05-06T00:00:00Z' },
    ]
    render(<CostScatter data={emptyData(scatter)} loading={false} onSelectPoint={() => {}} />)
    expect(screen.queryByTestId('scatter-truncation-notice')).not.toBeInTheDocument()
  })
})
