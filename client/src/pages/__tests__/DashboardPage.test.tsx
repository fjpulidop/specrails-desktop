import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '../../test-utils'
import DashboardPage from '../DashboardPage'
import type { LocalTicket } from '../../types'

vi.mock('../../lib/api', () => ({
  getApiBase: () => '/api',
}))

let activeThemeId = 'dracula'

vi.mock('../../context/ThemeContext', () => ({
  useActiveTheme: () => ({ id: activeThemeId }),
}))

vi.mock('../../components/theme-effects/Starfield', () => ({
  Starfield: () => <div data-testid="dashboard-starfield" />,
}))

vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: vi.fn(),
    unregisterHandler: vi.fn(),
    connectionStatus: 'connected',
  }),
}))

let mockTickets: LocalTicket[] = [
  {
    id: 1,
    title: 'Spec ticket',
    description: 'A spec',
    status: 'todo',
    priority: 'medium',
    labels: ['backend'],
    assignee: null,
    prerequisites: [],
    metadata: {},
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    created_by: 'user',
    source: 'propose-spec',
  },
]

const mockUpdateTicket = vi.fn()
const mockDeleteTicket = vi.fn()
const mockCreateTicket = vi.fn()

vi.mock('../../hooks/useTickets', () => ({
  useTickets: () => ({
    tickets: mockTickets,
    isLoading: false,
    deleteTicket: mockDeleteTicket,
    updateTicket: mockUpdateTicket,
    createTicket: mockCreateTicket,
  }),
}))

// Mock SpecsBoard to expose onTicketClick for testing
const mockOnTicketClick = vi.fn()
vi.mock('../../components/SpecsBoard', () => ({
  SpecsBoard: ({ tickets, isLoading, onTicketClick }: {
    tickets: LocalTicket[]
    isLoading: boolean
    onTicketClick: (t: LocalTicket) => void
  }) => (
    <div data-testid="specs-board">
      <span data-testid="specs-board-ticket-count">{tickets.length}</span>
      <span data-testid="specs-board-loading">{String(isLoading)}</span>
      <button
        data-testid="specs-board-open-ticket"
        onClick={() => { mockOnTicketClick(tickets[0]); onTicketClick(tickets[0]) }}
      >
        open ticket
      </button>
    </div>
  ),
}))

vi.mock('../../components/TicketDetailModal', () => ({
  TicketDetailModal: ({ ticket, onClose }: { ticket: LocalTicket; onClose: () => void }) => (
    <div data-testid="ticket-detail-modal">
      <span data-testid="ticket-detail-title">{ticket.title}</span>
      <button onClick={onClose}>close</button>
    </div>
  ),
}))

vi.mock('../../components/CreateTicketModal', () => ({
  CreateTicketModal: ({ open }: { open: boolean }) => (
    open ? <div data-testid="create-ticket-modal" /> : null
  ),
}))

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeThemeId = 'dracula'
  })

  it('renders SpecsBoard and Rails panels', () => {
    render(<DashboardPage />)
    expect(screen.getByTestId('specs-board')).toBeInTheDocument()
    expect(screen.getByText('Rails')).toBeInTheDocument()
  })

  it('passes tickets and loading state to SpecsBoard', () => {
    render(<DashboardPage />)
    expect(screen.getByTestId('specs-board-ticket-count')).toHaveTextContent('1')
    expect(screen.getByTestId('specs-board-loading')).toHaveTextContent('false')
  })

  it('mounts Starfield only for the Galaxy theme', () => {
    activeThemeId = 'galaxy'
    const { rerender } = render(<DashboardPage />)

    expect(screen.getByTestId('dashboard-starfield')).toBeInTheDocument()

    activeThemeId = 'dracula'
    rerender(<DashboardPage />)

    expect(screen.queryByTestId('dashboard-starfield')).toBeNull()
  })

  it('includes free-prompt (Raw) tickets on the spec board', () => {
    const original = mockTickets
    mockTickets = [
      ...original,
      { ...original[0], id: 99, title: 'Raw spec', source: 'free-prompt' },
    ]
    try {
      render(<DashboardPage />)
      // Both the propose-spec and the free-prompt ticket must reach the board.
      expect(screen.getByTestId('specs-board-ticket-count')).toHaveTextContent('2')
    } finally {
      mockTickets = original
    }
  })

  it('includes Jira-sourced specs on the spec board', () => {
    // Regression: Jira-backed specs are materialized with source:'jira'. They
    // must pass the board's source allow-list like any other spec.
    const original = mockTickets
    mockTickets = [
      ...original,
      { ...original[0], id: 100, title: 'SKILLS-17', source: 'jira', jira_key: 'SKILLS-17' },
    ]
    try {
      render(<DashboardPage />)
      expect(screen.getByTestId('specs-board-ticket-count')).toHaveTextContent('2')
    } finally {
      mockTickets = original
    }
  })

  it('shows Rails board with rail rows', () => {
    render(<DashboardPage />)
    expect(screen.getByText('Rail 1')).toBeInTheDocument()
    expect(screen.getByText('Rail 2')).toBeInTheDocument()
    expect(screen.getByText('Rail 3')).toBeInTheDocument()
  })

  it('TicketDetailModal is not shown initially', () => {
    render(<DashboardPage />)
    expect(screen.queryByTestId('ticket-detail-modal')).not.toBeInTheDocument()
  })

  it('opens TicketDetailModal when SpecsBoard fires onTicketClick', () => {
    render(<DashboardPage />)
    fireEvent.click(screen.getByTestId('specs-board-open-ticket'))
    expect(screen.getByTestId('ticket-detail-modal')).toBeInTheDocument()
    expect(screen.getByTestId('ticket-detail-title')).toHaveTextContent('Spec ticket')
  })

  it('closes TicketDetailModal on close callback', () => {
    render(<DashboardPage />)
    fireEvent.click(screen.getByTestId('specs-board-open-ticket'))
    expect(screen.getByTestId('ticket-detail-modal')).toBeInTheDocument()
    fireEvent.click(screen.getByText('close'))
    expect(screen.queryByTestId('ticket-detail-modal')).not.toBeInTheDocument()
  })

  it('CreateTicketModal is not shown initially', () => {
    render(<DashboardPage />)
    expect(screen.queryByTestId('create-ticket-modal')).not.toBeInTheDocument()
  })
})
