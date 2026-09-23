import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '../../test-utils'
import { SpecsBoard } from '../../features/specs/components/SpecsBoard'
import type { LocalTicket } from '../../types'

vi.mock('@dnd-kit/core', () => ({ useDroppable: () => ({ isOver: false, setNodeRef: vi.fn() }) }))
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: vi.fn(),
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, transition: undefined, isDragging: false }),
}))
vi.mock('@dnd-kit/utilities', () => ({ CSS: { Transform: { toString: () => '' }, Translate: { toString: () => '' } } }))
vi.mock('../../features/specs/components/ProposeSpecModal', () => ({ ProposeSpecModal: () => null }))

function makeTicket(id: number, title: string, sprintId?: string, sprintName?: string, sprintState?: string): LocalTicket {
  return {
    id, title, description: '', status: 'todo', priority: 'medium', labels: [], assignee: null,
    prerequisites: [], metadata: {}, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    created_by: 'tester', source: sprintId ? 'jira' : 'manual',
    ...(sprintId ? { jira_sprint_id: sprintId, jira_sprint_name: sprintName ?? sprintId, jira_sprint_state: sprintState } : {}),
  }
}

describe('SpecsBoard sprint filter', () => {
  const onTicketClick = vi.fn()

  it('hides the sprint filter when no spec has a sprint', () => {
    render(<SpecsBoard tickets={[makeTicket(1, 'Local')]} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.queryByTestId('spec-sprint-filter-dropdown')).toBeNull()
  })

  it('shows the sprint filter and filters the board to the chosen sprint', () => {
    const tickets = [
      makeTicket(1, 'Spec in S42', '42', 'Sprint 42'),
      makeTicket(2, 'Spec in S43', '43', 'Sprint 43'),
      makeTicket(3, 'Another S42 spec', '42', 'Sprint 42'),
    ]
    render(<SpecsBoard tickets={tickets} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.getByText('Spec in S42')).toBeInTheDocument()
    expect(screen.getByText('Spec in S43')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('spec-sprint-filter-dropdown'))
    fireEvent.click(screen.getByRole('option', { name: /Sprint 42/ }))

    expect(screen.getByText('Spec in S42')).toBeInTheDocument()
    expect(screen.getByText('Another S42 spec')).toBeInTheDocument()
    expect(screen.queryByText('Spec in S43')).toBeNull()
  })

  it('flags the active sprint as "Current" in the dropdown', () => {
    const tickets = [
      makeTicket(1, 'Closed spec', '42', 'Sprint 42', 'closed'),
      makeTicket(2, 'Active spec', '43', 'Sprint 43', 'active'),
    ]
    render(<SpecsBoard tickets={tickets} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    fireEvent.click(screen.getByTestId('spec-sprint-filter-dropdown'))
    // Exactly one "Current" badge, on the active sprint.
    const badges = screen.getAllByTestId('spec-sprint-current-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0]).toHaveTextContent('Current')
  })

  it('clears the filter with "All sprints"', () => {
    const tickets = [makeTicket(1, 'Spec A', '42', 'Sprint 42'), makeTicket(2, 'Spec B', '43', 'Sprint 43')]
    render(<SpecsBoard tickets={tickets} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    fireEvent.click(screen.getByTestId('spec-sprint-filter-dropdown'))
    fireEvent.click(screen.getByRole('option', { name: /Sprint 43/ }))
    expect(screen.queryByText('Spec A')).toBeNull()
    fireEvent.click(screen.getByTestId('spec-sprint-filter-dropdown'))
    fireEvent.click(screen.getByTestId('spec-sprint-filter-all'))
    expect(screen.getByText('Spec A')).toBeInTheDocument()
    expect(screen.getByText('Spec B')).toBeInTheDocument()
  })
})
