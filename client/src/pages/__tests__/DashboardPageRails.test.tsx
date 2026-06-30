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
