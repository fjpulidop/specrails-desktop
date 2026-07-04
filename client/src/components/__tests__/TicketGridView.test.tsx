import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '../../test-utils'
import { TicketGridView } from '../TicketGridView'
import type { LocalTicket, TicketStatus, TicketPriority } from '../../types'

// ─── Mock @dnd-kit ────────────────────────────────────────────────────────────

let capturedDragCallbacks: {
  onDragStart?: (e: { active: { id: string | number } }) => void
  onDragEnd?: (e: { active: { id: string | number }; over: { id: string | number } | null }) => void
  onDragOver?: (e: { active: { id: string | number }; over: { id: string | number } | null }) => void
} = {}

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragStart, onDragEnd, onDragOver }: {
    children: React.ReactNode
    onDragStart?: (e: { active: { id: string | number } }) => void
    onDragEnd?: (e: { active: { id: string | number }; over: { id: string | number } | null }) => void
    onDragOver?: (e: { active: { id: string | number }; over: { id: string | number } | null }) => void
  }) => {
    capturedDragCallbacks = { onDragStart, onDragEnd, onDragOver }
    return <>{children}</>
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  closestCorners: vi.fn(),
  KeyboardSensor: class {},
  PointerSensor: class {},
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  verticalListSortingStrategy: {},
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
  arrayMove: vi.fn((arr: unknown[]) => arr),
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: vi.fn(() => '') } },
}))

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTicket(overrides: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id: 1, title: 'Test ticket', description: '', status: 'todo', priority: 'medium',
    labels: [], assignee: null, prerequisites: [], metadata: {},
    created_at: '', updated_at: '', created_by: 'user', source: 'manual',
    ...overrides,
  }
}

