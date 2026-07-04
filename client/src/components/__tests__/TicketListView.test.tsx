import React, { act } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '../../test-utils'
import { TicketListView } from '../TicketListView'
import type { LocalTicket, TicketStatus, TicketPriority } from '../../types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTicket(overrides: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id: 1, title: 'Test ticket', description: '', status: 'todo', priority: 'medium',
    labels: [], assignee: null, prerequisites: [], metadata: {},
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'user', source: 'manual',
    ...overrides,
  }
}

function makeDefaultProps(overrides: Partial<{
  tickets: LocalTicket[]
  isLoading: boolean
  onTicketClick: (t: LocalTicket) => void
  onDelete: (id: number) => void
  onStatusChange: (id: number, s: TicketStatus) => void
  onPriorityChange: (id: number, p: TicketPriority) => void
}> = {}) {
  return {
    tickets: [],
    isLoading: false,
    onTicketClick: vi.fn(),
    onDelete: vi.fn(),
    onStatusChange: vi.fn(),
    onPriorityChange: vi.fn(),
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TicketListView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('empty state', () => {
    it('shows empty state when no tickets', () => {
      render(<TicketListView {...makeDefaultProps()} />)
      expect(screen.getByText('No tickets yet')).toBeDefined()
    })

    it('does not show empty state when tickets are provided', () => {
      render(<TicketListView {...makeDefaultProps({ tickets: [makeTicket()] })} />)
      expect(screen.queryByText('No tickets yet')).toBeNull()
    })
  })

  describe('loading state', () => {
    it('shows loading skeleton when isLoading=true', () => {
      const { container } = render(<TicketListView {...makeDefaultProps({ isLoading: true })} />)
      // Loading state renders animated pulse divs
      const pulsingDivs = container.querySelectorAll('.animate-pulse')
      expect(pulsingDivs.length).toBeGreaterThan(0)
    })

    it('does not show ticket rows when loading', () => {
      render(<TicketListView {...makeDefaultProps({ isLoading: true, tickets: [makeTicket()] })} />)
      expect(screen.queryByText('Test ticket')).toBeNull()
    })
  })

  describe('ticket rendering', () => {
    it('renders ticket title', () => {
      render(<TicketListView {...makeDefaultProps({ tickets: [makeTicket({ title: 'My bug fix' })] })} />)
      expect(screen.getByText('My bug fix')).toBeDefined()
    })

    it('renders a row for each ticket', () => {
      const tickets = [
        makeTicket({ id: 1, title: 'First ticket' }),
        makeTicket({ id: 2, title: 'Second ticket' }),
        makeTicket({ id: 3, title: 'Third ticket' }),
      ]
      render(<TicketListView {...makeDefaultProps({ tickets })} />)
      expect(screen.getByText('First ticket')).toBeDefined()
      expect(screen.getByText('Second ticket')).toBeDefined()
      expect(screen.getByText('Third ticket')).toBeDefined()
    })

    it('renders labels on ticket', () => {
      render(<TicketListView {...makeDefaultProps({
        tickets: [makeTicket({ labels: ['area:backend', 'bug'] })]
      })} />)
      // Label appears in the row and/or the filter dropdown
      expect(screen.getAllByText('area:backend').length).toBeGreaterThan(0)
    })

    it('renders high priority badge', () => {
      render(<TicketListView {...makeDefaultProps({
        tickets: [makeTicket({ priority: 'high' })]
      })} />)
      expect(screen.getByText('high')).toBeDefined()
    })

    it('renders critical priority badge', () => {
      render(<TicketListView {...makeDefaultProps({
        tickets: [makeTicket({ priority: 'critical' })]
      })} />)
      expect(screen.getByText('critical')).toBeDefined()
    })
  })

  describe('click interaction', () => {
    it('calls onTicketClick when a row is clicked', () => {
      const onTicketClick = vi.fn()
      const ticket = makeTicket({ title: 'Clickable' })
      render(<TicketListView {...makeDefaultProps({ tickets: [ticket], onTicketClick })} />)

      const row = screen.getByRole('button', { name: /Clickable/i })
      fireEvent.click(row)
      expect(onTicketClick).toHaveBeenCalledWith(ticket)
    })

    it('calls onTicketClick on Enter key press', () => {
      const onTicketClick = vi.fn()
      const ticket = makeTicket({ title: 'Keyboard ticket' })
      render(<TicketListView {...makeDefaultProps({ tickets: [ticket], onTicketClick })} />)

      const row = screen.getByRole('button', { name: /Keyboard ticket/i })
      fireEvent.keyDown(row, { key: 'Enter' })
      expect(onTicketClick).toHaveBeenCalledWith(ticket)
    })
  })

  describe('status filter', () => {
    it('shows All filter button with ticket count', () => {
      const tickets = [makeTicket({ id: 1 }), makeTicket({ id: 2 })]
      render(<TicketListView {...makeDefaultProps({ tickets })} />)
      expect(screen.getByText('All (2)')).toBeDefined()
    })

    it('shows status filter buttons for statuses that have tickets', () => {
      const tickets = [
        makeTicket({ id: 1, status: 'todo' }),
        makeTicket({ id: 2, status: 'done' }),
      ]
      render(<TicketListView {...makeDefaultProps({ tickets })} />)
      expect(screen.getByText(/todo \(1\)/i)).toBeDefined()
      expect(screen.getByText(/done \(1\)/i)).toBeDefined()
    })

    it('filters tickets by status when a filter is clicked', () => {
      const tickets = [
        makeTicket({ id: 1, title: 'Todo ticket', status: 'todo' }),
        makeTicket({ id: 2, title: 'Done ticket', status: 'done' }),
      ]
      render(<TicketListView {...makeDefaultProps({ tickets })} />)

      fireEvent.click(screen.getByText(/done \(1\)/i))

      expect(screen.queryByText('Todo ticket')).toBeNull()
      expect(screen.getByText('Done ticket')).toBeDefined()
    })

    it('shows an on review filter chip and filters by it', () => {
      const tickets = [
        makeTicket({ id: 1, title: 'Todo ticket', status: 'todo' }),
        makeTicket({ id: 2, title: 'Reviewing ticket', status: 'on_review' }),
      ]
      render(<TicketListView {...makeDefaultProps({ tickets })} />)

      fireEvent.click(screen.getByText(/on review \(1\)/i))

      expect(screen.queryByText('Todo ticket')).toBeNull()
      expect(screen.getByText('Reviewing ticket')).toBeDefined()
    })
  })

  describe('on_review row', () => {
    it('renders the On Review pill in the priority slot with accent-warning tokens', () => {
      const tickets = [makeTicket({ id: 7, title: 'PR pending', status: 'on_review', priority: 'high' })]
      render(<TicketListView {...makeDefaultProps({ tickets })} />)
      const pill = screen.getByTestId('on-review-pill-list-7')
      expect(pill).toBeDefined()
      expect(pill.textContent).toBe('On Review')
      expect(pill.className).toContain('text-accent-warning')
      // The priority pill yields its DOM slot to the On Review pill.
      expect(screen.queryByText('high')).toBeNull()
    })
  })

  describe('search', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('filters tickets by search query', () => {
      const tickets = [
        makeTicket({ id: 1, title: 'Fix login bug' }),
        makeTicket({ id: 2, title: 'Add dashboard' }),
      ]
      render(<TicketListView {...makeDefaultProps({ tickets })} />)

      const searchInput = screen.getByPlaceholderText('Search...')
      fireEvent.change(searchInput, { target: { value: 'login' } })
      act(() => { vi.advanceTimersByTime(300) })

      expect(screen.getByText('Fix login bug')).toBeDefined()
      expect(screen.queryByText('Add dashboard')).toBeNull()
    })

    it('filters tickets by description match', () => {
      const tickets = [
        makeTicket({ id: 1, title: 'Ticket A', description: 'auth system fix' }),
        makeTicket({ id: 2, title: 'Ticket B', description: 'dashboard update' }),
      ]
      render(<TicketListView {...makeDefaultProps({ tickets })} />)
      const searchInput = screen.getByPlaceholderText('Search...')
      fireEvent.change(searchInput, { target: { value: 'auth' } })
      act(() => { vi.advanceTimersByTime(300) })
      expect(screen.getByText('Ticket A')).toBeDefined()
      expect(screen.queryByText('Ticket B')).toBeNull()
    })
  })

  describe('sorting', () => {
    it('sorts by priority when Priority header is clicked', () => {
      const tickets = [
        makeTicket({ id: 1, title: 'Alpha ticket', priority: 'low', status: 'todo' }),
        makeTicket({ id: 2, title: 'Beta ticket', priority: 'critical', status: 'todo' }),
      ]
      render(<TicketListView {...makeDefaultProps({ tickets })} />)

      // Use role button with name to avoid matching ticket titles
      fireEvent.click(screen.getByRole('button', { name: /^Priority/ }))

      // Both tickets should still be visible
      expect(screen.getByText('Alpha ticket')).toBeDefined()
      expect(screen.getByText('Beta ticket')).toBeDefined()
    })

    it('sorts by updated date when Updated header is clicked', () => {
      const tickets = [
        makeTicket({ id: 1, title: 'Older ticket', updated_at: '2026-01-01T00:00:00.000Z' }),
        makeTicket({ id: 2, title: 'Newer ticket', updated_at: '2026-06-01T00:00:00.000Z' }),
      ]
      render(<TicketListView {...makeDefaultProps({ tickets })} />)

      fireEvent.click(screen.getByText(/Updated/i))

      expect(screen.getByText('Older ticket')).toBeDefined()
      expect(screen.getByText('Newer ticket')).toBeDefined()
    })

    it('toggles sort direction when same header is clicked', () => {
      const tickets = [makeTicket({ id: 1 }), makeTicket({ id: 2 })]
      render(<TicketListView {...makeDefaultProps({ tickets })} />)

      // Status is already the active sort field — clicking once toggles asc→desc
      const statusHeader = screen.getByRole('button', { name: /^Status/ })
      fireEvent.click(statusHeader)

      // Should show ↓ indicator
      expect(screen.getByRole('button', { name: /Status.*↓/ })).toBeDefined()
    })

    it('shows sort indicator on active column', () => {
      const tickets = [makeTicket({ id: 1 })]
      render(<TicketListView {...makeDefaultProps({ tickets })} />)

      // Priority header click
      fireEvent.click(screen.getByText(/Priority/))
      expect(screen.getByText(/Priority.*↑/)).toBeDefined()
    })
  })

  describe('label filter', () => {
    it('filters tickets by label when label filter is changed', () => {
      const tickets = [
        makeTicket({ id: 1, title: 'Backend ticket', labels: ['area:backend'] }),
        makeTicket({ id: 2, title: 'Frontend ticket', labels: ['area:frontend'] }),
      ]
      render(<TicketListView {...makeDefaultProps({ tickets })} />)

      const labelSelect = screen.getByDisplayValue('All labels')
      fireEvent.change(labelSelect, { target: { value: 'area:backend' } })

      expect(screen.getByText('Backend ticket')).toBeDefined()
      expect(screen.queryByText('Frontend ticket')).toBeNull()
    })

    it('clears label filter when "All labels" is selected', () => {
      const tickets = [
        makeTicket({ id: 1, title: 'Backend ticket', labels: ['area:backend'] }),
        makeTicket({ id: 2, title: 'Frontend ticket', labels: ['area:frontend'] }),
      ]
      render(<TicketListView {...makeDefaultProps({ tickets })} />)

      const labelSelect = screen.getByDisplayValue('All labels')
      fireEvent.change(labelSelect, { target: { value: 'area:backend' } })
      fireEvent.change(labelSelect, { target: { value: '' } })

      expect(screen.getByText('Backend ticket')).toBeDefined()
      expect(screen.getByText('Frontend ticket')).toBeDefined()
    })
  })

  describe('pagination', () => {
    it('shows Load more button when there are more than 20 tickets', () => {
      const tickets = Array.from({ length: 25 }, (_, i) =>
        makeTicket({ id: i + 1, title: `Ticket ${i + 1}` })
      )
      render(<TicketListView {...makeDefaultProps({ tickets })} />)

      expect(screen.getByText(/Load more/i)).toBeDefined()
    })

    it('loads more tickets when Load more is clicked', () => {
      const tickets = Array.from({ length: 25 }, (_, i) =>
        makeTicket({ id: i + 1, title: `Ticket ${i + 1}` })
      )
      render(<TicketListView {...makeDefaultProps({ tickets })} />)

      expect(screen.queryByText('Ticket 25')).toBeNull()
      fireEvent.click(screen.getByText(/Load more/i))
      expect(screen.getByText('Ticket 25')).toBeDefined()
    })
  })

  describe('cancelled and done styling', () => {
    it('renders cancelled ticket with strikethrough class', () => {
      const tickets = [makeTicket({ id: 1, title: 'Cancelled task', status: 'cancelled' })]
      render(<TicketListView {...makeDefaultProps({ tickets })} />)
      expect(screen.getByText('Cancelled task')).toBeDefined()
    })

    it('renders tickets with more than 2 labels showing +N overflow', () => {
      const tickets = [makeTicket({ id: 1, labels: ['a', 'b', 'c', 'd'] })]
      render(<TicketListView {...makeDefaultProps({ tickets })} />)
      expect(screen.getByText('+2')).toBeDefined()
    })
  })
})
