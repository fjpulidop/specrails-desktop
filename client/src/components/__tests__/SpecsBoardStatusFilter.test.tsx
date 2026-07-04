import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { useLocation } from 'react-router-dom'
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

function makeTicket(
  id: number,
  title: string,
  status: LocalTicket['status'] = 'todo',
  jiraStatus?: string,
): LocalTicket {
  return {
    id,
    title,
    description: '',
    status,
    priority: status === 'draft' ? null : 'medium',
    labels: [],
    assignee: null,
    prerequisites: [],
    metadata: {},
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    created_by: 'tester',
    source: jiraStatus ? 'jira' : 'manual',
    ...(jiraStatus ? { jira_status: jiraStatus, jira_key: `PROJ-${id}` } : {}),
  }
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc-search">{loc.search}</div>
}

// The premium status selector replaced the old ToDo/Done tab pair: every
// TicketStatus gets its own chip with a live count, plus the Active (default)
// and All smart buckets. Default = Active (draft/todo/in_progress/on_review —
// today's default view semantics; done/cancelled are one click away).
describe('SpecsBoard premium status selector', () => {
  const onTicketClick = vi.fn()

  it('defaults to Active — shows the active family, hides cancelled and the Done bucket', () => {
    const tickets = [
      makeTicket(1, 'Draft one', 'draft'),
      makeTicket(2, 'Todo one', 'todo'),
      makeTicket(3, 'Working one', 'in_progress'),
      makeTicket(4, 'Reviewing one', 'on_review'),
      makeTicket(5, 'Abandoned one', 'cancelled'),
    ]
    const doneTickets = [makeTicket(10, 'Done one', 'done')]
    render(<SpecsBoard tickets={tickets} doneTickets={doneTickets} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.getByTestId('specs-status-chip-active')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Draft one')).toBeInTheDocument()
    expect(screen.getByText('Todo one')).toBeInTheDocument()
    expect(screen.getByText('Working one')).toBeInTheDocument()
    expect(screen.getByText('Reviewing one')).toBeInTheDocument()
    // Cancelled and Done never pollute the default view.
    expect(screen.queryByText('Abandoned one')).toBeNull()
    expect(screen.queryByText('Done one')).toBeNull()
    expect(screen.queryByTestId('specs-board-done-bucket')).toBeNull()
  })

  it('renders one chip per status with live counts (plus Active/All buckets)', () => {
    const tickets = [
      makeTicket(1, 'd', 'draft'),
      makeTicket(2, 't1', 'todo'),
      makeTicket(3, 't2', 'todo'),
      makeTicket(4, 'w', 'in_progress'),
      makeTicket(5, 'r', 'on_review'),
      makeTicket(6, 'c', 'cancelled'),
    ]
    const doneTickets = [makeTicket(10, 'x', 'done'), makeTicket(11, 'y', 'done')]
    render(<SpecsBoard tickets={tickets} doneTickets={doneTickets} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.getByTestId('specs-status-count-draft')).toHaveTextContent('1')
    expect(screen.getByTestId('specs-status-count-todo')).toHaveTextContent('2')
    expect(screen.getByTestId('specs-status-count-in_progress')).toHaveTextContent('1')
    expect(screen.getByTestId('specs-status-count-on_review')).toHaveTextContent('1')
    expect(screen.getByTestId('specs-status-count-done')).toHaveTextContent('2')
    expect(screen.getByTestId('specs-status-count-cancelled')).toHaveTextContent('1')
    // Active = draft + todo×2 + in_progress + on_review = 5; All = 8.
    expect(screen.getByTestId('specs-status-count-active')).toHaveTextContent('5')
    expect(screen.getByTestId('specs-status-count-all')).toHaveTextContent('8')
  })

  it('counts recompute live when the ticket props change (WS ticket_updated flow)', () => {
    const tickets = [makeTicket(1, 'a', 'todo')]
    const { rerender } = render(
      <SpecsBoard tickets={tickets} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />,
    )
    expect(screen.getByTestId('specs-status-count-todo')).toHaveTextContent('1')
    expect(screen.getByTestId('specs-status-count-in_progress')).toHaveTextContent('0')
    rerender(
      <SpecsBoard
        tickets={[makeTicket(1, 'a', 'in_progress')]}
        doneTickets={[]}
        isLoading={false}
        onTicketClick={onTicketClick}
      />,
    )
    expect(screen.getByTestId('specs-status-count-todo')).toHaveTextContent('0')
    expect(screen.getByTestId('specs-status-count-in_progress')).toHaveTextContent('1')
  })

  it('clicking the Done chip shows the Done bucket and hides active specs', () => {
    const tickets = [makeTicket(1, 'Active one')]
    const doneTickets = [makeTicket(10, 'Done one', 'done')]
    render(<SpecsBoard tickets={tickets} doneTickets={doneTickets} isLoading={false} onTicketClick={onTicketClick} />)
    fireEvent.click(screen.getByTestId('specs-status-chip-done'))
    expect(screen.queryByText('Active one')).toBeNull()
    expect(screen.getByText('Done one')).toBeInTheDocument()
    expect(screen.getByTestId('specs-board-done-bucket')).toBeInTheDocument()
  })

  it('clicking the Active chip returns to active specs and hides Done', () => {
    const tickets = [makeTicket(1, 'Active one')]
    const doneTickets = [makeTicket(10, 'Done one', 'done')]
    render(<SpecsBoard tickets={tickets} doneTickets={doneTickets} isLoading={false} onTicketClick={onTicketClick} />)
    fireEvent.click(screen.getByTestId('specs-status-chip-done'))
    fireEvent.click(screen.getByTestId('specs-status-chip-active'))
    expect(screen.getByText('Active one')).toBeInTheDocument()
    expect(screen.queryByText('Done one')).toBeNull()
  })

  it('All shows everything: active family + cancelled + the Done bucket pinned last', () => {
    const tickets = [makeTicket(1, 'Active one'), makeTicket(5, 'Abandoned one', 'cancelled')]
    const doneTickets = [makeTicket(10, 'Done one', 'done')]
    render(<SpecsBoard tickets={tickets} doneTickets={doneTickets} isLoading={false} onTicketClick={onTicketClick} />)
    fireEvent.click(screen.getByTestId('specs-status-chip-all'))
    expect(screen.getByText('Active one')).toBeInTheDocument()
    expect(screen.getByText('Abandoned one')).toBeInTheDocument()
    expect(screen.getByText('Done one')).toBeInTheDocument()
    expect(screen.getByTestId('specs-board-done-bucket')).toBeInTheDocument()
  })

  it('an exact status chip narrows the board to that status', () => {
    const tickets = [
      makeTicket(1, 'Todo one', 'todo'),
      makeTicket(2, 'Working one', 'in_progress'),
      makeTicket(3, 'Reviewing one', 'on_review'),
    ]
    render(<SpecsBoard tickets={tickets} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    fireEvent.click(screen.getByTestId('specs-status-chip-in_progress'))
    expect(screen.getByText('Working one')).toBeInTheDocument()
    expect(screen.queryByText('Todo one')).toBeNull()
    expect(screen.queryByText('Reviewing one')).toBeNull()
  })

  it('the Cancelled chip reveals cancelled specs (hidden in the default view)', () => {
    const tickets = [makeTicket(1, 'Active one'), makeTicket(5, 'Abandoned one', 'cancelled')]
    render(<SpecsBoard tickets={tickets} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    expect(screen.queryByText('Abandoned one')).toBeNull()
    fireEvent.click(screen.getByTestId('specs-status-chip-cancelled'))
    expect(screen.getByText('Abandoned one')).toBeInTheDocument()
    expect(screen.queryByText('Active one')).toBeNull()
  })

  it('an on_review spec lives in the Active family with its On Review pill, not in Done', () => {
    const tickets = [makeTicket(1, 'Active one'), makeTicket(2, 'Reviewing one', 'on_review')]
    const doneTickets = [makeTicket(10, 'Done one', 'done')]
    render(<SpecsBoard tickets={tickets} doneTickets={doneTickets} isLoading={false} onTicketClick={onTicketClick} />)
    // Default Active view: the on_review spec renders alongside active specs,
    // visually distinct via the accent-warning On Review pill.
    expect(screen.getByText('Reviewing one')).toBeInTheDocument()
    expect(screen.getByTestId('on-review-badge-2')).toBeInTheDocument()
    expect(screen.getByTestId('specs-status-count-active')).toHaveTextContent('2')
    expect(screen.getByTestId('specs-status-count-on_review')).toHaveTextContent('1')
    // Done view: it must NOT appear there.
    fireEvent.click(screen.getByTestId('specs-status-chip-done'))
    expect(screen.queryByText('Reviewing one')).toBeNull()
  })

  it('renders the Done bucket using the general view tier, with no per-Done controls', () => {
    const doneTickets = [makeTicket(10, 'Done one', 'done')]
    render(
      <SpecsBoard
        tickets={[]}
        doneTickets={doneTickets}
        isLoading={false}
        onTicketClick={onTicketClick}
        onMoveToRail={() => {}}
        viewTier="postit"
      />,
    )
    fireEvent.click(screen.getByTestId('specs-status-chip-done'))
    const doneBucket = screen.getByTestId('specs-board-done-bucket')
    // The general view tier (postit) drives the Done bucket…
    expect(within(doneBucket).getByTestId('specs-board-done-postit-grid')).toBeInTheDocument()
    // …and the Done bucket no longer has its own sort/view controls.
    expect(within(doneBucket).queryByLabelText('Sort mode')).toBeNull()
  })

  it('honours the general row view tier in the Done bucket', () => {
    const doneTickets = [makeTicket(10, 'Done one', 'done')]
    render(
      <SpecsBoard
        tickets={[]}
        doneTickets={doneTickets}
        isLoading={false}
        onTicketClick={onTicketClick}
        onMoveToRail={() => {}}
        viewTier="row"
      />,
    )
    fireEvent.click(screen.getByTestId('specs-status-chip-done'))
    const doneBucket = screen.getByTestId('specs-board-done-bucket')
    expect(within(doneBucket).queryByTestId('specs-board-done-postit-grid')).toBeNull()
    expect(within(doneBucket).getByText('Done one')).toBeInTheDocument()
  })

  it('shows the status empty state when an exact chip has no matching specs', () => {
    const tickets = [makeTicket(1, 'Todo one', 'todo')]
    render(<SpecsBoard tickets={tickets} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    fireEvent.click(screen.getByTestId('specs-status-chip-in_progress'))
    expect(screen.getByText('No specs match the selected status')).toBeInTheDocument()
  })

  // ── URL sync ────────────────────────────────────────────────────────────────

  it('preselects the status from the URL (?status=done deep link)', () => {
    const tickets = [makeTicket(1, 'Active one')]
    const doneTickets = [makeTicket(10, 'Done one', 'done')]
    render(
      <SpecsBoard tickets={tickets} doneTickets={doneTickets} isLoading={false} onTicketClick={onTicketClick} />,
      { route: '/?status=done' },
    )
    expect(screen.getByTestId('specs-status-chip-done')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Done one')).toBeInTheDocument()
    expect(screen.queryByText('Active one')).toBeNull()
  })

  it('ignores an invalid ?status= value and falls back to Active', () => {
    render(
      <SpecsBoard tickets={[makeTicket(1, 'Active one')]} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />,
      { route: '/?status=bogus' },
    )
    expect(screen.getByTestId('specs-status-chip-active')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Active one')).toBeInTheDocument()
  })

  it('writes the selection to the URL and clears it back on the Active default', () => {
    render(
      <>
        <SpecsBoard tickets={[makeTicket(1, 'a')]} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />
        <LocationProbe />
      </>,
    )
    expect(screen.getByTestId('loc-search')).toHaveTextContent('')
    fireEvent.click(screen.getByTestId('specs-status-chip-on_review'))
    expect(screen.getByTestId('loc-search').textContent).toContain('status=on_review')
    fireEvent.click(screen.getByTestId('specs-status-chip-active'))
    expect(screen.getByTestId('loc-search').textContent ?? '').not.toContain('status=')
  })
})

// ── Jira dimension — the board's REAL workflow statuses ──────────────────────

describe('SpecsBoard Jira status dimension', () => {
  const onTicketClick = vi.fn()

  it('hides the Jira status dropdown when no spec carries a raw Jira status', () => {
    render(
      <SpecsBoard tickets={[makeTicket(1, 'Local one')]} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />,
    )
    expect(screen.queryByTestId('spec-jira-status-filter-dropdown')).toBeNull()
  })

  it('groups raw statuses under their logical state with live counts', () => {
    const tickets = [
      makeTicket(1, 'One', 'todo', 'To Do'),
      makeTicket(2, 'Two', 'in_progress', 'In Progress'),
      makeTicket(3, 'Three', 'in_progress', 'Code Review'),
      makeTicket(4, 'Four', 'in_progress', 'Code Review'),
    ]
    const doneTickets = [makeTicket(10, 'Shipped', 'done', 'Done')]
    render(<SpecsBoard tickets={tickets} doneTickets={doneTickets} isLoading={false} onTicketClick={onTicketClick} />)
    fireEvent.click(screen.getByTestId('spec-jira-status-filter-dropdown'))
    const panel = screen.getByTestId('spec-jira-status-filter-panel')
    // Logical groups render in lifecycle order with the raw names inside.
    expect(within(panel).getByTestId('spec-jira-status-group-todo')).toBeInTheDocument()
    expect(within(panel).getByTestId('spec-jira-status-group-in_progress')).toBeInTheDocument()
    expect(within(panel).getByTestId('spec-jira-status-group-done')).toBeInTheDocument()
    // Raw names + counts.
    expect(within(panel).getByTestId('spec-jira-status-option-Code Review')).toHaveTextContent('2')
    expect(within(panel).getByTestId('spec-jira-status-option-In Progress')).toHaveTextContent('1')
    expect(within(panel).getByTestId('spec-jira-status-option-Done')).toHaveTextContent('1')
    // "All Jira statuses" announces the full raw-status population.
    expect(within(panel).getByTestId('spec-jira-status-filter-all')).toHaveTextContent('5')
  })

  it('selecting a raw Jira status filters the board to it', () => {
    const tickets = [
      makeTicket(1, 'One', 'in_progress', 'In Progress'),
      makeTicket(2, 'Two', 'in_progress', 'Code Review'),
    ]
    render(<SpecsBoard tickets={tickets} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    fireEvent.click(screen.getByTestId('spec-jira-status-filter-dropdown'))
    fireEvent.click(screen.getByTestId('spec-jira-status-option-Code Review'))
    expect(screen.getByText('Two')).toBeInTheDocument()
    expect(screen.queryByText('One')).toBeNull()
    // The two dimensions compose (AND): the exact-status chips reflect it too.
    expect(screen.getByTestId('spec-jira-status-filter-dropdown')).toHaveTextContent('Code Review')
  })

  it('clears the raw status via "All Jira statuses"', () => {
    const tickets = [
      makeTicket(1, 'One', 'in_progress', 'In Progress'),
      makeTicket(2, 'Two', 'in_progress', 'Code Review'),
    ]
    render(<SpecsBoard tickets={tickets} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    fireEvent.click(screen.getByTestId('spec-jira-status-filter-dropdown'))
    fireEvent.click(screen.getByTestId('spec-jira-status-option-Code Review'))
    expect(screen.queryByText('One')).toBeNull()
    fireEvent.click(screen.getByTestId('spec-jira-status-filter-dropdown'))
    fireEvent.click(screen.getByTestId('spec-jira-status-filter-all'))
    expect(screen.getByText('One')).toBeInTheDocument()
    expect(screen.getByText('Two')).toBeInTheDocument()
  })

  it('composes with the local status dimension (AND)', () => {
    const tickets = [
      makeTicket(1, 'Working', 'in_progress', 'Code Review'),
      makeTicket(2, 'Reviewing', 'on_review', 'Code Review'),
    ]
    render(<SpecsBoard tickets={tickets} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />)
    fireEvent.click(screen.getByTestId('spec-jira-status-filter-dropdown'))
    fireEvent.click(screen.getByTestId('spec-jira-status-option-Code Review'))
    // Raw filter alone: both visible under Active.
    expect(screen.getByText('Working')).toBeInTheDocument()
    expect(screen.getByText('Reviewing')).toBeInTheDocument()
    // AND the on_review chip: only the on_review one remains.
    fireEvent.click(screen.getByTestId('specs-status-chip-on_review'))
    expect(screen.getByText('Reviewing')).toBeInTheDocument()
    expect(screen.queryByText('Working')).toBeNull()
  })

  it('preselects the raw status from the URL (?jiraStatus=… deep link) and writes changes back', () => {
    const tickets = [
      makeTicket(1, 'One', 'in_progress', 'In Progress'),
      makeTicket(2, 'Two', 'in_progress', 'Code Review'),
    ]
    render(
      <>
        <SpecsBoard tickets={tickets} doneTickets={[]} isLoading={false} onTicketClick={onTicketClick} />
        <LocationProbe />
      </>,
      { route: '/?jiraStatus=Code%20Review' },
    )
    expect(screen.getByText('Two')).toBeInTheDocument()
    expect(screen.queryByText('One')).toBeNull()
    fireEvent.click(screen.getByTestId('spec-jira-status-filter-dropdown'))
    fireEvent.click(screen.getByTestId('spec-jira-status-filter-all'))
    expect(screen.getByTestId('loc-search').textContent ?? '').not.toContain('jiraStatus=')
  })
})
