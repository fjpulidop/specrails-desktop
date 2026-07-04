import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '../../test-utils'
import { SpecsBoard } from '../SpecsBoard'
import type { LocalTicket } from '../../types'

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
  CSS: { Transform: { toString: () => '' }, Translate: { toString: () => '' } },
}))

vi.mock('../ProposeSpecModal', () => ({
  ProposeSpecModal: () => null,
}))

function makeTicket(id: number, title: string, labels: string[]): LocalTicket {
  return {
    id,
    title,
    description: '',
    status: 'todo',
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

function openLabelDropdown() {
  fireEvent.click(screen.getByTestId('spec-label-filter-dropdown'))
  return screen.getByTestId('spec-label-filter-panel')
}

describe('SpecsBoard label filter dropdown', () => {
  const onTicketClick = vi.fn()

  it('renders an All entry plus one option per label from the active + done tickets', () => {
    const tickets = [
      makeTicket(1, 'Auth one', ['auth']),
      makeTicket(2, 'Auth two', ['auth']),
      makeTicket(3, 'Api one', ['api']),
      makeTicket(4, 'Ui one', ['ui']),
    ]
    render(<SpecsBoard tickets={tickets} isLoading={false} onTicketClick={onTicketClick} />)
    const panel = openLabelDropdown()
    expect(within(panel).getByText('All')).toBeInTheDocument()
    expect(within(panel).getByText('auth')).toBeInTheDocument()
    expect(within(panel).getByText('api')).toBeInTheDocument()
    expect(within(panel).getByText('ui')).toBeInTheDocument()
  })

  it('selecting a single label filters the visible specs', () => {
    const tickets = [
      makeTicket(1, 'Auth one', ['auth']),
      makeTicket(2, 'Api one', ['api']),
      makeTicket(3, 'Ui one', ['ui']),
    ]
    render(<SpecsBoard tickets={tickets} isLoading={false} onTicketClick={onTicketClick} />)
    const panel = openLabelDropdown()
    fireEvent.click(within(panel).getByText('auth'))
    expect(screen.getByText('Auth one')).toBeInTheDocument()
    expect(screen.queryByText('Api one')).toBeNull()
    expect(screen.queryByText('Ui one')).toBeNull()
  })

  it('multi-select uses OR semantics in both the ToDo and Done buckets', () => {
    const tickets = [
      makeTicket(1, 'Auth one', ['auth']),
      makeTicket(2, 'Api one', ['api']),
      makeTicket(3, 'Ui one', ['ui']),
    ]
    const doneTickets = [
      makeTicket(10, 'Done auth', ['auth']),
      makeTicket(11, 'Done api', ['api']),
      makeTicket(12, 'Done ui', ['ui']),
    ]
    render(
      <SpecsBoard tickets={tickets} doneTickets={doneTickets} isLoading={false} onTicketClick={onTicketClick} />,
    )
    const panel = openLabelDropdown()
    fireEvent.click(within(panel).getByText('auth'))
    fireEvent.click(within(panel).getByText('api'))
    // ToDo tab (default): label filter ORs across the active bucket.
    expect(screen.getByText('Auth one')).toBeInTheDocument()
    expect(screen.getByText('Api one')).toBeInTheDocument()
    expect(screen.queryByText('Ui one')).toBeNull()
    // The same filter applies to the Done bucket — switch to the Done chip.
    fireEvent.click(screen.getByTestId('specs-status-chip-done'))
    expect(screen.getByText('Done auth')).toBeInTheDocument()
    expect(screen.getByText('Done api')).toBeInTheDocument()
    expect(screen.queryByText('Done ui')).toBeNull()
  })

  it('All entry clears the active selection', () => {
    const tickets = [
      makeTicket(1, 'Auth one', ['auth']),
      makeTicket(2, 'Api one', ['api']),
    ]
    render(<SpecsBoard tickets={tickets} isLoading={false} onTicketClick={onTicketClick} />)
    const panel = openLabelDropdown()
    fireEvent.click(within(panel).getByText('auth'))
    expect(screen.queryByText('Api one')).toBeNull()
    fireEvent.click(within(panel).getByText('All'))
    expect(screen.getByText('Api one')).toBeInTheDocument()
  })

  it('renders the dropdown trigger even when no tickets carry labels', () => {
    const tickets = [makeTicket(1, 'Plain one', []), makeTicket(2, 'Plain two', [])]
    render(<SpecsBoard tickets={tickets} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.getByTestId('spec-label-filter-dropdown')).toBeInTheDocument()
    const panel = openLabelDropdown()
    expect(within(panel).getByText('No labels in this project.')).toBeInTheDocument()
  })

  it('does not introduce dracula-* tokens in the dropdown trigger or panel', () => {
    const tickets = [
      makeTicket(1, 'Auth one', ['auth']),
      makeTicket(2, 'Api one', ['api']),
    ]
    const { container } = render(
      <SpecsBoard tickets={tickets} isLoading={false} onTicketClick={onTicketClick} />,
    )
    expect(container.querySelector('[data-testid="spec-label-filter-dropdown"]')!.outerHTML).not.toMatch(/dracula-/)
    openLabelDropdown()
    const panel = container.querySelector('[data-testid="spec-label-filter-panel"]')!
    expect(panel.outerHTML).not.toMatch(/dracula-/)
  })
})
