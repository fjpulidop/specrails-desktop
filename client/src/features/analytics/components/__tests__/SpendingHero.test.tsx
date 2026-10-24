import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '../../../../test-utils'
import { SpendingHero } from '../SpendingHero'
import type { SpendingResponse } from '../../types/spending'

const baseData: SpendingResponse = {
  summary: {
    totalCostUsd: 12.34, totalEstimatedCostUsd: 0, totalTokens: 0, totalRuns: 42,
    failureRate: 0, prevTotalCostUsd: 10, deltaPct: 23.4, avgCostPerRun: null,
  },
  bySurface: [
    { surface: 'job', count: 30, costUsd: 8 },
    { surface: 'quick-spec', count: 5, costUsd: 1 },
    { surface: 'explore-spec', count: 5, costUsd: 3 },
    { surface: 'ai-edit', count: 2, costUsd: 0.34 },
  ],
  byModel: [], byMode: [], byProvider: [], dailyTimeline: [], scatter: [],
  scatterTotal: 0, scatterTruncated: false, topTickets: [],
  trackingStartedAt: '2026-04-01T00:00:00Z', rangeFrom: '', rangeTo: '',
}

describe('SpendingHero', () => {
  it('renders skeleton when loading and no data', () => {
    const { container } = render(<SpendingHero data={null} loading />)
    expect(container.querySelector('[data-skeleton]')).toBeTruthy()
  })

  it('renders empty state when no runs', () => {
    const empty: SpendingResponse = { ...baseData, summary: { ...baseData.summary, totalCostUsd: 0, totalRuns: 0 }, bySurface: [] }
    render(<SpendingHero data={empty} loading={false} />)
    expect(screen.getByText(/No invocations yet/i)).toBeInTheDocument()
    expect(screen.getAllByText(/Tracking started 2026-04-01/i).length).toBeGreaterThan(0)
  })

  it('renders total cost and surface segments', () => {
    render(<SpendingHero data={baseData} loading={false} />)
    expect(screen.getByText(/42 invocations/)).toBeInTheDocument()
    // Surface labels visible (rendered after the bar)
    expect(screen.getByText('Jobs')).toBeInTheDocument()
    expect(screen.getByText('Explore')).toBeInTheDocument()
  })

  it('renders unavailable — not $0 — when Kimi exposes neither cost nor usage', () => {
    const data: SpendingResponse = {
      ...baseData,
      summary: {
        ...baseData.summary,
        totalCostUsd: 0,
        totalTokens: null,
        totalRuns: 2,
        pricedRuns: 0,
        unpricedRuns: 2,
        usageReportedRuns: 0,
        usageUnavailableRuns: 2,
        deltaPct: null,
      },
      bySurface: [{ surface: 'job', count: 2, costUsd: 0, unpricedCount: 2 }],
    }
    render(<SpendingHero data={data} loading={false} />)
    expect(screen.getByTestId('hero-cost-unavailable')).toHaveTextContent('—')
    expect(screen.getByTestId('hero-usage-unavailable')).toHaveTextContent('token usage unavailable')
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
  })

  it('marks mixed Claude + Kimi totals as known partial telemetry', () => {
    const data: SpendingResponse = {
      ...baseData,
      summary: {
        ...baseData.summary,
        totalCostUsd: 1.25,
        totalTokens: 125,
        totalRuns: 2,
        pricedRuns: 1,
        unpricedRuns: 1,
        usageReportedRuns: 1,
        usageUnavailableRuns: 1,
      },
    }
    render(<SpendingHero data={data} loading={false} />)
    expect(screen.getByTestId('hero-cost-partial')).toHaveTextContent('known subtotal')
    expect(screen.getByText(/125 known tokens/i)).toBeInTheDocument()
  })

  it('renders positive delta with warning accent and arrow up', () => {
    render(<SpendingHero data={baseData} loading={false} />)
    expect(screen.getByText(/23% vs prev/)).toBeInTheDocument()
  })

  it('renders negative delta with success accent and arrow down', () => {
    const data = { ...baseData, summary: { ...baseData.summary, deltaPct: -10 } }
    render(<SpendingHero data={data} loading={false} />)
    expect(screen.getByText(/10% vs prev/)).toBeInTheDocument()
  })

  it('BUG-ANALYTICS-14: includes file-summary + loop in segments so the bar fills 100%', () => {
    // total = 10; the four "legacy" surfaces only sum to 6, the remaining 4 is
    // file-summary + loop. Before the fix those were dropped → bar < 100%.
    const data: SpendingResponse = {
      ...baseData,
      summary: { ...baseData.summary, totalCostUsd: 10, totalRuns: 10 },
      bySurface: [
        { surface: 'job', count: 3, costUsd: 4 },
        { surface: 'quick-spec', count: 1, costUsd: 2 },
        { surface: 'file-summary', count: 2, costUsd: 1.5 },
        { surface: 'loop', count: 4, costUsd: 2.5 },
      ],
    }
    const { container } = render(<SpendingHero data={data} loading={false} />)
    // The coloured segments live inside the rounded bar; their widths must sum
    // to ~100% now that file-summary + loop participate.
    const segs = Array.from(container.querySelectorAll<HTMLElement>('.h-3 > div'))
    const totalWidth = segs.reduce((acc, el) => {
      const m = /width:\s*([\d.]+)%/.exec(el.getAttribute('style') ?? '')
      return acc + (m ? Number(m[1]) : 0)
    }, 0)
    expect(Math.round(totalWidth)).toBe(100)
    // Loop legend value renders (this surface was previously omitted entirely).
    expect(screen.getByText('Loops')).toBeInTheDocument()
    expect(screen.getByText('File summaries')).toBeInTheDocument()
  })

  describe('honest first paint', () => {
    it('never renders a $0.00 placeholder before the real total: skeleton, then the figure', () => {
      const { rerender, container } = render(<SpendingHero data={null} loading={true} />)
      expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
      expect(container.textContent).not.toMatch(/\$/)
      const data: SpendingResponse = { ...baseData, summary: { ...baseData.summary, totalCostUsd: 40 } }
      rerender(<SpendingHero data={data} loading={false} />)
      expect(screen.getByText('$40.00')).toBeInTheDocument()
      const fresher: SpendingResponse = { ...baseData, summary: { ...baseData.summary, totalCostUsd: 41 } }
      rerender(<SpendingHero data={fresher} loading={false} />)
      expect(screen.getByText('$41.00')).toBeInTheDocument()
    })
  })

  describe('MED-9 · window label', () => {
    it('renders the active window next to the amount so a 30d figure is not read as all-time', () => {
      render(<SpendingHero data={baseData} loading={false} period="30d" />)
      expect(screen.getByTestId('hero-window-label')).toHaveTextContent('Last 30 days')
    })

    it('omits the window label when no period is supplied', () => {
      render(<SpendingHero data={baseData} loading={false} />)
      expect(screen.queryByTestId('hero-window-label')).not.toBeInTheDocument()
    })
  })

  it('tolerates an unknown server surface: labels it with its raw id and never crashes', () => {
    const data = {
      ...baseData,
      summary: { ...baseData.summary, totalCostUsd: 5, totalRuns: 5 },
      bySurface: [
        { surface: 'job', count: 3, costUsd: 3 },
        // A surface id this build's Surface union does not know about.
        { surface: 'future-surface', count: 2, costUsd: 2 },
      ],
    } as unknown as SpendingResponse
    render(<SpendingHero data={data} loading={false} />)
    // The unknown surface is still itemised (neutral fallback label = raw id).
    expect(screen.getByText('future-surface')).toBeInTheDocument()
  })
})
