import { describe, it, expect } from 'vitest'
import { render, screen } from '../../../test-utils'
import { ProviderBreakdownCard } from '../ProviderBreakdownCard'
import type { SpendingResponse, ByProviderEntry } from '../../../types/spending'

function makeProvider(overrides: Partial<ByProviderEntry>): ByProviderEntry {
  return {
    provider: 'claude',
    count: 0,
    costUsd: 0,
    estimatedCostUsd: 0,
    ...overrides,
  }
}

function makeData(byProvider: ByProviderEntry[]): SpendingResponse {
  return {
    summary: {
      totalCostUsd: 0,
      totalEstimatedCostUsd: 0,
      totalTokens: 0,
      totalRuns: 0,
      failureRate: 0,
      prevTotalCostUsd: 0,
      deltaPct: null,
      avgCostPerRun: null,
    },
    bySurface: [],
    byModel: [],
    byMode: [],
    byProvider,
    dailyTimeline: [],
    scatter: [],
    topTickets: [],
    trackingStartedAt: null,
    rangeFrom: '',
    rangeTo: '',
  }
}

describe('ProviderBreakdownCard', () => {
  it('renders a pulse skeleton while loading without data', () => {
    const { container } = render(<ProviderBreakdownCard data={null} loading={true} />)
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument()
    expect(screen.queryByText('By provider')).not.toBeInTheDocument()
  })

  it('renders nothing when data is null and not loading', () => {
    const { container } = render(<ProviderBreakdownCard data={null} loading={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when byProvider is empty', () => {
    const { container } = render(
      <ProviderBreakdownCard data={makeData([])} loading={false} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for single-provider projects', () => {
    const data = makeData([
      makeProvider({ provider: 'claude', count: 10, costUsd: 5 }),
    ])
    const { container } = render(<ProviderBreakdownCard data={data} loading={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders title, bar segments and provider rows for multi-provider data', () => {
    const data = makeData([
      makeProvider({ provider: 'claude', count: 12, costUsd: 150 }),
      makeProvider({ provider: 'codex', count: 1, costUsd: 0, estimatedCostUsd: 12.34 }),
    ])
    const { container } = render(<ProviderBreakdownCard data={data} loading={false} />)

    expect(screen.getByText('By provider')).toBeInTheDocument()
    // Description with the <tilde>~</tilde> Trans component
    expect(
      screen.getByText(/How cost splits across the AI CLIs in this project/),
    ).toBeInTheDocument()

    // Rows: known providers map to friendly labels
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()

    // Pluralised run counts (English locale)
    expect(screen.getByText('12 runs')).toBeInTheDocument()
    expect(screen.getByText('1 run')).toBeInTheDocument()

    // fmtUsd branches: >= 100 → no decimals; >= 10 → one decimal
    expect(screen.getByText('$150')).toBeInTheDocument()
    // codex row is fully estimated → tilde prefix
    expect(screen.getByText('~$12.3')).toBeInTheDocument()

    // Stacked bar: one segment per provider with a cost, titled label: value (count)
    const claudeSegment = container.querySelector('[title="Claude: $150 (12)"]')
    // codex is wholly estimated → tooltip carries the ~ marker (BUG-ANALYTICS-10)
    const codexSegment = container.querySelector('[title="Codex: ~$12.3 (1)"]')
    expect(claudeSegment).toBeInTheDocument()
    expect(codexSegment).toBeInTheDocument()
    expect(claudeSegment).toHaveClass('bg-accent-info')
    expect(codexSegment).toHaveClass('bg-accent-highlight')
  })

  it('falls back to the raw id and secondary accent for unknown providers', () => {
    const data = makeData([
      makeProvider({ provider: 'claude', count: 2, costUsd: 0.5 }),
      makeProvider({ provider: 'mystery', count: 3, costUsd: 0.005 }),
    ])
    const { container } = render(<ProviderBreakdownCard data={data} loading={false} />)

    expect(screen.getByText('mystery')).toBeInTheDocument()
    // fmtUsd branches: >= 0.01 → two decimals; tiny → four decimals
    expect(screen.getByText('$0.50')).toBeInTheDocument()
    expect(screen.getByText('$0.0050')).toBeInTheDocument()
    const segment = container.querySelector('[title="mystery: $0.0050 (3)"]')
    expect(segment).toBeInTheDocument()
    expect(segment).toHaveClass('bg-accent-secondary')
  })

  it('shows the no-cost message when every provider has zero cost', () => {
    const data = makeData([
      makeProvider({ provider: 'claude', count: 4, pricedCount: 4, unpricedCount: 0 }),
      makeProvider({ provider: 'codex', count: 2, pricedCount: 2, unpricedCount: 0 }),
    ])
    render(<ProviderBreakdownCard data={data} loading={false} />)
    expect(screen.getByText('No cost recorded yet in this window.')).toBeInTheDocument()
    // Exact coverage says these are real priced zeroes, so the provider rows
    // remain available even though there is no stacked cost bar.
    expect(screen.getByText('Claude')).toBeInTheDocument()
  })

  it('skips the bar segment (but keeps the row) for a provider with zero cost', () => {
    const data = makeData([
      makeProvider({ provider: 'claude', count: 5, costUsd: 10 }),
      makeProvider({ provider: 'codex', count: 3, costUsd: 0, estimatedCostUsd: 0 }),
    ])
    const { container } = render(<ProviderBreakdownCard data={data} loading={false} />)

    // Only one segment in the stacked bar (codex pct === 0 → skipped)
    const segments = container.querySelectorAll('[title*=":"]')
    expect(segments).toHaveLength(1)
    expect(segments[0]).toHaveAttribute('title', 'Claude: $10.0 (5)')

    // Both rows still render
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
  })

  it('renders a cost-unavailable affordance instead of $0.0000 for an unpriced codex provider (BUG-ANALYTICS-09)', () => {
    const data = makeData([
      makeProvider({ provider: 'claude', count: 5, costUsd: 10 }),
      // real runs, but no priced and no estimated cost → model absent from pricing table
      makeProvider({ provider: 'codex', count: 40, costUsd: 0, estimatedCostUsd: 0 }),
    ])
    render(<ProviderBreakdownCard data={data} loading={false} />)

    // The misleading authoritative $0 is gone
    expect(screen.queryByText('$0.0000')).not.toBeInTheDocument()
    expect(screen.queryByText('~$0.0000')).not.toBeInTheDocument()
    // The codex run count is still shown so the row is not silently empty
    expect(screen.getByText('40 runs')).toBeInTheDocument()
  })

  it('uses exact coverage counters for a Kimi-only-unpriced provider row', () => {
    const data = makeData([
      makeProvider({ provider: 'claude', count: 2, costUsd: 1, pricedCount: 2, unpricedCount: 0 }),
      makeProvider({ provider: 'kimi', count: 3, pricedCount: 0, unpricedCount: 3 }),
    ])
    render(<ProviderBreakdownCard data={data} loading={false} />)
    expect(screen.getByText('Kimi')).toBeInTheDocument()
    expect(screen.getByText('cost unavailable')).toBeInTheDocument()
    expect(screen.queryByText('$0.0000')).not.toBeInTheDocument()
  })

  it('labels a mixed provider value as a known subtotal', () => {
    const data = makeData([
      makeProvider({ provider: 'claude', count: 1, costUsd: 1 }),
      makeProvider({
        provider: 'kimi',
        count: 2,
        costUsd: 0.5,
        pricedCount: 1,
        unpricedCount: 1,
      }),
    ])
    render(<ProviderBreakdownCard data={data} loading={false} />)
    expect(screen.getByText(/1 unavailable/)).toBeInTheDocument()
  })

  it('prefixes ~ on the bar-segment tooltip for an estimated-only provider (BUG-ANALYTICS-10)', () => {
    const data = makeData([
      makeProvider({ provider: 'claude', count: 5, costUsd: 10 }),
      makeProvider({ provider: 'codex', count: 3, costUsd: 0, estimatedCostUsd: 4 }),
    ])
    const { container } = render(<ProviderBreakdownCard data={data} loading={false} />)

    // Estimated-only codex segment tooltip carries the ~, mirroring the legend row
    const codexSegment = container.querySelector('[title^="Codex:"]')
    expect(codexSegment).toBeInTheDocument()
    expect(codexSegment!.getAttribute('title')).toMatch(/Codex: ~\$/)
    // Authoritative claude segment has no ~
    const claudeSegment = container.querySelector('[title^="Claude:"]')
    expect(claudeSegment!.getAttribute('title')).not.toMatch(/~/)
  })
})
