import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { TicketPostitCard } from '../TicketPostitCard'
import type { LocalTicket } from '../../types'
import type { RailState } from '../RailsBoard'

function makeTicket(overrides: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id: 42,
    title: 'Add dark mode toggle',
    description: 'body',
    status: 'todo',
    priority: 'high',
    labels: [],
    assignee: null,
    prerequisites: [],
    metadata: {},
    short_summary: 'Lets users switch theme persisted app-wide.',
    is_epic: false,
    parent_epic_id: null,
    execution_order: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    created_by: 'user',
    source: 'propose-spec',
    ...overrides,
  } as LocalTicket
}

function makeRails(): RailState[] {
  return [
    { id: 'rail-1', label: 'Rail Alpha', ticketIds: [], mode: 'implement', status: 'idle' },
    { id: 'rail-2', label: 'Rail Beta', ticketIds: [], mode: 'implement', status: 'running' },
  ]
}

function wrap(ui: React.ReactNode, ids: number[] = [42]) {
  return (
    <DndContext>
      <SortableContext items={ids}>{ui}</SortableContext>
    </DndContext>
  )
}

describe('TicketPostitCard', () => {
  it('renders a Review badge when needs_review is set', () => {
    render(
      wrap(
        <TicketPostitCard
          ticket={makeTicket({ status: 'done', needs_review: true })}
          rails={makeRails()}
          onClick={() => {}}
          onMoveToRail={() => {}}
        />,
      ),
    )
    expect(screen.getByTestId('needs-review-badge-42')).toBeInTheDocument()
  })

  it('renders id, title, priority, and summary when present', () => {
    render(
      wrap(
        <TicketPostitCard
          ticket={makeTicket()}
          rails={makeRails()}
          onClick={() => {}}
          onMoveToRail={() => {}}
        />,
      ),
    )
    expect(screen.getByText('#42')).toBeInTheDocument()
    expect(screen.getByText('Add dark mode toggle')).toBeInTheDocument()
    expect(screen.getByText(/high/i)).toBeInTheDocument()
    expect(screen.getByTestId('postit-short-summary')).toHaveTextContent('Lets users switch theme persisted app-wide.')
  })

  it('hides the summary region when short_summary is null', () => {
    render(
      wrap(
        <TicketPostitCard
          ticket={makeTicket({ short_summary: null })}
          rails={makeRails()}
          onClick={() => {}}
          onMoveToRail={() => {}}
        />,
      ),
    )
    expect(screen.queryByTestId('postit-short-summary')).not.toBeInTheDocument()
  })

  it('hides the summary region when short_summary is empty string', () => {
    render(
      wrap(
        <TicketPostitCard
          ticket={makeTicket({ short_summary: '   ' })}
          rails={makeRails()}
          onClick={() => {}}
          onMoveToRail={() => {}}
        />,
      ),
    )
    expect(screen.queryByTestId('postit-short-summary')).not.toBeInTheDocument()
  })

  it('renders a Draft pill when status is draft and hides priority', () => {
    render(
      wrap(
        <TicketPostitCard
          ticket={makeTicket({ status: 'draft', priority: null })}
          rails={makeRails()}
          onClick={() => {}}
          onMoveToRail={() => {}}
        />,
      ),
    )
    expect(screen.getByText(/draft/i)).toBeInTheDocument()
  })

  describe('on_review variant', () => {
    it('renders an On Review badge and hides the priority badge', () => {
      render(
        wrap(
          <TicketPostitCard
            ticket={makeTicket({ status: 'on_review' })}
            rails={makeRails()}
            onClick={() => {}}
            onMoveToRail={() => {}}
          />,
        ),
      )
      expect(screen.getByTestId('on-review-badge-postit-42')).toBeInTheDocument()
      expect(screen.getByText('On Review')).toBeInTheDocument()
      expect(screen.queryByText(/high/i)).not.toBeInTheDocument()
    })

    it('hides the Move-to-Rail button (not launchable while the PR decision is pending)', () => {
      render(
        wrap(
          <TicketPostitCard
            ticket={makeTicket({ status: 'on_review' })}
            rails={makeRails()}
            onClick={() => {}}
            onMoveToRail={() => {}}
          />,
        ),
      )
      expect(screen.queryByTestId('move-to-rail-button')).not.toBeInTheDocument()
    })

    it('uses semantic accent-warning tokens (no brand-named colours)', () => {
      render(
        wrap(
          <TicketPostitCard
            ticket={makeTicket({ status: 'on_review' })}
            rails={makeRails()}
            onClick={() => {}}
            onMoveToRail={() => {}}
          />,
        ),
      )
      const badge = screen.getByTestId('on-review-badge-postit-42')
      expect(badge.className).toContain('text-accent-warning')
      expect(badge.className).not.toMatch(/dracula-/)
    })
  })

  it('opens the Move-to-Rail popover and calls onMoveToRail when a rail is picked', () => {
    const onMove = vi.fn()
    render(
      wrap(
        <TicketPostitCard
          ticket={makeTicket()}
          rails={makeRails()}
          onClick={() => {}}
          onMoveToRail={onMove}
        />,
      ),
    )
    fireEvent.click(screen.getByTestId('move-to-rail-button'))
    expect(screen.getByTestId('move-to-rail-popover')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Rail Alpha'))
    expect(onMove).toHaveBeenCalledWith(42, 'rail-1')
    expect(screen.queryByTestId('move-to-rail-popover')).not.toBeInTheDocument()
  })

  it('shows a dependency indicator when the ticket has prerequisites', () => {
    render(
      wrap(
        <TicketPostitCard
          ticket={makeTicket({ prerequisites: [1, 2, 3] })}
          rails={makeRails()}
          onClick={() => {}}
          onMoveToRail={() => {}}
        />,
      ),
    )
    expect(screen.getByText(/Depends on 3/)).toBeInTheDocument()
  })

  it('does not fire onClick when in jiggleMode', () => {
    const onClick = vi.fn()
    render(
      wrap(
        <TicketPostitCard
          ticket={makeTicket()}
          rails={makeRails()}
          onClick={onClick}
          onMoveToRail={() => {}}
          jiggleMode
        />,
      ),
    )
    fireEvent.click(screen.getByText('Add dark mode toggle'))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('renders a Raw badge for a free-prompt ticket', () => {
    render(
      wrap(
        <TicketPostitCard
          ticket={makeTicket({ source: 'free-prompt' })}
          rails={makeRails()}
          onClick={() => {}}
          onMoveToRail={() => {}}
        />,
      ),
    )
    expect(screen.getByTestId('raw-badge-42')).toBeInTheDocument()
    expect(screen.getByText('Raw')).toBeInTheDocument()
  })

  it('does not render a Raw badge for a non-free-prompt ticket', () => {
    render(
      wrap(
        <TicketPostitCard
          ticket={makeTicket({ source: 'propose-spec' })}
          rails={makeRails()}
          onClick={() => {}}
          onMoveToRail={() => {}}
        />,
      ),
    )
    expect(screen.queryByTestId('raw-badge-42')).not.toBeInTheDocument()
  })
})
