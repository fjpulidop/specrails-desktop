import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '../../../../test-utils'
import { SpecFiltersPopover, countActiveSpecFilters } from '../SpecFiltersPopover'
import type { LocalTicket } from '../../../../types'

function ticket(id: number, over: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id,
    title: `T${id}`,
    description: '',
    status: 'todo',
    priority: 'medium',
    labels: ['auth'],
    assignee: null,
    prerequisites: [],
    metadata: {},
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    created_by: 'tester',
    source: 'manual',
    ...over,
  }
}

type Props = Parameters<typeof SpecFiltersPopover>[0]

function setup(over: Partial<Props> = {}) {
  const props = {
    tickets: [ticket(1), ticket(2, { labels: ['api'], jira_epic_key: 'E-1', jira_epic_name: 'Auth epic', jira_sprint_id: 's1', jira_sprint_name: 'Sprint 1', jira_status: 'Code Review' })],
    jiraStatusTickets: [ticket(2, { jira_status: 'Code Review' })],
    labels: new Set<string>(),
    onLabelsChange: vi.fn(),
    epic: null,
    onEpicChange: vi.fn(),
    sprint: null,
    onSprintChange: vi.fn(),
    jiraStatus: null,
    onJiraStatusChange: vi.fn(),
    showEpic: false,
    showSprint: false,
    showJiraStatus: false,
    onClearAll: vi.fn(),
    compact: false,
    ...over,
  } as Props
  render(<SpecFiltersPopover {...props} />)
  return props
}

describe('countActiveSpecFilters', () => {
  it('counts each label plus each single-select dimension', () => {
    expect(countActiveSpecFilters({ labels: new Set(['a', 'b']), epic: 'E', sprint: null, jiraStatus: 'X' })).toBe(4)
    expect(countActiveSpecFilters({ labels: new Set(), epic: null, sprint: null, jiraStatus: null })).toBe(0)
  })
})

describe('SpecFiltersPopover', () => {
  it('shows the active count on the trigger and in its accessible name', () => {
    setup({ labels: new Set(['auth', 'api']), epic: 'E-1' })
    expect(screen.getByTestId('specs-filters-count')).toHaveTextContent('3')
    expect(screen.getByTestId('specs-filters-trigger')).toHaveAccessibleName('Filters, 3 active')
    expect(screen.getByTestId('specs-filters-trigger')).toHaveAttribute('aria-haspopup', 'dialog')
  })

  it('has no badge when nothing is active, and hides the text when compact', () => {
    setup({ compact: true })
    expect(screen.queryByTestId('specs-filters-count')).toBeNull()
    expect(screen.getByTestId('specs-filters-trigger')).not.toHaveTextContent('Filters')
    expect(screen.getByTestId('specs-filters-trigger')).toHaveAccessibleName('Filters')
  })

  it('opens a dialog and toggling a label calls onLabelsChange', () => {
    const props = setup()
    fireEvent.click(screen.getByTestId('specs-filters-trigger'))
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument()
    expect(screen.getByTestId('specs-filters-trigger')).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('option', { name: /auth/ }))
    expect(props.onLabelsChange).toHaveBeenCalledWith(new Set(['auth']))
  })

  it('renders the epic, sprint and Jira sections only when their flags are set', () => {
    setup()
    fireEvent.click(screen.getByTestId('specs-filters-trigger'))
    expect(screen.getByTestId('spec-filters-section-labels')).toBeInTheDocument()
    expect(screen.queryByTestId('spec-filters-section-epic')).toBeNull()
    expect(screen.queryByTestId('spec-filters-section-sprint')).toBeNull()
    expect(screen.queryByTestId('spec-filters-section-jira-status')).toBeNull()
  })

  it('renders every Jira section when flagged, with a per-section Clear when active', () => {
    const props = setup({ showEpic: true, showSprint: true, showJiraStatus: true, sprint: 's1' })
    fireEvent.click(screen.getByTestId('specs-filters-trigger'))
    expect(screen.getByTestId('spec-filters-section-epic')).toBeInTheDocument()
    expect(screen.getByTestId('spec-filters-section-sprint')).toBeInTheDocument()
    expect(screen.getByTestId('spec-filters-section-jira-status')).toBeInTheDocument()
    expect(screen.queryByTestId('spec-filters-section-clear-epic')).toBeNull()
    fireEvent.click(screen.getByTestId('spec-filters-section-clear-sprint'))
    expect(props.onSprintChange).toHaveBeenCalledWith(null)
  })

  it('Escape closes the panel and returns focus to the trigger', () => {
    setup()
    fireEvent.click(screen.getByTestId('specs-filters-trigger'))
    fireEvent.keyDown(screen.getByTestId('specs-filters-panel'), { key: 'Escape' })
    expect(screen.queryByTestId('specs-filters-panel')).toBeNull()
    expect(screen.getByTestId('specs-filters-trigger')).toHaveFocus()
  })

  it('Clear all is disabled at zero and calls onClearAll otherwise', () => {
    setup()
    fireEvent.click(screen.getByTestId('specs-filters-trigger'))
    expect(screen.getByTestId('specs-filters-clear-all')).toBeDisabled()
  })

  it('Clear all calls onClearAll when something is active; Done closes', () => {
    const props = setup({ labels: new Set(['auth']) })
    fireEvent.click(screen.getByTestId('specs-filters-trigger'))
    fireEvent.click(screen.getByTestId('specs-filters-clear-all'))
    expect(props.onClearAll).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('specs-filters-done'))
    expect(screen.queryByTestId('specs-filters-panel')).toBeNull()
  })

  it('an outside pointerdown closes the panel', () => {
    setup()
    fireEvent.click(screen.getByTestId('specs-filters-trigger'))
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(screen.queryByTestId('specs-filters-panel')).toBeNull()
  })

  it('offers a local label finder once there are more than 8 labels', () => {
    const many = Array.from({ length: 10 }, (_, i) => ticket(i + 1, { labels: [`label-${i}`] }))
    setup({ tickets: many })
    fireEvent.click(screen.getByTestId('specs-filters-trigger'))
    fireEvent.change(screen.getByTestId('spec-label-filter-find'), { target: { value: 'label-3' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['All labels10', 'label-31'])
  })
})
