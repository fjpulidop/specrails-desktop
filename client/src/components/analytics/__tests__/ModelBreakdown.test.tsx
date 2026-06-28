import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '../../../test-utils'
import { ModelBreakdown } from '../ModelBreakdown'
import type { SpendingResponse, ByModelEntry } from '../../../types/spending'

type PartialModel = Partial<ByModelEntry> & Pick<ByModelEntry, 'model' | 'count' | 'costUsd'>

function model(m: PartialModel): ByModelEntry {
  return { provider: 'claude', estimatedCostUsd: 0, ...m }
}

function emptyData(byModel: PartialModel[] = []): SpendingResponse {
  return {
    summary: { totalCostUsd: 0, totalRuns: 0, failureRate: 0, prevTotalCostUsd: 0, deltaPct: null, avgCostPerRun: null },
    bySurface: [], byModel: byModel.map(model), byMode: [], dailyTimeline: [], scatter: [], topTickets: [],
    trackingStartedAt: null, rangeFrom: '', rangeTo: '',
  } as unknown as SpendingResponse
}

describe('ModelBreakdown', () => {
  it('renders skeleton when loading without data', () => {
    const { container } = render(<ModelBreakdown data={null} loading onSelectModel={() => {}} activeModel={undefined} />)
    expect(container.querySelector('.animate-pulse')).toBeTruthy()
  })

  it('renders empty state when no models', () => {
    render(<ModelBreakdown data={emptyData()} loading={false} onSelectModel={() => {}} activeModel={undefined} />)
    expect(screen.getByText(/No models recorded/i)).toBeInTheDocument()
  })

  it('renders top models with cost and count', () => {
    const data = emptyData([
      { model: 'opus', count: 10, costUsd: 8 },
      { model: 'sonnet', count: 50, costUsd: 2 },
    ])
    render(<ModelBreakdown data={data} loading={false} onSelectModel={() => {}} activeModel={undefined} />)
    expect(screen.getByText('opus')).toBeInTheDocument()
    expect(screen.getByText('sonnet')).toBeInTheDocument()
    expect(screen.getByText(/\$8\.00 · 10/)).toBeInTheDocument()
  })

  it('fires onSelectModel with the model and its provider when clicked', () => {
    const onSelect = vi.fn()
    const data = emptyData([{ model: 'opus', count: 10, costUsd: 8 }])
    render(<ModelBreakdown data={data} loading={false} onSelectModel={onSelect} activeModel={undefined} />)
    fireEvent.click(screen.getByText('opus').closest('button')!)
    expect(onSelect).toHaveBeenCalledWith('opus', 'claude')
  })

  it('passes the codex provider on click so the dashboard can scope to one engine (BUG-ANALYTICS-30)', () => {
    const onSelect = vi.fn()
    const data = emptyData([{ model: 'gpt-5.5', provider: 'codex', count: 4, costUsd: 1.2, estimatedCostUsd: 1.2 }])
    render(<ModelBreakdown data={data} loading={false} onSelectModel={onSelect} activeModel={undefined} />)
    fireEvent.click(screen.getByText('gpt-5.5').closest('button')!)
    expect(onSelect).toHaveBeenCalledWith('gpt-5.5', 'codex')
  })

  it('prefixes ~ for a wholly-estimated codex model and not for a claude model (BUG-ANALYTICS-08/29)', () => {
    const data = emptyData([
      { model: 'gpt-5.5', provider: 'codex', count: 4, costUsd: 3, estimatedCostUsd: 3 },
      { model: 'opus', provider: 'claude', count: 2, costUsd: 5, estimatedCostUsd: 0 },
    ])
    render(<ModelBreakdown data={data} loading={false} onSelectModel={() => {}} activeModel={undefined} />)
    // estimated codex model carries the ~ marker
    expect(screen.getByText(/~\$3\.00 · 4/)).toBeInTheDocument()
    // authoritative claude model has no ~
    expect(screen.getByText(/\$5\.00 · 2/)).toBeInTheDocument()
    expect(screen.queryByText(/~\$5\.00 · 2/)).not.toBeInTheDocument()
  })

  it('marks the active model with highlight styling', () => {
    const data = emptyData([
      { model: 'opus', count: 10, costUsd: 8 },
      { model: 'sonnet', count: 50, costUsd: 2 },
    ])
    render(<ModelBreakdown data={data} loading={false} onSelectModel={() => {}} activeModel="opus" />)
    const button = screen.getByText('opus').closest('button')!
    expect(button.className).toMatch(/accent-highlight/)
  })

  it('caps to top 5 models', () => {
    const data = emptyData(
      Array.from({ length: 8 }, (_, i) => ({ model: `m-${i}`, count: i + 1, costUsd: i + 1 }))
    )
    render(<ModelBreakdown data={data} loading={false} onSelectModel={() => {}} activeModel={undefined} />)
    expect(screen.queryByText('m-5')).not.toBeInTheDocument()
    expect(screen.getByText('m-0')).toBeInTheDocument()
  })
})
