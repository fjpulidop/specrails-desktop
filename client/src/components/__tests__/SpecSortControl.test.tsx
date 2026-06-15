import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { render } from '../../test-utils'
import { SpecSortControl } from '../SpecSortControl'

describe('SpecSortControl', () => {
  it('renders Default label and hides direction arrow when mode is default', () => {
    render(<SpecSortControl mode="default" dir="desc" onChange={() => {}} />)
    expect(screen.getByLabelText('Sort mode')).toHaveTextContent('Default')
    expect(screen.queryByLabelText('Toggle sort direction')).toBeNull()
  })

  it('shows direction arrow when mode is ticket-id', () => {
    render(<SpecSortControl mode="ticket-id" dir="desc" onChange={() => {}} />)
    expect(screen.getByLabelText('Sort mode')).toHaveTextContent('Ticket #')
    expect(screen.getByLabelText('Toggle sort direction')).toBeInTheDocument()
  })

  it('shows direction arrow when mode is priority', () => {
    render(<SpecSortControl mode="priority" dir="asc" onChange={() => {}} />)
    expect(screen.getByLabelText('Sort mode')).toHaveTextContent('Priority')
    expect(screen.getByLabelText('Toggle sort direction')).toBeInTheDocument()
  })

  it('toggles direction from desc to asc on arrow click, preserving mode', () => {
    const onChange = vi.fn()
    render(<SpecSortControl mode="ticket-id" dir="desc" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Toggle sort direction'))
    expect(onChange).toHaveBeenCalledWith('ticket-id', 'asc')
  })

  it('toggles direction from asc to desc on arrow click', () => {
    const onChange = vi.fn()
    render(<SpecSortControl mode="priority" dir="asc" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Toggle sort direction'))
    expect(onChange).toHaveBeenCalledWith('priority', 'desc')
  })

  it('exposes the Jira Ticket # option only when showJiraSort is set', () => {
    const { rerender } = render(
      <SpecSortControl mode="default" dir="desc" onChange={() => {}} showJiraSort={false} />,
    )
    // Radix Select renders items into a portal on open; with the option gated
    // off, the trigger never lists it. Open the listbox and assert absence.
    fireEvent.click(screen.getByLabelText('Sort mode'))
    expect(screen.queryByText('Jira Ticket #')).toBeNull()

    rerender(<SpecSortControl mode="default" dir="desc" onChange={() => {}} showJiraSort />)
    fireEvent.click(screen.getByLabelText('Sort mode'))
    expect(screen.getByText('Jira Ticket #')).toBeInTheDocument()
  })

  it('shows the Jira Ticket # label and direction arrow when mode is jira-key', () => {
    render(<SpecSortControl mode="jira-key" dir="asc" onChange={() => {}} showJiraSort />)
    expect(screen.getByLabelText('Sort mode')).toHaveTextContent('Jira Ticket #')
    expect(screen.getByLabelText('Toggle sort direction')).toBeInTheDocument()
  })

  it('keeps the Jira Ticket # item available when it is the current value even if showJiraSort is false', () => {
    // Invariant: the Select value must always match a rendered item. A persisted
    // jira-key mode during initial load (before DashboardPage resets it) must not
    // produce a value with no matching option.
    render(<SpecSortControl mode="jira-key" dir="desc" onChange={() => {}} showJiraSort={false} />)
    expect(screen.getByLabelText('Sort mode')).toHaveTextContent('Jira Ticket #')
    fireEvent.click(screen.getByLabelText('Sort mode'))
    // Label appears twice: the trigger's SelectValue and the matching option in
    // the open listbox — proving the value always has a backing item.
    expect(screen.getAllByText('Jira Ticket #').length).toBeGreaterThanOrEqual(2)
  })
})
