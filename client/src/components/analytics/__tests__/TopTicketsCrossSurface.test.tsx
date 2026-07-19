import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '../../../test-utils'
import { TopTicketsCrossSurface } from '../TopTicketsCrossSurface'
import type { SpendingResponse } from '../../../types/spending'

function emptyData(): SpendingResponse {
  return {
    summary: { totalCostUsd: 0, totalRuns: 0, failureRate: 0, prevTotalCostUsd: 0, deltaPct: null, avgCostPerRun: null },
    bySurface: [], byModel: [], byMode: [], dailyTimeline: [], scatter: [], topTickets: [],
    trackingStartedAt: null, rangeFrom: '', rangeTo: '',
  }
}

describe('TopTicketsCrossSurface', () => {
  it('renders empty state', () => {
    render(<TopTicketsCrossSurface data={emptyData()} loading={false} onSelectTicket={() => {}} />)
    expect(screen.getByText(/No ticket activity/i)).toBeInTheDocument()
  })

  it('renders top tickets and dispatches click', () => {
    const onSelect = vi.fn()
    const data = emptyData()
    data.topTickets = [
      {
        ticketId: 7, ticketTitle: 'auth refactor', totalCostUsd: 14.2, totalRuns: 3,
        bySurface: { job: { count: 2, costUsd: 10 }, 'quick-spec': { count: 0, costUsd: 0 }, 'explore-spec': { count: 1, costUsd: 4.2 }, 'ai-edit': { count: 0, costUsd: 0 } },
      },
      {
        ticketId: null, ticketTitle: null, totalCostUsd: 1, totalRuns: 1,
        bySurface: { job: { count: 0, costUsd: 0 }, 'quick-spec': { count: 1, costUsd: 1 }, 'explore-spec': { count: 0, costUsd: 0 }, 'ai-edit': { count: 0, costUsd: 0 } },
        isUnattributed: true,
      },
    ]
    render(<TopTicketsCrossSurface data={data} loading={false} onSelectTicket={onSelect} />)
    expect(screen.getByText(/auth refactor/)).toBeInTheDocument()
    expect(screen.getByText(/Unattributed/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/auth refactor/).closest('button')!)
    expect(onSelect).toHaveBeenCalledWith(7)
  })

  it('renders deleted ticket dimly when title missing', () => {
    const onSelect = vi.fn()
    const data = emptyData()
    data.topTickets = [
      {
        ticketId: 99, ticketTitle: null, totalCostUsd: 2, totalRuns: 1,
        bySurface: { job: { count: 1, costUsd: 2 }, 'quick-spec': { count: 0, costUsd: 0 }, 'explore-spec': { count: 0, costUsd: 0 }, 'ai-edit': { count: 0, costUsd: 0 } },
      },
    ]
    render(<TopTicketsCrossSurface data={data} loading={false} onSelectTicket={onSelect} />)
    expect(screen.getByText(/deleted ticket #99/)).toBeInTheDocument()
  })

  it('renders unavailable rather than $0.00 for an all-Kimi ticket', () => {
    const data = emptyData()
    data.topTickets = [{
      ticketId: 3,
      ticketTitle: 'Kimi task',
      totalCostUsd: 0,
      totalRuns: 2,
      unpricedCount: 2,
      bySurface: {
        job: { count: 2, costUsd: 0, unpricedCount: 2 },
      } as SpendingResponse['topTickets'][number]['bySurface'],
    }]
    render(<TopTicketsCrossSurface data={data} loading={false} onSelectTicket={() => {}} />)
    expect(screen.getByText('cost unavailable')).toBeInTheDocument()
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
  })
})
