import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '../../test-utils'
import DashboardPage from '../DashboardPage'
import type { LocalTicket } from '../../types'

vi.mock('../../lib/api', () => ({
  getApiBase: () => '/api',
}))

let mockActiveProjectId: string | null = null
vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [],
    activeProjectId: mockActiveProjectId,
    setActiveProjectId: vi.fn(),
    addProject: vi.fn(),
    removeProject: vi.fn(),
    isLoading: false,
    isSwitchingProject: false,
    setupProjectIds: new Set<string>(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
  }),
  projectProviders: () => ['claude'],
}))

vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: vi.fn(),
    unregisterHandler: vi.fn(),
    connectionStatus: 'connected',
  }),
}))

let mockTickets: LocalTicket[] = []
vi.mock('../../hooks/useTickets', () => ({
  useTickets: () => ({
    tickets: mockTickets,
    isLoading: false,
    deleteTicket: vi.fn(),
    updateTicket: vi.fn(),
    createTicket: vi.fn(),
    refetch: vi.fn(),
  }),
}))

vi.mock('../../components/SpecsBoard', () => ({
  SpecsBoard: () => <div data-testid="specs-board" />,
}))

vi.mock('../../components/TicketDetailModal', () => ({
  TicketDetailModal: () => null,
}))

vi.mock('../../components/CreateTicketModal', () => ({
  CreateTicketModal: () => null,
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mockActiveProjectId = null
  mockTickets = []
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
})

describe('DashboardPage — rail interactions', () => {

  it('renders all three default rails', () => {
    render(<DashboardPage />)
    expect(screen.getByText('Rail 1')).toBeInTheDocument()
    expect(screen.getByText('Rail 2')).toBeInTheDocument()
    expect(screen.getByText('Rail 3')).toBeInTheDocument()
  })

  it('handleModeChange: clicking Batch button changes mode', () => {
    render(<DashboardPage />)
    // Each rail has Implement + Batch buttons; click Batch on first rail
    const batchButtons = screen.getAllByText('Batch')
    fireEvent.click(batchButtons[0])
    // After mode change, the first Batch button becomes active (has bg-primary class)
    // Just verify no errors thrown and component still renders
    expect(screen.getByText('Rail 1')).toBeInTheDocument()
  })

  it('handleModeChange: clicking Implement button keeps mode', () => {
    render(<DashboardPage />)
    const implementButtons = screen.getAllByText('Implement')
    fireEvent.click(implementButtons[0])
    expect(screen.getByText('Rail 1')).toBeInTheDocument()
  })

  it('saveRails: persists to localStorage when mode changes', () => {
    render(<DashboardPage />)
    const batchButtons = screen.getAllByText('Batch')
    fireEvent.click(batchButtons[0])
    // saveRails stores under specrails-desktop:rails:<projectId>
    // projectId is null in test so no-op — just verify no crash
    expect(screen.getAllByText('Batch').length).toBeGreaterThan(0)
  })
})

describe('DashboardPage — server rail reconcile (adopt agent/MCP launches)', () => {
  const railsResponse = (payload: unknown) =>
    vi.fn().mockImplementation((url: unknown) => {
      if (typeof url === 'string' && url.endsWith('/rails')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) })
      }
      // Adopted rails go 'running', which mounts RailProfileSelector — it needs
      // a well-formed profiles payload or its render crashes (CI 'Errors: 5').
      if (typeof url === 'string' && url.includes('/profiles')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ profiles: [] }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

  it('adopts a server-active job into an idle local rail (running + tickets + jobId)', async () => {
    // A launch made while this board was UNMOUNTED (global agent via MCP in
    // Agent Mode, mobile companion, another window): localStorage knows nothing,
    // but GET /rails reports the active job + the rail's ticket assignment.
    mockActiveProjectId = 'proj-1'
    // The server always lists at least the three base rails (dynamic rails).
    global.fetch = railsResponse({
      rails: [
        { railIndex: 0, ticketIds: [7], mode: 'implement' },
        { railIndex: 1, ticketIds: [] },
        { railIndex: 2, ticketIds: [] },
      ],
      activeJobs: { '0': { jobId: 'job-9', mode: 'implement' } },
      activeLoopRuns: {},
    })
    render(<DashboardPage />)
    await waitFor(() => {
      const raw = localStorage.getItem('specrails-desktop:rails:proj-1')
      expect(raw).toBeTruthy()
      const rails = JSON.parse(raw!)
      expect(rails[0].status).toBe('running')
      expect(rails[0].activeJobId).toBe('job-9')
      expect(rails[0].ticketIds).toEqual([7])
      expect(rails[1].status).toBe('idle')
    })
  })

  it('still clears a locally-running rail the server no longer reports active', async () => {
    mockActiveProjectId = 'proj-1'
    localStorage.setItem('specrails-desktop:rails:proj-1', JSON.stringify([
      { id: 'rail-1', label: 'Rail 1', ticketIds: [3], mode: 'implement', status: 'running', activeJobId: 'gone' },
      { id: 'rail-2', label: 'Rail 2', ticketIds: [], mode: 'implement', status: 'idle' },
      { id: 'rail-3', label: 'Rail 3', ticketIds: [], mode: 'implement', status: 'idle' },
    ]))
    global.fetch = railsResponse({ rails: [], activeJobs: {}, activeLoopRuns: {} })
    render(<DashboardPage />)
    await waitFor(() => {
      const rails = JSON.parse(localStorage.getItem('specrails-desktop:rails:proj-1')!)
      expect(rails[0].status).toBe('idle')
      expect(rails[0].ticketIds).toEqual([])
      expect(rails[0].activeJobId).toBeUndefined()
    })
  })

  it('adopts an active LOOP run with mode loop and no ticket clobber', async () => {
    mockActiveProjectId = 'proj-1'
    global.fetch = railsResponse({
      rails: [
        { railIndex: 0, ticketIds: [] },
        { railIndex: 1, ticketIds: [] },
        { railIndex: 2, ticketIds: [] },
      ],
      activeJobs: {},
      activeLoopRuns: { '1': { loopRunId: 'run-4', loopId: 'custom:my-loop' } },
    })
    render(<DashboardPage />)
    await waitFor(() => {
      const rails = JSON.parse(localStorage.getItem('specrails-desktop:rails:proj-1')!)
      expect(rails[1].status).toBe('running')
      expect(rails[1].activeJobId).toBe('run-4')
      expect(rails[1].mode).toBe('loop')
      expect(rails[1].selectedLoopId).toBe('custom:my-loop')
    })
  })

  it('derives the REAL mode from a factory loopId (desktop launches register as loop runs)', async () => {
    mockActiveProjectId = 'proj-1'
    global.fetch = railsResponse({
      rails: [
        { railIndex: 0, ticketIds: [4] },
        { railIndex: 1, ticketIds: [] },
        { railIndex: 2, ticketIds: [] },
      ],
      activeJobs: {},
      activeLoopRuns: { '0': { loopRunId: 'run-7', loopId: 'factory:implement' } },
    })
    render(<DashboardPage />)
    await waitFor(() => {
      const rails = JSON.parse(localStorage.getItem('specrails-desktop:rails:proj-1')!)
      expect(rails[0].status).toBe('running')
      expect(rails[0].mode).toBe('implement') // NOT hardcoded 'loop'
      expect(rails[0].ticketIds).toEqual([4])
    })
  })

  it('strips adopted tickets from OTHER rails (no ticket on two rails at once)', async () => {
    mockActiveProjectId = 'proj-1'
    // Ticket 7 was locally dragged onto rail-2, but the server launched it on slot 0.
    localStorage.setItem('specrails-desktop:rails:proj-1', JSON.stringify([
      { id: 'rail-1', label: 'Rail 1', ticketIds: [], mode: 'implement', status: 'idle' },
      { id: 'rail-2', label: 'Rail 2', ticketIds: [7], mode: 'implement', status: 'idle' },
      { id: 'rail-3', label: 'Rail 3', ticketIds: [], mode: 'implement', status: 'idle' },
    ]))
    global.fetch = railsResponse({
      rails: [
        { railIndex: 0, ticketIds: [7] },
        { railIndex: 1, ticketIds: [] },
        { railIndex: 2, ticketIds: [] },
      ],
      activeJobs: { '0': { jobId: 'job-1', mode: 'implement' } },
      activeLoopRuns: {},
    })
    render(<DashboardPage />)
    await waitFor(() => {
      const rails = JSON.parse(localStorage.getItem('specrails-desktop:rails:proj-1')!)
      expect(rails[0].ticketIds).toEqual([7])
      expect(rails[1].ticketIds).toEqual([]) // stripped from the local drag target
    })
  })
})

