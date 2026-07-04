import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '../../test-utils'
import { TicketPostItView } from '../TicketPostItView'
import type { LocalTicket, TicketStatus, TicketPriority } from '../../types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTicket(overrides: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id: 1, title: 'Test ticket', description: 'A description', status: 'todo', priority: 'medium',
    labels: [], assignee: null, prerequisites: [], metadata: {},
    created_at: '', updated_at: '', created_by: 'user', source: 'manual',
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

describe('TicketPostItView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows empty state when no tickets', () => {
    render(<TicketPostItView {...makeDefaultProps()} />)
    expect(screen.getByText('No tickets yet')).toBeDefined()
  })

  it('shows loading skeleton when isLoading=true', () => {
    const { container } = render(<TicketPostItView {...makeDefaultProps({ isLoading: true })} />)
    const pulsingDivs = container.querySelectorAll('.animate-pulse')
    expect(pulsingDivs.length).toBeGreaterThan(0)
  })

  it('renders a card for each ticket', () => {
    const tickets = [
      makeTicket({ id: 1, title: 'First ticket' }),
      makeTicket({ id: 2, title: 'Second ticket' }),
    ]
    render(<TicketPostItView {...makeDefaultProps({ tickets })} />)
    expect(screen.getByText('First ticket')).toBeDefined()
    expect(screen.getByText('Second ticket')).toBeDefined()
  })

  it('calls onTicketClick when a card is clicked', () => {
    const onTicketClick = vi.fn()
    const ticket = makeTicket({ id: 1, title: 'Clickable postit', status: 'todo' })
    render(<TicketPostItView {...makeDefaultProps({ tickets: [ticket], onTicketClick })} />)

    fireEvent.click(screen.getByText('Clickable postit'))
    expect(onTicketClick).toHaveBeenCalledWith(ticket)
  })

  it('renders ticket ID on each card', () => {
    const ticket = makeTicket({ id: 42, title: 'ID test' })
    render(<TicketPostItView {...makeDefaultProps({ tickets: [ticket] })} />)
    expect(screen.getByText('#42')).toBeDefined()
  })

  it('resets rotation on mouse enter and restores on mouse leave', () => {
    const ticket = makeTicket({ id: 1, title: 'Hover ticket', status: 'todo' })
    render(<TicketPostItView {...makeDefaultProps({ tickets: [ticket] })} />)
    const card = screen.getByText('Hover ticket').closest('button')!
    fireEvent.mouseEnter(card)
    expect(card.style.transform).toContain('rotate(0deg)')
    fireEvent.mouseLeave(card)
    expect(card.style.transform).toContain('rotate(')
  })

  it('shows error state when error prop is provided', () => {
    render(<TicketPostItView {...makeDefaultProps()} error="Network error" />)
    expect(screen.getByText('Failed to load tickets')).toBeDefined()
    expect(screen.getByText('Network error')).toBeDefined()
  })

  describe('on_review tickets', () => {
    it('renders an on_review card with the accent-warning palette (no crash)', () => {
      const ticket = makeTicket({ id: 9, title: 'Reviewing postit', status: 'on_review' })
      render(<TicketPostItView {...makeDefaultProps({ tickets: [ticket] })} />)
      const card = screen.getByText('Reviewing postit').closest('button')!
      expect(card.className).toContain('bg-accent-warning/10')
    })

    it('renders the On Review pill in the priority indicator slot', () => {
      const ticket = makeTicket({ id: 9, title: 'Reviewing postit', status: 'on_review', priority: 'high' })
      render(<TicketPostItView {...makeDefaultProps({ tickets: [ticket] })} />)
      const pill = screen.getByTestId('on-review-pill-postit-9')
      expect(pill.textContent).toBe('On Review')
      expect(pill.className).toContain('text-accent-warning')
    })

    it('sorts on_review between in_progress and draft/todo', () => {
      const tickets = [
        makeTicket({ id: 1, title: 'Todo one', status: 'todo' }),
        makeTicket({ id: 2, title: 'Reviewing one', status: 'on_review' }),
        makeTicket({ id: 3, title: 'Active one', status: 'in_progress' }),
      ]
      render(<TicketPostItView {...makeDefaultProps({ tickets })} />)
      const titles = screen.getAllByRole('button').map((b) => b.textContent)
      const idx = (needle: string) => titles.findIndex((t) => t?.includes(needle))
      expect(idx('Active one')).toBeLessThan(idx('Reviewing one'))
      expect(idx('Reviewing one')).toBeLessThan(idx('Todo one'))
    })
  })
})
