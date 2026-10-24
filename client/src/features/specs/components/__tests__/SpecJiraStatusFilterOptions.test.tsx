import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '../../../../test-utils'
import { SpecJiraStatusFilterOptions } from '../SpecJiraStatusFilterOptions'
import type { LocalTicket, TicketStatus } from '../../../../types'

function makeTicket(id: number, status: TicketStatus, jiraStatus: string | null): LocalTicket {
  return {
    id,
    title: `T${id}`,
    description: '',
    status,
    priority: 'medium',
    labels: [],
    assignee: null,
    prerequisites: [],
    metadata: {},
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    created_by: 'tester',
    source: 'jira',
    jira_key: `PROJ-${id}`,
    jira_status: jiraStatus,
  }
}

describe('SpecJiraStatusFilterOptions', () => {
  it('lists each raw status once with its count, grouped by logical state', () => {
    const tickets = [
      makeTicket(1, 'todo', 'To Do'),
      makeTicket(2, 'in_progress', 'Code Review'),
      makeTicket(3, 'in_progress', 'Code Review'),
      makeTicket(4, 'done', 'Released'),
      makeTicket(5, 'cancelled', "Won't Do"),
      makeTicket(6, 'todo', null), // no raw status — excluded from entries + total
    ]
    render(<SpecJiraStatusFilterOptions tickets={tickets} active={null} onChange={() => {}} />)
    const panel = screen.getByTestId('spec-jira-status-filter-panel')

    const todoGroup = within(panel).getByTestId('spec-jira-status-group-todo')
    expect(within(todoGroup).getByTestId('spec-jira-status-option-To Do')).toHaveTextContent('1')
    const wipGroup = within(panel).getByTestId('spec-jira-status-group-in_progress')
    expect(within(wipGroup).getByTestId('spec-jira-status-option-Code Review')).toHaveTextContent('2')
    const doneGroup = within(panel).getByTestId('spec-jira-status-group-done')
    expect(within(doneGroup).getByTestId('spec-jira-status-option-Released')).toHaveTextContent('1')
    const cancelledGroup = within(panel).getByTestId('spec-jira-status-group-cancelled')
    expect(within(cancelledGroup).getByTestId("spec-jira-status-option-Won't Do")).toHaveTextContent('1')
    // Total on the "All" row counts only tickets carrying a raw status.
    expect(within(panel).getByTestId('spec-jira-status-filter-all')).toHaveTextContent('5')
  })

  it('resolves a mixed raw status to the MAJORITY logical group', () => {
    // Transient frozen-window mismatch: 2 tickets say in_progress, 1 says done.
    const tickets = [
      makeTicket(1, 'in_progress', 'QA'),
      makeTicket(2, 'in_progress', 'QA'),
      makeTicket(3, 'done', 'QA'),
    ]
    render(<SpecJiraStatusFilterOptions tickets={tickets} active={null} onChange={() => {}} />)
    const wipGroup = screen.getByTestId('spec-jira-status-group-in_progress')
    expect(within(wipGroup).getByTestId('spec-jira-status-option-QA')).toHaveTextContent('3')
    expect(screen.queryByTestId('spec-jira-status-group-done')).toBeNull()
  })

  it('parks an unresolvable (tied) raw status in the muted Other group', () => {
    const tickets = [makeTicket(1, 'in_progress', 'Limbo'), makeTicket(2, 'done', 'Limbo')]
    render(<SpecJiraStatusFilterOptions tickets={tickets} active={null} onChange={() => {}} />)
    const other = screen.getByTestId('spec-jira-status-group-other')
    expect(within(other).getByTestId('spec-jira-status-option-Limbo')).toHaveTextContent('2')
    expect(within(other).getByText('Other')).toBeInTheDocument()
  })

  it('fires onChange with the raw name on select and null on "All Jira statuses"', () => {
    const onChange = vi.fn()
    const tickets = [makeTicket(1, 'in_progress', 'Code Review')]
    const { rerender } = render(
      <SpecJiraStatusFilterOptions tickets={tickets} active={null} onChange={onChange} />,
    )
    fireEvent.click(screen.getByTestId('spec-jira-status-option-Code Review'))
    expect(onChange).toHaveBeenCalledWith('Code Review')

    rerender(<SpecJiraStatusFilterOptions tickets={tickets} active="Code Review" onChange={onChange} />)
    // The active selection is marked on its option.
    expect(screen.getByTestId('spec-jira-status-option-Code Review')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('spec-jira-status-filter-all')).toHaveAttribute('aria-selected', 'false')
    fireEvent.click(screen.getByTestId('spec-jira-status-filter-all'))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('renders as a labelled listbox (the Filters popover owns open/close)', () => {
    const tickets = [makeTicket(1, 'todo', 'To Do')]
    render(<SpecJiraStatusFilterOptions tickets={tickets} active={null} onChange={() => {}} />)
    expect(screen.getByRole('listbox', { name: 'Filter by Jira status' })).toBeInTheDocument()
  })
})
