import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '../../test-utils'
import DashboardPage from '../DashboardPage'
import type { LocalTicket, TicketPriority } from '../../types'

vi.mock('../../lib/api', () => ({ getApiBase: () => '/api' }))
vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: vi.fn(),
    unregisterHandler: vi.fn(),
    connectionStatus: 'connected',
  }),
}))
vi.mock('../../hooks/useSpecGenTracker', () => ({
  useSpecGenTracker: () => ({ specToOpen: null, clearSpecToOpen: vi.fn() }),
}))
vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    activeProjectId: 'p-test',
    projects: [],
    setActiveProjectId: vi.fn(),
    addProject: vi.fn(),
    removeProject: vi.fn(),
    isLoading: false,
    isSwitchingProject: false,
    setupProjectIds: new Set(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
  }),
}))

function makeTicket(id: number, priority: TicketPriority | null = 'medium'): LocalTicket {
  return {
    id,
    title: `t-${id}`,
    description: '',
    status: 'todo',
    priority,
    labels: [],
    assignee: null,
    prerequisites: [],
    metadata: {},
    created_at: '',
    updated_at: '',
    created_by: 'u',
    source: 'propose-spec',
  }
}

const tickets: LocalTicket[] = [
  makeTicket(3, 'low'),
  makeTicket(1, 'critical'),
  makeTicket(2, 'medium'),
]

vi.mock('../../hooks/useTickets', () => ({
  useTickets: () => ({
    tickets,
    isLoading: false,
    deleteTicket: vi.fn(),
    updateTicket: vi.fn(),
    createTicket: vi.fn(),
    refetch: vi.fn(),
    contractRefiningIds: new Set(),
  }),
}))

// Mock SpecsBoard to surface the props we want to assert against
let lastSortProps: { mode: string; dir: string; ticketIds: number[] } | null = null
let invokeSortChange: ((mode: string, dir: string) => void) | null = null
vi.mock('../../components/SpecsBoard', () => ({
  SpecsBoard: (props: {
    tickets: LocalTicket[]
    sortMode: string
    sortDir: string
    onSortChange: (mode: string, dir: string) => void
  }) => {
    lastSortProps = {
      mode: props.sortMode,
      dir: props.sortDir,
      ticketIds: props.tickets.map((t) => t.id),
    }
    invokeSortChange = props.onSortChange
    return (
      <div data-testid="specs-board">
        <span data-testid="ids">{props.tickets.map((t) => t.id).join(',')}</span>
        <button
          data-testid="set-ticket-id-desc"
          onClick={() => props.onSortChange('ticket-id', 'desc')}
        >
          ticket-desc
        </button>
        <button
          data-testid="set-priority-desc"
          onClick={() => props.onSortChange('priority', 'desc')}
        >
          priority-desc
        </button>
        <button
          data-testid="set-default"
          onClick={() => props.onSortChange('default', props.sortDir as 'asc' | 'desc')}
        >
          default
        </button>
      </div>
    )
  },
}))

vi.mock('../../components/TicketDetailModal', () => ({
  TicketDetailModal: () => <div />,
}))
vi.mock('../../components/CreateTicketModal', () => ({
  CreateTicketModal: () => null,
}))

describe('DashboardPage sort wiring', () => {
  beforeEach(() => {
    localStorage.clear()
    lastSortProps = null
    invokeSortChange = null
  })

  it('starts in default mode (API order preserved)', () => {
    render(<DashboardPage />)
    expect(screen.getByTestId('ids')).toHaveTextContent('3,1,2')
    expect(lastSortProps?.mode).toBe('default')
  })

  it('switching to ticket-id desc reorders by id descending', () => {
    render(<DashboardPage />)
    fireEvent.click(screen.getByTestId('set-ticket-id-desc'))
    expect(screen.getByTestId('ids')).toHaveTextContent('3,2,1')
  })

  it('switching to priority desc orders by bucket', () => {
    render(<DashboardPage />)
    fireEvent.click(screen.getByTestId('set-priority-desc'))
    // critical (1), medium (2), low (3)
    expect(screen.getByTestId('ids')).toHaveTextContent('1,2,3')
  })

  it('persists sort selection to localStorage and restores on remount', () => {
    const { unmount } = render(<DashboardPage />)
    fireEvent.click(screen.getByTestId('set-priority-desc'))
    expect(localStorage.getItem('specrails-desktop:spec-sort-mode:p-test')).toBe('priority')
    expect(localStorage.getItem('specrails-desktop:spec-sort-dir:p-test')).toBe('desc')
    unmount()

    render(<DashboardPage />)
    expect(lastSortProps?.mode).toBe('priority')
    expect(screen.getByTestId('ids')).toHaveTextContent('1,2,3')
  })

  it('returning to default mode restores API order', () => {
    render(<DashboardPage />)
    fireEvent.click(screen.getByTestId('set-priority-desc'))
    expect(screen.getByTestId('ids')).toHaveTextContent('1,2,3')
    fireEvent.click(screen.getByTestId('set-default'))
    expect(screen.getByTestId('ids')).toHaveTextContent('3,1,2')
  })

  it('resets a persisted jira-key sort to default when the project has no Jira specs', () => {
    // The module-level `tickets` carry no jira_key, so the orphaned jira-key
    // mode must fall back to default (and rewrite localStorage). The reset
    // effect settles within render()'s act flush, so we assert synchronously.
    localStorage.setItem('specrails-desktop:spec-sort-mode:p-test', 'jira-key')
    localStorage.setItem('specrails-desktop:spec-sort-dir:p-test', 'asc')
    render(<DashboardPage />)
    expect(lastSortProps?.mode).toBe('default')
    expect(lastSortProps?.dir).toBe('asc')
    expect(localStorage.getItem('specrails-desktop:spec-sort-mode:p-test')).toBe('default')
    // API order preserved (default mode), not jira/id-sorted.
    expect(screen.getByTestId('ids')).toHaveTextContent('3,1,2')
  })

  it('uses `dir` even after going back to default (preserves direction)', () => {
    render(<DashboardPage />)
    // Move dir to asc by going via priority asc
    act(() => {
      invokeSortChange?.('priority', 'asc')
    })
    act(() => {
      invokeSortChange?.('default', 'asc')
    })
    expect(localStorage.getItem('specrails-desktop:spec-sort-dir:p-test')).toBe('asc')
    act(() => {
      invokeSortChange?.('priority', 'asc')
    })
    // asc order: low(3), medium(2), critical(1)
    expect(screen.getByTestId('ids')).toHaveTextContent('3,2,1')
  })
})
