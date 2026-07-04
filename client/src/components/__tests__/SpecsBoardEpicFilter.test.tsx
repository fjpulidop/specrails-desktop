import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '../../test-utils'
import { SpecsBoard } from '../SpecsBoard'
import type { LocalTicket } from '../../types'

vi.mock('@dnd-kit/core', () => ({ useDroppable: () => ({ isOver: false, setNodeRef: vi.fn() }) }))
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: vi.fn(),
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, transition: undefined, isDragging: false }),
}))
vi.mock('@dnd-kit/utilities', () => ({ CSS: { Transform: { toString: () => '' }, Translate: { toString: () => '' } } }))
vi.mock('../ProposeSpecModal', () => ({ ProposeSpecModal: () => null }))

function makeTicket(id: number, title: string, epicKey?: string, epicName?: string): LocalTicket {
  return {
    id, title, description: '', status: 'todo', priority: 'medium', labels: [], assignee: null,
    prerequisites: [], metadata: {}, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    created_by: 'tester', source: epicKey ? 'jira' : 'manual',
    ...(epicKey ? { jira_epic_key: epicKey, jira_epic_name: epicName ?? epicKey } : {}),
  }
}

describe('SpecsBoard epic filter', () => {
  const onTicketClick = vi.fn()

  it('hides the epic filter when no spec has an epic', () => {
    render(<SpecsBoard tickets={[makeTicket(1, 'Local')]} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.queryByTestId('spec-epic-filter-dropdown')).toBeNull()
  })

  it('shows the epic filter and filters the board to the chosen epic', () => {
    const tickets = [
      makeTicket(1, 'Auth spec', 'PROJ-100', 'Authentication'),
      makeTicket(2, 'Billing spec', 'PROJ-200', 'Billing'),
      makeTicket(3, 'Another auth spec', 'PROJ-100', 'Authentication'),
    ]
    render(<SpecsBoard tickets={tickets} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />)

    // All three visible initially.
    expect(screen.getByText('Auth spec')).toBeInTheDocument()
    expect(screen.getByText('Billing spec')).toBeInTheDocument()

    // Open the epic dropdown and pick the Authentication epic.
    fireEvent.click(screen.getByTestId('spec-epic-filter-dropdown'))
    fireEvent.click(screen.getByRole('option', { name: /Authentication/ }))

    // Only the two Authentication specs remain.
    expect(screen.getByText('Auth spec')).toBeInTheDocument()
    expect(screen.getByText('Another auth spec')).toBeInTheDocument()
    expect(screen.queryByText('Billing spec')).toBeNull()
    // The Active chip count reflects the filter (2 of 3).
    expect(screen.getByTestId('specs-status-count-active')).toHaveTextContent('2')
  })

  it('clears the filter with "All epics"', () => {
    const tickets = [makeTicket(1, 'Auth spec', 'PROJ-100', 'Authentication'), makeTicket(2, 'Billing spec', 'PROJ-200', 'Billing')]
    render(<SpecsBoard tickets={tickets} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    fireEvent.click(screen.getByTestId('spec-epic-filter-dropdown'))
    fireEvent.click(screen.getByRole('option', { name: /Billing/ }))
    expect(screen.queryByText('Auth spec')).toBeNull()
    fireEvent.click(screen.getByTestId('spec-epic-filter-dropdown'))
    fireEvent.click(screen.getByTestId('spec-epic-filter-all'))
    expect(screen.getByText('Auth spec')).toBeInTheDocument()
    expect(screen.getByText('Billing spec')).toBeInTheDocument()
  })
})
