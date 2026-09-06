import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SummaryHeader } from '../SummaryHeader'

vi.mock('../../../context/TicketDetailModalContext', () => ({
  useTicketDetailModal: () => ({ openTicketDetail: vi.fn() }),
}))

describe('SummaryHeader', () => {
  it('renders empty state without inline action', () => {
    render(<SummaryHeader path="src/a.ts" summary={null} stale={false} regenerating={false} />)
    expect(screen.getByTestId('summary-header-empty')).toBeInTheDocument()
    expect(screen.getByText('No summary for this file yet.')).toBeInTheDocument()
    expect(screen.queryByText('Generate summary')).not.toBeInTheDocument()
  })

  it('renders fresh summary without stale badge', () => {
    render(
      <SummaryHeader
        path="src/a.ts"
        summary={{ summary: 'Does the thing.', generatedAt: new Date().toISOString(), triggeredBy: { ticketId: 5 } }}
        stale={false}
        regenerating={false}
      />,
    )
    expect(screen.getByText('Does the thing.')).toBeInTheDocument()
    expect(screen.queryByTestId('summary-stale-badge')).not.toBeInTheDocument()
  })

  it('renders stale summary with badge', () => {
    render(
      <SummaryHeader
        path="src/a.ts"
        summary={{ summary: 'Old summary.', generatedAt: new Date().toISOString() }}
        stale={true}
        regenerating={false}
      />,
    )
    expect(screen.getByTestId('summary-stale-badge')).toBeInTheDocument()
  })

  it('renders disabled reason in the empty state', () => {
    render(<SummaryHeader path="x" summary={null} stale={false} regenerating={false} generateDisabledReason="binary file" />)
    expect(screen.getByText('Summary unavailable: binary file.')).toBeInTheDocument()
  })
  it('shows the actual generator, exact date and partial-source caveat', () => {
    const { container } = render(<SummaryHeader path="src/a.ts" summary={{ summary: 'Partial summary.', generatedAt: '2026-01-01T12:00:00.000Z', generatedBy: { model: 'gpt-small', promptVersion: 2, truncated: true } }} stale={false} regenerating={false} />)
    expect(screen.getByText('Explained by gpt-small')).toBeInTheDocument()
    expect(screen.getByText(/Generated from a partial source snapshot/)).toBeInTheDocument()
    expect(container.querySelector('time')).toHaveAttribute('datetime', '2026-01-01T12:00:00.000Z')
    expect(container.querySelector('time')?.getAttribute('title')).toBeTruthy()
  })

})
