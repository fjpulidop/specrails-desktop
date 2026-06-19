import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '../../test-utils'
import { SpecComparePicker } from '../SpecComparePicker'
import type { LocalTicket } from '../../types'

function makeTicket(overrides: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id: 1, title: 'Test ticket', description: 'A description', status: 'todo', priority: 'medium',
    labels: [], assignee: null, prerequisites: [], metadata: {},
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'user', source: 'manual',
    ...overrides,
  }
}

const card = (id: number) => screen.queryByTestId(`spec-compare-card-${id}`)

describe('SpecComparePicker', () => {
  it('lists every non-cancelled spec, regardless of status (Jira-friendly)', () => {
    const tickets = [
      makeTicket({ id: 1, status: 'draft' }),
      makeTicket({ id: 2, status: 'todo' }),
      makeTicket({ id: 3, status: 'in_progress', source: 'jira', jira_key: 'P-3' }),
      makeTicket({ id: 4, status: 'done', source: 'jira', jira_key: 'P-4' }),
      makeTicket({ id: 5, status: 'cancelled' }),
    ]
    render(<SpecComparePicker tickets={tickets} excludeIds={[]} onSelect={vi.fn()} />)

    // draft / todo / in_progress / done all comparable...
    expect(card(1)).toBeInTheDocument()
    expect(card(2)).toBeInTheDocument()
    expect(card(3)).toBeInTheDocument()
    expect(card(4)).toBeInTheDocument()
    // ...cancelled is intent-closed and excluded.
    expect(card(5)).toBeNull()
  })

  it('excludes ids already shown in either panel', () => {
    const tickets = [
      makeTicket({ id: 1, status: 'todo' }),
      makeTicket({ id: 2, status: 'in_progress', source: 'jira', jira_key: 'P-2' }),
    ]
    render(<SpecComparePicker tickets={tickets} excludeIds={[1]} onSelect={vi.fn()} />)
    expect(card(1)).toBeNull()
    expect(card(2)).toBeInTheDocument()
  })

  it('filters by search across title and description', () => {
    const tickets = [
      makeTicket({ id: 1, status: 'todo', title: 'Add login', description: 'oauth' }),
      makeTicket({ id: 2, status: 'done', source: 'jira', jira_key: 'P-2', title: 'Fix billing', description: 'stripe webhook' }),
    ]
    render(<SpecComparePicker tickets={tickets} excludeIds={[]} onSelect={vi.fn()} />)

    fireEvent.change(screen.getByTestId('spec-compare-picker').querySelector('input')!, { target: { value: 'stripe' } })
    expect(card(1)).toBeNull()
    expect(card(2)).toBeInTheDocument()
  })

  it('fires onSelect with the clicked ticket id', () => {
    const onSelect = vi.fn()
    render(
      <SpecComparePicker
        tickets={[makeTicket({ id: 7, status: 'done', source: 'jira', jira_key: 'P-7' })]}
        excludeIds={[]}
        onSelect={onSelect}
      />,
    )
    fireEvent.click(card(7)!)
    expect(onSelect).toHaveBeenCalledWith(7)
  })

  it('shows an empty state when no spec is comparable', () => {
    render(
      <SpecComparePicker
        tickets={[makeTicket({ id: 1, status: 'cancelled' })]}
        excludeIds={[]}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByTestId('spec-compare-picker-list').textContent).toBeTruthy()
    expect(card(1)).toBeNull()
  })
})
