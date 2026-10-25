import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '../../../../test-utils'
import { useLocation, useNavigate, type Location, type NavigateFunction } from 'react-router-dom'
import DashboardPage from '../DashboardPage'
import type { LocalTicket } from '../../../../types'
import { getPaletteSurface, resetPaletteSurfaces } from '../../../../lib/palette-bridge'

vi.mock('../../../../lib/api', () => ({
  getApiBase: () => '/api',
}))

let activeThemeId = 'dracula'

vi.mock('../../../settings/context/ThemeContext', () => ({
  useActiveTheme: () => ({ id: activeThemeId }),
}))

vi.mock('../../../settings/components/theme-effects/Starfield', () => ({
  Starfield: () => <div data-testid="dashboard-starfield" />,
}))

vi.mock('../../../../hooks/useSharedWebSocket', () => ({
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

vi.mock('../../../specs/hooks/useTickets', () => ({
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
vi.mock('../../../specs/components/SpecsBoard', () => ({
  SpecsBoard: ({ tickets, isLoading, onTicketClick, bulk }: {
    tickets: LocalTicket[]
    isLoading: boolean
    onTicketClick: (t: LocalTicket) => void
    bulk?: import('../../../specs/lib/bulk-actions').SpecBulkHandlers
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
      <button data-testid="bulk-add-to-rail" onClick={() => bulk?.onMoveToRail([tickets[0].id], 'rail-1')}>bulk rail</button>
      <button data-testid="bulk-launch" onClick={() => bulk?.onLaunch(tickets.map((tk) => tk.id))}>bulk launch</button>
    </div>
  ),
}))

vi.mock('../../../specs/components/TicketDetailModal', () => ({
  TicketDetailModal: ({ ticket, onClose }: { ticket: LocalTicket; onClose: () => void }) => (
    <div data-testid="ticket-detail-modal">
      <span data-testid="ticket-detail-title">{ticket.title}</span>
      <button onClick={onClose}>close</button>
    </div>
  ),
}))

vi.mock('../../../specs/components/CreateTicketModal', () => ({
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

  it('includes Project Builder specs, including the legacy manual classification', () => {
    const original = mockTickets
    mockTickets = [
      ...original,
      { ...original[0], id: 101, title: 'Builder spec', source: 'project-builder', created_by: 'project-builder' },
      { ...original[0], id: 102, title: 'Legacy builder spec', source: 'manual', created_by: 'project-builder' },
    ]
    try {
      render(<DashboardPage />)
      expect(screen.getByTestId('specs-board-ticket-count')).toHaveTextContent('3')
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

  describe('spec modal as a place (?spec=)', () => {
    let loc: Location
    let nav: NavigateFunction
    function Probe() {
      loc = useLocation()
      nav = useNavigate()
      return null
    }
    const renderWithProbe = (route = '/') => render(<><DashboardPage /><Probe /></>, { route })

    it('opening a spec writes ?spec=<id> and closing pops back', () => {
      renderWithProbe()
      fireEvent.click(screen.getByTestId('specs-board-open-ticket'))
      expect(loc.search).toBe('?spec=1')
      fireEvent.click(screen.getByText('close'))
      expect(loc.search).toBe('')
      expect(screen.queryByTestId('ticket-detail-modal')).not.toBeInTheDocument()
    })

    it('the browser Back closes the modal and Forward reopens it', () => {
      renderWithProbe()
      fireEvent.click(screen.getByTestId('specs-board-open-ticket'))
      act(() => nav(-1))
      expect(screen.queryByTestId('ticket-detail-modal')).not.toBeInTheDocument()
      act(() => nav(1))
      expect(screen.getByTestId('ticket-detail-title')).toHaveTextContent('Spec ticket')
    })

    it('a link with ?spec= opens that spec', () => {
      renderWithProbe('/?spec=1')
      expect(screen.getByTestId('ticket-detail-title')).toHaveTextContent('Spec ticket')
    })

    it('a link to a spec that does not exist opens nothing', () => {
      renderWithProbe('/?spec=404')
      expect(screen.queryByTestId('ticket-detail-modal')).not.toBeInTheDocument()
    })

    it('filters and sorting do not add history entries', () => {
      renderWithProbe()
      act(() => nav('/?status=done', { replace: true }))
      act(() => nav('/?status=failed&sort=cost', { replace: true }))
      fireEvent.click(screen.getByTestId('specs-board-open-ticket'))
      fireEvent.click(screen.getByText('close'))
      expect(loc.search).toBe('?status=failed&sort=cost')
    })
  })

  describe('⌘K board surface', () => {
    beforeEach(() => resetPaletteSurfaces())

    it('publishes specs, rails and the guards the buttons use', async () => {
      const { unmount } = render(<DashboardPage />)
      const board = getPaletteSurface('board')!
      expect(board).not.toBeNull()
      expect(board.specs()).toEqual([{ id: 1, title: 'Spec ticket', status: 'todo' }])
      expect(board.rails(1).map((r) => r.label)).toEqual(['Rail 1', 'Rail 2', 'Rail 3'])
      expect(board.launchBlocker(1)).toBeNull()
      expect(board.reviewPath(1)).toBeNull()
      // Local specs offer the manual targets, the current one flagged.
      const options = await board.statusOptions(1)
      expect(options.map((o) => [o.id, o.current])).toEqual([['todo', true], ['in_progress', false], ['done', false], ['cancelled', false]])
      unmount()
      expect(getPaletteSurface('board')).toBeNull()
    })

    it('freezes on-review specs exactly like the rail launch does', () => {
      const original = mockTickets
      mockTickets = [{ ...original[0], status: 'on_review' }]
      try {
        render(<DashboardPage />)
        const board = getPaletteSurface('board')!
        expect(board.launchBlocker(1)).not.toBeNull()
        // A blocked launch neither moves the spec nor launches.
        board.launchOnRail(1, board.rails(1)[0].id)
        expect(board.rails(1)[0].hasSpec).toBe(false)
      } finally {
        mockTickets = original
      }
    })

    it('launching a spec that is not on the rail moves it there first', async () => {
      render(<DashboardPage />)
      const board = getPaletteSurface('board')!
      const railId = board.rails(1)[0].id
      act(() => board.launchOnRail(1, railId))
      expect(getPaletteSurface('board')!.rails(1)[0].hasSpec).toBe(true)
    })
  })

  it('CreateTicketModal is not shown initially', () => {
    render(<DashboardPage />)
    expect(screen.queryByTestId('create-ticket-modal')).not.toBeInTheDocument()
  })

  describe('board bulk actions (CD4)', () => {
    it('hands the board its bulk handlers', () => {
      render(<DashboardPage />)
      expect(screen.getByTestId('bulk-add-to-rail')).toBeInTheDocument()
    })

    it('Add to rail moves the spec onto the rail through the board’s own move', () => {
      render(<DashboardPage />)
      fireEvent.click(screen.getByTestId('bulk-add-to-rail'))
      expect(screen.getByText('Spec ticket')).toBeInTheDocument()
    })

    it('Launch all asks for confirmation (LaunchAllDialog) before anything starts, and cancel starts nothing', () => {
      const fetchMock = vi.mocked(global.fetch)
      fetchMock.mockClear()
      render(<DashboardPage />)
      fireEvent.click(screen.getByTestId('bulk-launch'))
      const dialog = screen.getByRole('dialog')
      expect(dialog).toHaveTextContent('1 rail')
      expect(dialog).toHaveTextContent('1 spec')
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/launch'))).toBe(false)
    })
  })
})
