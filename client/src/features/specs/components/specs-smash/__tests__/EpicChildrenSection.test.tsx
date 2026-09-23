import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { EpicChildrenSection, EpicBreadcrumb } from '../EpicChildrenSection'
import type { LocalTicket } from '../../../../../types'

function makeTicket(overrides: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id: 1,
    title: 'Sample',
    description: '',
    status: 'todo',
    priority: 'medium',
    labels: [],
    assignee: null,
    prerequisites: [],
    metadata: {},
    origin_conversation_id: null,
    is_epic: false,
    parent_epic_id: null,
    execution_order: null,
    created_at: '2026-05-16T00:00:00Z',
    updated_at: '2026-05-16T00:00:00Z',
    created_by: 'test',
    source: 'manual',
    ...overrides,
  }
}

describe('EpicChildrenSection', () => {
  it('renders an empty-state when there are no children', () => {
    render(
      <EpicChildrenSection epicId={1} allTickets={[makeTicket({ id: 1, is_epic: true })]} onOpenChild={() => {}} />,
    )
    expect(screen.getByTestId('epic-children-empty')).toBeInTheDocument()
  })

  it('lists children in execution_order ascending', () => {
    const tickets = [
      makeTicket({ id: 1, title: 'Epic', is_epic: true }),
      makeTicket({ id: 3, title: 'C', parent_epic_id: 1, execution_order: 3 }),
      makeTicket({ id: 2, title: 'A', parent_epic_id: 1, execution_order: 1 }),
      makeTicket({ id: 4, title: 'B', parent_epic_id: 1, execution_order: 2 }),
    ]
    render(<EpicChildrenSection epicId={1} allTickets={tickets} onOpenChild={() => {}} />)
    expect(screen.getByText(/Sub-Specs \(3\)/)).toBeInTheDocument()
    const rows = screen.getAllByRole('button').map((b) => b.textContent ?? '')
    expect(rows[0]).toContain('A')
    expect(rows[1]).toContain('B')
    expect(rows[2]).toContain('C')
  })

  it('fires onOpenChild when a child row is clicked', () => {
    const onOpenChild = vi.fn()
    const tickets = [
      makeTicket({ id: 1, is_epic: true }),
      makeTicket({ id: 2, title: 'A', parent_epic_id: 1, execution_order: 1 }),
    ]
    render(<EpicChildrenSection epicId={1} allTickets={tickets} onOpenChild={onOpenChild} />)
    fireEvent.click(screen.getByTestId('epic-child-row-2'))
    expect(onOpenChild).toHaveBeenCalledWith(2)
  })
})

describe('EpicBreadcrumb', () => {
  it('renders the épica title and step indicator', () => {
    const epic = makeTicket({ id: 1, title: 'Real-time collab', is_epic: true })
    render(
      <EpicBreadcrumb
        epic={epic}
        childExecutionOrder={2}
        totalChildren={4}
        onOpenEpic={() => {}}
      />,
    )
    expect(screen.getByText(/Real-time collab/)).toBeInTheDocument()
    expect(screen.getByText(/step 2 of 4/)).toBeInTheDocument()
  })

  it('fires onOpenEpic when clicked', () => {
    const onOpenEpic = vi.fn()
    const epic = makeTicket({ id: 1, title: 'X', is_epic: true })
    render(
      <EpicBreadcrumb epic={epic} childExecutionOrder={1} totalChildren={2} onOpenEpic={onOpenEpic} />,
    )
    fireEvent.click(screen.getByText(/← X/))
    expect(onOpenEpic).toHaveBeenCalled()
  })

  it('hides the step indicator when execution_order is null', () => {
    const epic = makeTicket({ id: 1, title: 'X', is_epic: true })
    render(
      <EpicBreadcrumb epic={epic} childExecutionOrder={null} totalChildren={0} onOpenEpic={() => {}} />,
    )
    expect(screen.queryByText(/step/)).toBeNull()
  })
})
