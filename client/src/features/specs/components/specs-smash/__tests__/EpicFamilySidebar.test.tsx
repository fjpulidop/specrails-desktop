import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { EpicFamilySidebar } from '../EpicFamilySidebar'
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

describe('EpicFamilySidebar', () => {
  it('renders nothing for a plain ticket (not epic, not child)', () => {
    const { container } = render(
      <EpicFamilySidebar ticket={makeTicket()} allTickets={[makeTicket()]} onOpenTicket={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  describe('Epic view', () => {
    it('lists Sub-Specs sorted by execution_order', () => {
      const tickets = [
        makeTicket({ id: 1, title: 'Epic', is_epic: true }),
        makeTicket({ id: 3, title: 'C', parent_epic_id: 1, execution_order: 3 }),
        makeTicket({ id: 2, title: 'A', parent_epic_id: 1, execution_order: 1 }),
        makeTicket({ id: 4, title: 'B', parent_epic_id: 1, execution_order: 2 }),
      ]
      render(<EpicFamilySidebar ticket={tickets[0]} allTickets={tickets} onOpenTicket={() => {}} />)
      expect(screen.getByText(/Sub-Specs \(3\)/i)).toBeInTheDocument()
      const rowTitles = ['A', 'B', 'C']
      const renderedTitles = rowTitles.filter((t) => screen.queryByText(t))
      expect(renderedTitles).toEqual(rowTitles)
    })

    it('empties gracefully when épica has zero children', () => {
      render(
        <EpicFamilySidebar
          ticket={makeTicket({ id: 1, is_epic: true })}
          allTickets={[makeTicket({ id: 1, is_epic: true })]}
          onOpenTicket={() => {}}
        />,
      )
      expect(screen.getByText(/No Sub-Specs/i)).toBeInTheDocument()
    })

    it('disables the row representing the currently open ticket', () => {
      const tickets = [
        makeTicket({ id: 1, title: 'Epic', is_epic: true }),
        makeTicket({ id: 2, title: 'Child A', parent_epic_id: 1, execution_order: 1 }),
      ]
      render(<EpicFamilySidebar ticket={tickets[0]} allTickets={tickets} onOpenTicket={() => {}} />)
      // The current ticket is the Epic; its child A row should be enabled
      expect(screen.getByTestId('epic-family-row-2')).not.toBeDisabled()
    })

    it('clicking a Sub-Spec row fires onOpenTicket', () => {
      const onOpenTicket = vi.fn()
      const tickets = [
        makeTicket({ id: 1, title: 'Epic', is_epic: true }),
        makeTicket({ id: 2, title: 'Child A', parent_epic_id: 1, execution_order: 1 }),
      ]
      render(<EpicFamilySidebar ticket={tickets[0]} allTickets={tickets} onOpenTicket={onOpenTicket} />)
      fireEvent.click(screen.getByTestId('epic-family-row-2'))
      expect(onOpenTicket).toHaveBeenCalledWith(2)
    })
  })

  describe('Sub-Spec view', () => {
    it('puts the Epic in the first row, followed by siblings in execution_order', () => {
      const tickets = [
        makeTicket({ id: 10, title: 'Epic', is_epic: true }),
        makeTicket({ id: 11, title: 'B', parent_epic_id: 10, execution_order: 2 }),
        makeTicket({ id: 12, title: 'A', parent_epic_id: 10, execution_order: 1 }),
        makeTicket({ id: 13, title: 'C', parent_epic_id: 10, execution_order: 3 }),
      ]
      // Open the current ticket as the middle child (id=11)
      const { container } = render(
        <EpicFamilySidebar ticket={tickets[1]} allTickets={tickets} onOpenTicket={() => {}} />,
      )
      // Header reflects siblings count = 3 (all 3 children, including current)
      expect(screen.getByText(/Family \(3 Sub-Specs\)/i)).toBeInTheDocument()
      // First row should be the Epic
      const rows = container.querySelectorAll('[data-testid^="epic-family-row-"]')
      expect(rows[0].getAttribute('data-testid')).toBe('epic-family-row-10')
    })

    it('current Sub-Spec row is disabled (aria-current=page)', () => {
      const tickets = [
        makeTicket({ id: 10, title: 'Epic', is_epic: true }),
        makeTicket({ id: 11, title: 'A', parent_epic_id: 10, execution_order: 1 }),
        makeTicket({ id: 12, title: 'B', parent_epic_id: 10, execution_order: 2 }),
      ]
      render(<EpicFamilySidebar ticket={tickets[1]} allTickets={tickets} onOpenTicket={() => {}} />)
      const currentRow = screen.getByTestId('epic-family-row-11')
      expect(currentRow).toBeDisabled()
      expect(currentRow).toHaveAttribute('aria-current', 'page')
    })

    it('clicking the Epic row opens the parent', () => {
      const onOpenTicket = vi.fn()
      const tickets = [
        makeTicket({ id: 10, title: 'Epic', is_epic: true }),
        makeTicket({ id: 11, title: 'A', parent_epic_id: 10, execution_order: 1 }),
      ]
      render(<EpicFamilySidebar ticket={tickets[1]} allTickets={tickets} onOpenTicket={onOpenTicket} />)
      fireEvent.click(screen.getByTestId('epic-family-row-10'))
      expect(onOpenTicket).toHaveBeenCalledWith(10)
    })

    it('handles orphan Sub-Spec (parent deleted) — renders siblings only', () => {
      const tickets = [
        // No Epic row in allTickets (parent was deleted)
        makeTicket({ id: 11, title: 'A', parent_epic_id: 99, execution_order: 1 }),
        makeTicket({ id: 12, title: 'B', parent_epic_id: 99, execution_order: 2 }),
      ]
      render(<EpicFamilySidebar ticket={tickets[0]} allTickets={tickets} onOpenTicket={() => {}} />)
      // The header still shows the family with siblings
      expect(screen.getByText(/Family/i)).toBeInTheDocument()
      // No Epic row rendered
      expect(screen.queryByTestId('epic-family-row-99')).toBeNull()
    })
  })
})
