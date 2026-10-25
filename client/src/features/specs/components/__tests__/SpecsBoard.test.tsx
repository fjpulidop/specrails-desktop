import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '../../../../test-utils'
import { SpecsBoard } from '../SpecsBoard'
import type { LocalTicket } from '../../../../types'
import { getPaletteSurface } from '../../../../lib/palette-bridge'

// Mock DnD kit — SpecsBoard uses useDroppable + SortableContext
vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ isOver: false, setNodeRef: vi.fn() }),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: vi.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: { toString: () => '' },
    Translate: { toString: () => '' },
  },
}))

vi.mock('../ProposeSpecModal', () => ({
  ProposeSpecModal: ({ open, onClose, initialMode }: { open: boolean; onClose: () => void; initialMode?: string }) =>
    open ? <div data-testid="propose-spec-modal" data-mode={initialMode}><button onClick={onClose}>close modal</button></div> : null,
}))

function makeTicket(overrides: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id: 1,
    title: 'Test Spec',
    description: '',
    status: 'todo',
    priority: 'medium',
    labels: [],
    assignee: null,
    prerequisites: [],
    metadata: {},
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    created_by: 'user',
    source: 'propose-spec',
    ...overrides,
  }
}

describe('SpecsBoard', () => {
  const onTicketClick = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the Specs heading', () => {
    render(<SpecsBoard tickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.getByText('Specs')).toBeInTheDocument()
  })

  it('renders Add Spec button', () => {
    render(<SpecsBoard tickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.getByTestId('specs-new-spec')).toBeInTheDocument()
  })

  it('shows empty state when no tickets', () => {
    render(<SpecsBoard tickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.getByText('No specs yet')).toBeInTheDocument()
    expect(screen.getByText(/Click "New spec" to get started/i)).toBeInTheDocument()
  })

  it('shows load error with Retry instead of the empty state', () => {
    const onRetry = vi.fn()
    render(<SpecsBoard tickets={[]} isLoading={false} error="request failed" onRetry={onRetry} onTicketClick={onTicketClick} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load specs')
    expect(screen.queryByText('No specs yet')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('keeps rendering the last good tickets alongside a refresh error', () => {
    render(<SpecsBoard tickets={[makeTicket({ title: 'Last good spec' })]} isLoading={false} error="request failed" onRetry={vi.fn()} onTicketClick={onTicketClick} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Last good spec')).toBeInTheDocument()
  })

  it('renders the postit grid when viewTier=postit and onMoveToRail is provided', () => {
    const tickets = [makeTicket({ id: 1, title: 'A' }), makeTicket({ id: 2, title: 'B' })]
    render(
      <SpecsBoard
        tickets={tickets}
        isLoading={false}
        onTicketClick={onTicketClick}
        viewTier="postit"
        rails={[]}
        onMoveToRail={vi.fn()}
      />,
    )
    expect(screen.getByTestId('specs-board-postit-grid')).toBeInTheDocument()
    expect(screen.queryByTestId('specs-board-list')).not.toBeInTheDocument()
  })

  it('falls back to the row list when viewTier=row', () => {
    const tickets = [makeTicket({ id: 1 })]
    render(
      <SpecsBoard
        tickets={tickets}
        isLoading={false}
        onTicketClick={onTicketClick}
        viewTier="row"
        rails={[]}
        onMoveToRail={vi.fn()}
      />,
    )
    const list = screen.getByTestId('specs-board-list')
    expect(list).toBeInTheDocument()
    expect(list).toHaveAttribute('data-tier', 'row')
  })

  it('uses the row list when viewTier=postit but no onMoveToRail handler is provided', () => {
    const tickets = [makeTicket({ id: 1 })]
    render(
      <SpecsBoard
        tickets={tickets}
        isLoading={false}
        onTicketClick={onTicketClick}
        viewTier="postit"
      />,
    )
    expect(screen.queryByTestId('specs-board-postit-grid')).not.toBeInTheDocument()
    expect(screen.getByTestId('specs-board-list')).toBeInTheDocument()
  })

  it('renders the view tier toggle when onViewTierChange is provided', () => {
    const onViewTierChange = vi.fn()
    render(
      <SpecsBoard
        tickets={[]}
        isLoading={false}
        onTicketClick={onTicketClick}
        viewTier="postit"
        onViewTierChange={onViewTierChange}
      />,
    )
    const rowBtn = screen.getByTestId('specs-view-tier-row')
    expect(rowBtn).toBeInTheDocument()
    fireEvent.click(rowBtn)
    expect(onViewTierChange).toHaveBeenCalledWith('row')
  })

  it('omits the view tier toggle when onViewTierChange is absent', () => {
    render(<SpecsBoard tickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.queryByTestId('specs-view-tier-row')).toBeNull()
  })

  it('shows loading skeletons when isLoading is true', () => {
    render(<SpecsBoard tickets={[]} isLoading={true} onTicketClick={onTicketClick} />)
    const skeletons = document.querySelectorAll('[class*="animate-pulse"]')
    expect(skeletons.length).toBeGreaterThan(0)
  })

  it('renders passed tickets', () => {
    const tickets = [
      makeTicket({ id: 1, title: 'Spec One' }),
      makeTicket({ id: 2, title: 'Spec Two' }),
    ]
    render(<SpecsBoard tickets={tickets} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.getByText('Spec One')).toBeInTheDocument()
    expect(screen.getByText('Spec Two')).toBeInTheDocument()
  })

  it('announces the spec count on the All status segment (no duplicate header pill)', () => {
    const tickets = [makeTicket({ id: 1 }), makeTicket({ id: 2 }), makeTicket({ id: 3 })]
    render(<SpecsBoard tickets={tickets} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.getByTestId('specs-status-count-all')).toHaveTextContent('3')
    const row1 = screen.getByText('Specs').closest('[data-row="primary"]')!
    expect(row1.querySelector('.rounded-full')).toBeNull()
  })

  it('shows zero counts (not hidden) and no filter row when there are no specs', () => {
    render(<SpecsBoard tickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.getByTestId('specs-status-count-all')).toHaveTextContent('0')
    expect(screen.queryByTestId('specs-active-filters')).toBeNull()
  })

  it('opens ProposeSpecModal when Add Spec is clicked', () => {
    render(<SpecsBoard tickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.queryByTestId('propose-spec-modal')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('specs-new-spec'))
    expect(screen.getByTestId('propose-spec-modal')).toBeInTheDocument()
  })

  it('opens ProposeSpecModal via Cmd+Enter keyboard shortcut', () => {
    render(<SpecsBoard tickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
    expect(screen.getByTestId('propose-spec-modal')).toBeInTheDocument()
  })

  it('⌘K New spec opens the same modal, Explore opens it in Explore, and closing resets to Quick', () => {
    render(<SpecsBoard tickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    const surface = getPaletteSurface('specs')!
    act(() => surface.openNewSpec('explore'))
    expect(screen.getByTestId('propose-spec-modal')).toHaveAttribute('data-mode', 'explore')
    fireEvent.click(screen.getByText('close modal'))
    act(() => getPaletteSurface('specs')!.openNewSpec('quick'))
    expect(screen.getByTestId('propose-spec-modal')).toHaveAttribute('data-mode', 'quick')
  })

  it('unregisters its ⌘K surface on unmount', () => {
    const { unmount } = render(<SpecsBoard tickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    expect(getPaletteSurface('specs')).not.toBeNull()
    unmount()
    expect(getPaletteSurface('specs')).toBeNull()
  })

  it('closes ProposeSpecModal when onClose is called', () => {
    render(<SpecsBoard tickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    fireEvent.click(screen.getByTestId('specs-new-spec'))
    expect(screen.getByTestId('propose-spec-modal')).toBeInTheDocument()
    fireEvent.click(screen.getByText('close modal'))
    expect(screen.queryByTestId('propose-spec-modal')).not.toBeInTheDocument()
  })

  it('renders the sort control in the header', () => {
    render(<SpecsBoard tickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.getByLabelText('Sort mode')).toBeInTheDocument()
  })

  it('hides direction arrow when sortMode is default', () => {
    render(<SpecsBoard tickets={[]} isLoading={false} onTicketClick={onTicketClick} sortMode="default" />)
    expect(screen.queryByLabelText('Toggle sort direction')).toBeNull()
  })

  it('shows direction arrow when sortMode is not default', () => {
    render(
      <SpecsBoard
        tickets={[]}
        isLoading={false}
        onTicketClick={onTicketClick}
        sortMode="priority"
        sortDir="desc"
      />,
    )
    expect(screen.getByLabelText('Toggle sort direction')).toBeInTheDocument()
  })

  it('calls onSortChange when direction arrow is clicked', () => {
    const onSortChange = vi.fn()
    render(
      <SpecsBoard
        tickets={[]}
        isLoading={false}
        onTicketClick={onTicketClick}
        sortMode="ticket-id"
        sortDir="desc"
        onSortChange={onSortChange}
      />,
    )
    fireEvent.click(screen.getByLabelText('Toggle sort direction'))
    expect(onSortChange).toHaveBeenCalledWith('ticket-id', 'asc')
  })

  it('does not show the "No specs yet" hint when only done specs exist', () => {
    render(
      <SpecsBoard
        tickets={[]}
        doneTickets={[makeTicket({ id: 9, title: 'Shipped', status: 'done' })]}
        isLoading={false}
        onTicketClick={onTicketClick}
      />,
      { route: '/?status=all' },
    )
    expect(screen.queryByText('No specs yet')).not.toBeInTheDocument()
    expect(screen.queryByText(/Click "New spec" to get started/i)).not.toBeInTheDocument()
    expect(screen.getByText('Done · 1')).toBeInTheDocument()
  })

  it('deletes at once from jiggle mode: no confirm (Undo is the safety net)', () => {
    vi.useFakeTimers()
    try {
      const onTicketDelete = vi.fn()
      const { container } = render(
        <SpecsBoard
          tickets={[makeTicket({ id: 1, title: 'Doomed' })]}
          isLoading={false}
          onTicketClick={onTicketClick}
          onTicketDelete={onTicketDelete}
        />,
      )
      const card = container.querySelector('[data-ticket-id="1"]') as HTMLElement
      fireEvent.pointerDown(card)
      act(() => { vi.advanceTimersByTime(800) })
      fireEvent.click(screen.getByTestId('spec-card-delete-1'))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(onTicketDelete).toHaveBeenCalledWith(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SpecsBoard — filtered-empty Clear filters', () => {
  it('offers Clear filters when a status filter hides every spec, and restores the default view', () => {
    const onTicketClick = vi.fn()
    render(
      <SpecsBoard tickets={[makeTicket({ id: 7, title: 'Hidden spec' })]} isLoading={false} onTicketClick={onTicketClick} />,
      { route: '/?status=draft' },
    )
    expect(screen.queryByText('Hidden spec')).toBeNull()
    fireEvent.click(screen.getByTestId('specs-board-clear-filters'))
    expect(screen.getByText('Hidden spec')).toBeInTheDocument()
    expect(screen.queryByTestId('specs-board-clear-filters')).toBeNull()
  })

  it('does not offer Clear filters on a genuinely empty board', () => {
    render(<SpecsBoard tickets={[]} isLoading={false} onTicketClick={vi.fn()} />)
    expect(screen.queryByTestId('specs-board-clear-filters')).toBeNull()
  })

  it('labels the board landmark with its title', () => {
    render(<SpecsBoard tickets={[]} isLoading={false} onTicketClick={vi.fn()} />)
    expect(screen.getByRole('region', { name: /spec/i })).toBeInTheDocument()
  })
})