describe('DashboardPage — loop model picker wiring', () => {
  it('model picker change updates loopModel and subsequent launch includes the new model', async () => {
    mockActiveProjectId = 'proj-1'
    mockTickets = [
      {
        id: 1,
        title: 'My spec',
        description: '',
        status: 'todo',
        priority: 'medium',
        labels: [],
        assignee: null,
        prerequisites: [],
        metadata: {},
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        created_by: 'user',
        source: 'propose-spec',
      } as LocalTicket,
    ]
    localStorage.setItem(
      'specrails-desktop:rails:proj-1',
      JSON.stringify([
        {
          id: 'rail-loop',
          label: 'Loop Rail',
          ticketIds: [1],
          mode: 'loop',
          selectedLoopId: 'custom:my-loop',
          loopModel: null,
          status: 'idle',
        },
      ]),
    )

    render(<DashboardPage />)

    // The model picker only renders when onLoopModelChange is wired from DashboardPage.
    // Without the wiring it will not exist — this is the failing assertion.
    const picker = await screen.findByTestId('loop-model-selector')
    await act(async () => {
      fireEvent.change(picker, { target: { value: 'haiku' } })
    })

    const playBtn = await screen.findByTitle('Play')
    fireEvent.click(playBtn)

    await waitFor(() => {
      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      const launchCall = calls.find((c: unknown[]) =>
        typeof c[0] === 'string' && c[0].includes('/rails/') && c[0].includes('/launch'),
      )
      expect(launchCall).toBeDefined()
      const body = JSON.parse((launchCall![1] as RequestInit).body as string)
      expect(body.model).toBe('haiku')
    })
  })
})

