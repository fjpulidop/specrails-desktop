import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '../../test-utils'
import { TicketSpendingLine } from '../TicketSpendingLine'

vi.mock('../../lib/api', () => ({
  getApiBase: () => '/api/projects/p1',
}))

const navigateMock = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => {
  const mod = await importOriginal<typeof import('react-router-dom')>()
  return { ...mod, useNavigate: () => navigateMock }
})

const closeTicketDetailMock = vi.fn()
vi.mock('../../context/TicketDetailModalContext', () => ({
  useTicketDetailModal: () => ({
    openTicketDetail: vi.fn(),
    closeTicketDetail: closeTicketDetailMock,
  }),
}))

describe('TicketSpendingLine', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders nothing when summary has zero runs', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        totalCostUsd: 0, totalTurns: 0, activeDurationMs: 0, totalRuns: 0,
        bySurface: { job: { count: 0, costUsd: 0 }, 'quick-spec': { count: 0, costUsd: 0 }, 'explore-spec': { count: 0, costUsd: 0 }, 'ai-edit': { count: 0, costUsd: 0 } },
      }),
    })
    const { container } = render(<TicketSpendingLine ticketId={1} />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('renders cost / turns / duration / breakdown when summary has runs', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        totalCostUsd: 4.2,
        totalTurns: 12,
        activeDurationMs: 204000,
        totalRuns: 4,
        bySurface: {
          job: { count: 2, costUsd: 3.5 },
          'quick-spec': { count: 0, costUsd: 0 },
          'explore-spec': { count: 1, costUsd: 0.5 },
          'ai-edit': { count: 1, costUsd: 0.2 },
        },
      }),
    })
    render(<TicketSpendingLine ticketId={42} />)
    await waitFor(() => expect(screen.getByText(/\$4\.20/)).toBeInTheDocument())
    expect(screen.getByText(/12 turns/)).toBeInTheDocument()
    expect(screen.getByText(/3m/)).toBeInTheDocument()
    expect(screen.getByText(/2 jobs/)).toBeInTheDocument()
    const button = screen.getByRole('button') as HTMLButtonElement
    expect(button.getAttribute('aria-label')).toBe('View ticket spending in Analytics')

    // Clicking navigates and closes the modal
    fireEvent.click(button)
    expect(closeTicketDetailMock).toHaveBeenCalled()
    expect(navigateMock).toHaveBeenCalledWith('/analytics?ticketId=42')
  })

  it('prefixes ~ when the ticket cost is wholly/partly estimated (codex) — BUG-ANALYTICS-12', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        totalCostUsd: 2.5,
        estimatedCostUsd: 2.5,
        totalTurns: 6,
        activeDurationMs: 30000,
        totalRuns: 2,
        bySurface: { job: { count: 2, costUsd: 2.5 }, 'quick-spec': { count: 0, costUsd: 0 }, 'explore-spec': { count: 0, costUsd: 0 }, 'ai-edit': { count: 0, costUsd: 0 } },
      }),
    })
    render(<TicketSpendingLine ticketId={99} />)
    await waitFor(() => expect(screen.getByText(/~\$2\.50/)).toBeInTheDocument())
  })

  it('does not prefix ~ for a claude-only ticket (estimatedCostUsd 0) — byte-identical legacy', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        totalCostUsd: 4.2,
        estimatedCostUsd: 0,
        totalTurns: 12,
        activeDurationMs: 204000,
        totalRuns: 4,
        bySurface: { job: { count: 4, costUsd: 4.2 }, 'quick-spec': { count: 0, costUsd: 0 }, 'explore-spec': { count: 0, costUsd: 0 }, 'ai-edit': { count: 0, costUsd: 0 } },
      }),
    })
    render(<TicketSpendingLine ticketId={42} />)
    await waitFor(() => expect(screen.getByText(/\$4\.20/)).toBeInTheDocument())
    expect(screen.queryByText(/~\$4\.20/)).not.toBeInTheDocument()
  })

  it('formats short duration in seconds', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        totalCostUsd: 0.05, totalTurns: 1, activeDurationMs: 1500, totalRuns: 1,
        bySurface: { job: { count: 1, costUsd: 0.05 }, 'quick-spec': { count: 0, costUsd: 0 }, 'explore-spec': { count: 0, costUsd: 0 }, 'ai-edit': { count: 0, costUsd: 0 } },
      }),
    })
    render(<TicketSpendingLine ticketId={7} />)
    await waitFor(() => expect(screen.getByText(/1\.5s/)).toBeInTheDocument())
  })

  it('renders unavailable instead of $0 and 0 turns for an all-Kimi ticket', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        totalCostUsd: 0,
        totalTurns: null,
        activeDurationMs: 1000,
        totalRuns: 2,
        pricedRuns: 0,
        unpricedRuns: 2,
        turnsReportedRuns: 0,
        turnsUnavailableRuns: 2,
        bySurface: { job: { count: 2, costUsd: 0, unpricedCount: 2 } },
      }),
    })
    render(<TicketSpendingLine ticketId={77} />)
    await waitFor(() => expect(screen.getByTestId('ticket-cost-unavailable')).toHaveTextContent('—'))
    expect(screen.getByTestId('ticket-turns-unavailable')).toHaveTextContent('—')
    expect(screen.queryByText('$0.0000')).not.toBeInTheDocument()
    expect(screen.queryByText(/0 turns/)).not.toBeInTheDocument()
  })

  it('marks mixed Claude and Kimi ticket values as known lower bounds', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        totalCostUsd: 1.5,
        totalTurns: 3,
        activeDurationMs: 1000,
        totalRuns: 2,
        pricedRuns: 1,
        unpricedRuns: 1,
        turnsReportedRuns: 1,
        turnsUnavailableRuns: 1,
        bySurface: { job: { count: 2, costUsd: 1.5, unpricedCount: 1 } },
      }),
    })
    render(<TicketSpendingLine ticketId={78} />)
    await waitFor(() => expect(screen.getByText('≥$1.50')).toBeInTheDocument())
    expect(screen.getByText(/≥3 turns/)).toBeInTheDocument()
  })

  it('renders nothing when fetch fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    const { container } = render(<TicketSpendingLine ticketId={1} />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when bySurface is missing', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ totalCostUsd: 1, totalTurns: 1, activeDurationMs: 1, totalRuns: 1 }),
    })
    const { container } = render(<TicketSpendingLine ticketId={1} />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })
})