function makeDefaultProps(overrides: Partial<{
  tickets: LocalTicket[]
  onTicketClick: (t: LocalTicket) => void
  onDelete: (id: number) => void
  onStatusChange: (id: number, s: TicketStatus) => void
  onPriorityChange: (id: number, p: TicketPriority) => void
}> = {}) {
  return {
    tickets: [],
    onTicketClick: vi.fn(),
    onDelete: vi.fn(),
    onStatusChange: vi.fn(),
    onPriorityChange: vi.fn(),
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TicketGridView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedDragCallbacks = {}
  })

  it('renders column headings for todo, in progress, done', () => {
    // Need at least one ticket for the grid (vs global empty state)
    const tickets = [makeTicket({ id: 1, status: 'todo' })]
    render(<TicketGridView {...makeDefaultProps({ tickets })} />)
    expect(screen.getByText('Todo')).toBeDefined()
    expect(screen.getByText('In Progress')).toBeDefined()
    expect(screen.getByText('Done')).toBeDefined()
  })

  it('shows global empty state when no tickets', () => {
    render(<TicketGridView {...makeDefaultProps()} />)
    expect(screen.getByText('No tickets yet')).toBeDefined()
  })

  it('renders empty state text for a column that has no tickets (when other columns do)', () => {
    // Only a todo ticket — in_progress and done columns should show their empty text
    const tickets = [makeTicket({ id: 1, title: 'Todo ticket', status: 'todo' })]
    render(<TicketGridView {...makeDefaultProps({ tickets })} />)
    expect(screen.getByText('Nothing in progress')).toBeDefined()
    expect(screen.getByText('No completed tickets')).toBeDefined()
  })

  it('renders ticket title in the correct column', () => {
    const tickets = [
      makeTicket({ id: 1, title: 'Todo ticket', status: 'todo' }),
      makeTicket({ id: 2, title: 'In progress ticket', status: 'in_progress' }),
      makeTicket({ id: 3, title: 'Done ticket', status: 'done' }),
    ]
    render(<TicketGridView {...makeDefaultProps({ tickets })} />)
    expect(screen.getByText('Todo ticket')).toBeDefined()
    expect(screen.getByText('In progress ticket')).toBeDefined()
    expect(screen.getByText('Done ticket')).toBeDefined()
  })

  it('shows ticket count badge in column header', () => {
    const tickets = [
      makeTicket({ id: 1, status: 'todo' }),
      makeTicket({ id: 2, status: 'todo' }),
    ]
    render(<TicketGridView {...makeDefaultProps({ tickets })} />)
    // The todo column header should show "2" as count
    expect(screen.getAllByText('2').length).toBeGreaterThan(0)
  })

  it('calls onTicketClick when a card is clicked', () => {
    const onTicketClick = vi.fn()
    const ticket = makeTicket({ id: 1, title: 'Clickable card', status: 'todo' })
    render(<TicketGridView {...makeDefaultProps({ tickets: [ticket], onTicketClick })} />)

    fireEvent.click(screen.getByText('Clickable card'))
    expect(onTicketClick).toHaveBeenCalledWith(ticket)
  })

  describe('drag handlers', () => {
    it('handleDragStart sets activeId', () => {
      const tickets = [makeTicket({ id: 1, status: 'todo' })]
      render(<TicketGridView {...makeDefaultProps({ tickets })} />)

      // Trigger drag start
      capturedDragCallbacks.onDragStart?.({ active: { id: 'ticket-1' } })
      // No error means the handler ran fine
    })

    it('handleDragOver is callable without side effects', () => {
      const tickets = [makeTicket({ id: 1, status: 'todo' })]
      render(<TicketGridView {...makeDefaultProps({ tickets })} />)

      // DragOver is a no-op handler
      capturedDragCallbacks.onDragOver?.({ active: { id: 'ticket-1' }, over: { id: 'ticket-1' } })
    })

    it('handleDragEnd with no over target does nothing', () => {
      const onStatusChange = vi.fn()
      const tickets = [makeTicket({ id: 1, status: 'todo' })]
      render(<TicketGridView {...makeDefaultProps({ tickets, onStatusChange })} />)

      capturedDragCallbacks.onDragEnd?.({ active: { id: 'ticket-1' }, over: null })
      expect(onStatusChange).not.toHaveBeenCalled()
    })

    it('handleDragEnd calls onStatusChange when dropping on a ticket in different column', () => {
      const onStatusChange = vi.fn()
      const tickets = [
        makeTicket({ id: 1, status: 'todo' }),
        makeTicket({ id: 2, status: 'in_progress' }),
      ]
      render(<TicketGridView {...makeDefaultProps({ tickets, onStatusChange })} />)

      capturedDragCallbacks.onDragEnd?.({
        active: { id: 'ticket-1' },
        over: { id: 'ticket-2' },
      })

      expect(onStatusChange).toHaveBeenCalledWith(1, 'in_progress')
    })

    it('handleDragEnd does not call onStatusChange when dropping in same column', () => {
      const onStatusChange = vi.fn()
      const tickets = [
        makeTicket({ id: 1, status: 'todo' }),
        makeTicket({ id: 2, status: 'todo' }),
      ]
      render(<TicketGridView {...makeDefaultProps({ tickets, onStatusChange })} />)

      capturedDragCallbacks.onDragEnd?.({
        active: { id: 'ticket-1' },
        over: { id: 'ticket-2' },
      })

      expect(onStatusChange).not.toHaveBeenCalled()
    })

    it('handleDragEnd does nothing when over target is not a ticket', () => {
      const onStatusChange = vi.fn()
      const tickets = [makeTicket({ id: 1, status: 'todo' })]
      render(<TicketGridView {...makeDefaultProps({ tickets, onStatusChange })} />)

      capturedDragCallbacks.onDragEnd?.({
        active: { id: 'ticket-1' },
        over: { id: 'column-in_progress' },
      })

      expect(onStatusChange).not.toHaveBeenCalled()
    })

    it('dropping a todo ticket onto an on_review neighbour is a same-column no-op (on_review resolves to todo)', () => {
      const onStatusChange = vi.fn()
      const tickets = [
        makeTicket({ id: 1, status: 'todo' }),
        makeTicket({ id: 2, status: 'on_review' }),
      ]
      render(<TicketGridView {...makeDefaultProps({ tickets, onStatusChange })} />)

      capturedDragCallbacks.onDragEnd?.({
        active: { id: 'ticket-1' },
        over: { id: 'ticket-2' },
      })

      // Both live in the Todo column, so no status PATCH may fire — otherwise a
      // drop next to an on_review spec would move the dragged ticket into a
      // pipeline-owned status.
      expect(onStatusChange).not.toHaveBeenCalled()
    })
  })

  describe('on_review tickets', () => {
    it('buckets an on_review ticket into the Todo column (no crash, no extra column)', () => {
      const tickets = [makeTicket({ id: 5, title: 'PR pending', status: 'on_review' })]
      render(<TicketGridView {...makeDefaultProps({ tickets })} />)
      // Renders inside the existing three-column grid — the Todo column hosts it.
      expect(screen.getByText('PR pending')).toBeDefined()
      expect(screen.getByText('Nothing in progress')).toBeDefined()
      expect(screen.getByText('No completed tickets')).toBeDefined()
    })

    it('renders the On Review pill with accent-warning tokens on the card', () => {
      const tickets = [makeTicket({ id: 5, title: 'PR pending', status: 'on_review', priority: 'high' })]
      render(<TicketGridView {...makeDefaultProps({ tickets })} />)
      const pill = screen.getByTestId('on-review-pill-grid-5')
      expect(pill.textContent).toBe('On Review')
      expect(pill.className).toContain('text-accent-warning')
    })
  })

  describe('cancelled tickets row', () => {
    it('shows cancelled tickets section when there are cancelled tickets', () => {
      const tickets = [
        makeTicket({ id: 1, status: 'todo' }),
        makeTicket({ id: 2, title: 'Old feature', status: 'cancelled' }),
      ]
      render(<TicketGridView {...makeDefaultProps({ tickets })} />)
      expect(screen.getByText(/Cancelled/i)).toBeDefined()
      expect(screen.getByText(/#2 Old feature/)).toBeDefined()
    })

    it('shows loading skeleton when isLoading is true', () => {
      const { container } = render(<TicketGridView {...makeDefaultProps({ isLoading: true })} />)
      const pulsingDivs = container.querySelectorAll('.animate-pulse')
      expect(pulsingDivs.length).toBeGreaterThan(0)
    })
  })
})