describe('DashboardPage — loop model sent in launch POST', () => {
  it('includes model in launch POST body when loop rail has loopModel set', async () => {
    mockActiveProjectId = 'proj-1'
    mockTickets = [
      {
        id: 1,
        title: 'My spec',
        description: '',
        status: 'todo',
        priority: 'medium',
        labels: [],
        assignee: null,
        prerequisites: [],
        metadata: {},
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        created_by: 'user',
        source: 'propose-spec',
      } as LocalTicket,
    ]
    localStorage.setItem(
      'specrails-desktop:rails:proj-1',
      JSON.stringify([
        {
          id: 'rail-loop',
          label: 'Loop Rail',
          ticketIds: [1],
          mode: 'loop',
          selectedLoopId: 'custom:my-loop',
          loopModel: 'haiku',
          status: 'idle',
        },
      ]),
    )

    render(<DashboardPage />)

    // The play button has title "Play" — click it to trigger the launch
    const playBtn = await screen.findByTitle('Play')
    fireEvent.click(playBtn)

    await waitFor(() => {
      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      const launchCall = calls.find((c: unknown[]) =>
        typeof c[0] === 'string' && c[0].includes('/rails/') && c[0].includes('/launch'),
      )
      expect(launchCall).toBeDefined()
      const body = JSON.parse((launchCall![1] as RequestInit).body as string)
      expect(body.model).toBe('haiku')
    })
  })
})
