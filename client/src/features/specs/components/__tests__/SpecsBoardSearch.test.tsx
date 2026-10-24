import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '../../../../test-utils'
import type { LocalTicket } from '../../../../types'

// Control the active project id so a project switch can be simulated.
const h = vi.hoisted(() => ({ activeId: 'proj-A' as string | null }))
vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [],
    activeProjectId: h.activeId,
    setActiveProjectId: () => {},
    addProject: async () => null,
    removeProject: async () => {},
    isLoading: false,
    isSwitchingProject: false,
    setupProjectIds: new Set(),
    startSetupWizard: () => {},
    completeSetupWizard: () => {},
  }),
}))
vi.mock('@dnd-kit/core', () => ({ useDroppable: () => ({ isOver: false, setNodeRef: vi.fn() }) }))
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: vi.fn(),
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, transition: undefined, isDragging: false }),
}))
vi.mock('@dnd-kit/utilities', () => ({ CSS: { Transform: { toString: () => '' }, Translate: { toString: () => '' } } }))
vi.mock('../ProposeSpecModal', () => ({ ProposeSpecModal: () => null }))

import { SpecsBoard } from '../SpecsBoard'

function ticket(id: number, title: string, status: LocalTicket['status'] = 'todo', labels: string[] = []): LocalTicket {
  return {
    id,
    title,
    description: '',
    status,
    priority: 'medium',
    labels,
    assignee: null,
    prerequisites: [],
    metadata: {},
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    created_by: 'tester',
    source: 'manual',
  }
}

const tickets = [
  ticket(1, 'Paddle physics'),
  ticket(2, 'Brick layout', 'todo', ['level']),
  ticket(13, 'Sound effects', 'in_progress'),
]
const doneTickets = [ticket(20, 'Paddle skin', 'done')]
const onTicketClick = vi.fn()

function renderBoard() {
  return render(<SpecsBoard tickets={tickets} doneTickets={doneTickets} isLoading={false} onTicketClick={onTicketClick} />)
}

const search = () => screen.getByTestId('specs-search-input') as HTMLInputElement
const type = (v: string) => fireEvent.change(search(), { target: { value: v } })

describe('SpecsBoard search', () => {
  beforeEach(() => {
    localStorage.clear()
    h.activeId = 'proj-A'
  })

  it('narrows the board and the status counts as you type', () => {
    renderBoard()
    expect(screen.getByTestId('specs-status-count-active')).toHaveTextContent('3')
    type('paddle')
    expect(screen.getByText('Paddle physics')).toBeInTheDocument()
    expect(screen.queryByText('Brick layout')).toBeNull()
    expect(screen.getByTestId('specs-status-count-active')).toHaveTextContent('1')
    expect(screen.getByTestId('specs-status-count-all')).toHaveTextContent('2')
  })

  it('finds a spec by #id', () => {
    renderBoard()
    type('#13')
    expect(screen.getByText('Sound effects')).toBeInTheDocument()
    expect(screen.queryByText('Paddle physics')).toBeNull()
  })

  it('Escape clears the search', () => {
    renderBoard()
    type('brick')
    fireEvent.keyDown(search(), { key: 'Escape' })
    expect(search().value).toBe('')
    expect(screen.getByText('Paddle physics')).toBeInTheDocument()
  })

  it('/ focuses the search from the page, but not while typing in another input', () => {
    render(
      <>
        <input data-testid="other-input" />
        <SpecsBoard tickets={tickets} doneTickets={doneTickets} isLoading={false} onTicketClick={onTicketClick} />
      </>,
    )
    const other = screen.getByTestId('other-input')
    other.focus()
    fireEvent.keyDown(other, { key: '/' })
    expect(other).toHaveFocus()
    other.blur()
    fireEvent.keyDown(document.body, { key: '/' })
    expect(search()).toHaveFocus()
  })

  it('shows a removable search chip in the filter row', () => {
    renderBoard()
    expect(screen.queryByTestId('specs-active-filters')).toBeNull()
    type('paddle')
    const row = screen.getByTestId('specs-active-filters')
    expect(row).toHaveTextContent('Search: "paddle"')
    expect(screen.getByTestId('specs-result-count')).toHaveTextContent('1 of 4')
    fireEvent.click(screen.getByTestId('specs-filter-chip-remove-search'))
    expect(search().value).toBe('')
    expect(screen.queryByTestId('specs-active-filters')).toBeNull()
  })

  it('is cleared on project switch', () => {
    const { rerender } = renderBoard()
    type('paddle')
    h.activeId = 'proj-B'
    rerender(<SpecsBoard tickets={tickets} doneTickets={doneTickets} isLoading={false} onTicketClick={onTicketClick} />)
    expect(search().value).toBe('')
    expect(screen.getByText('Brick layout')).toBeInTheDocument()
  })

  it('Clear all drops search and filters but keeps the status selection', () => {
    renderBoard()
    fireEvent.click(screen.getByTestId('specs-status-chip-done'))
    type('paddle')
    fireEvent.click(screen.getByTestId('specs-active-filters-clear'))
    expect(search().value).toBe('')
    expect(screen.getByTestId('specs-status-chip-done')).toHaveAttribute('aria-checked', 'true')
  })

  it('shows a search-specific empty state', () => {
    renderBoard()
    type('zzz')
    expect(screen.getByText('No specs match "zzz"')).toBeInTheDocument()
    expect(screen.getByTestId('specs-board-clear-filters')).toBeInTheDocument()
  })
})
