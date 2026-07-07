import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../test-utils'
import { toast } from 'sonner'
import DashboardPage from '../DashboardPage'
import type { LocalTicket } from '../../types'
import { RailPrDecisionProvider } from '../../context/RailPrDecisionContext'

const { mockSpecsBoard } = vi.hoisted(() => ({
  mockSpecsBoard: vi.fn(),
}))

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
  SpecsBoard: (props: Record<string, unknown>) => {
    mockSpecsBoard(props)
    return <div data-testid="specs-board" />
  },
}))
vi.mock('../../components/TicketDetailModal', () => ({ TicketDetailModal: () => null }))
vi.mock('../../components/CreateTicketModal', () => ({ CreateTicketModal: () => null }))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}))

const ticket = (id: number, status: LocalTicket['status'] = 'todo'): LocalTicket => ({
  id,
  title: `Spec ${id}`,
  description: '',
  status,
  priority: 'medium',
  labels: [],
  assignee: null,
  prerequisites: [],
  metadata: {},
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  created_by: 'user',
  source: 'propose-spec',
} as LocalTicket)

/** Base fetch mock: full 3-rail server snapshot + generic OK for the rest. */
function mockFetch(overrides?: {
  railsPayload?: unknown
  onRequest?: (url: string, init?: RequestInit) => Response | undefined | void
}) {
  return vi.fn().mockImplementation((url: unknown, init?: RequestInit) => {
    const u = String(url)
    const custom = overrides?.onRequest?.(u, init)
    if (custom) return Promise.resolve(custom)
    if (u.endsWith('/rails') && (!init || !init.method || init.method === 'GET')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(overrides?.railsPayload ?? {
          rails: [
            { railIndex: 0, ticketIds: [] },
            { railIndex: 1, ticketIds: [] },
            { railIndex: 2, ticketIds: [] },
          ],
          activeJobs: {},
          activeLoopRuns: {},
        }),
      })
    }
    if (u.includes('/profiles')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ profiles: [] }) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mockActiveProjectId = 'proj-1'
  mockTickets = []
  global.fetch = mockFetch()
})

const seedRails = (rails: unknown[]) =>
  localStorage.setItem('specrails-desktop:rails:proj-1', JSON.stringify(rails))

describe('DashboardPage — Launch all control', () => {
  it('renders the button disabled when no rail is eligible (all empty)', () => {
    render(<DashboardPage />)
    const btn = screen.getByText('Launch all').closest('button')!
    expect(btn).toBeDisabled()
  })

  it('shows the eligible count and opens the confirm dialog', async () => {
    mockTickets = [ticket(1), ticket(2)]
    seedRails([
      { id: 'rail-1', label: 'Rail 1', ticketIds: [1], mode: 'implement', status: 'idle' },
      { id: 'rail-2', label: 'Rail 2', ticketIds: [2], mode: 'implement', status: 'idle' },
      { id: 'rail-3', label: 'Rail 3', ticketIds: [], mode: 'implement', status: 'idle' },
    ])
    render(<DashboardPage />)
    const btn = screen.getByText('Launch all').closest('button')!
    expect(btn).not.toBeDisabled()
    expect(btn.textContent).toContain('2') // eligible-count badge
    fireEvent.click(btn)
    expect(await screen.findByText('Launch all rails')).toBeInTheDocument()
    // Cost framing: 2 rails · 2 specs, confirm labelled with the rail count.
    expect(screen.getByText('Launch 2 rails')).toBeInTheDocument()
  })

  it('skips running / empty / on-review rails from the eligible count', () => {
    mockTickets = [ticket(1), ticket(2, 'on_review'), ticket(3)]
    seedRails([
      { id: 'rail-1', label: 'Rail 1', ticketIds: [1], mode: 'implement', status: 'running', activeJobId: 'j1' },
      { id: 'rail-2', label: 'Rail 2', ticketIds: [2], mode: 'implement', status: 'idle' }, // on_review spec
      { id: 'rail-3', label: 'Rail 3', ticketIds: [3], mode: 'implement', status: 'idle' }, // eligible
    ])
    // Server confirms rail 0 active so the reconcile keeps it running.
    global.fetch = mockFetch({
      railsPayload: {
        rails: [
          { railIndex: 0, ticketIds: [1] },
          { railIndex: 1, ticketIds: [2] },
          { railIndex: 2, ticketIds: [3] },
        ],
        activeJobs: { '0': { jobId: 'j1', mode: 'implement' } },
        activeLoopRuns: {},
      },
    })
    render(<DashboardPage />)
    const btn = screen.getByText('Launch all').closest('button')!
    expect(btn.textContent).toContain('1')
  })

  it('counts an on-review rail with a published PR delivery as eligible for continuation', async () => {
    mockTickets = [ticket(2, 'on_review')]
    seedRails([
      { id: 'rail-1', label: 'Rail 1', ticketIds: [], mode: 'implement', status: 'idle' },
      { id: 'rail-2', label: 'Rail 2', ticketIds: [2], mode: 'implement', status: 'idle' },
      { id: 'rail-3', label: 'Rail 3', ticketIds: [], mode: 'implement', status: 'idle' },
    ])
    global.fetch = mockFetch({
      railsPayload: {
        rails: [
          { railIndex: 0, ticketIds: [] },
          { railIndex: 1, ticketIds: [2] },
          { railIndex: 2, ticketIds: [] },
        ],
        activeJobs: {},
        activeLoopRuns: {},
        prDeliveries: {
          '1': {
            id: 'del-521',
            railIndex: 1,
            railKey: '1-factory:implement',
            ticketIds: [2],
            baseBranch: 'main',
            branch: 'feat/3-add-galaxy-theme-with-blade-trail',
            prUrl: 'https://github.com/o/r/pull/521',
            prNumber: 521,
            prState: 'pr-created',
            decision: 'pr_ready',
            runIds: [],
            originConversationId: null,
          },
        },
      },
    })

    render(
      <RailPrDecisionProvider activeProjectId="proj-1">
        <DashboardPage />
      </RailPrDecisionProvider>,
    )

    await waitFor(() => {
      const btn = screen.getByText('Launch all').closest('button')!
      expect(btn).not.toBeDisabled()
      expect(btn.textContent).toContain('1')
    })
    await waitFor(() => {
      const props = mockSpecsBoard.mock.calls.at(-1)?.[0] as { continuableReviewTicketIds?: ReadonlySet<number> } | undefined
      expect(props?.continuableReviewTicketIds?.has(2)).toBe(true)
    })
  })

  it('confirm → fans out one launch per eligible rail in parallel + one summary toast', async () => {
    mockTickets = [ticket(1), ticket(2)]
    seedRails([
      { id: 'rail-1', label: 'Rail 1', ticketIds: [1], mode: 'implement', status: 'idle' },
      { id: 'rail-2', label: 'Rail 2', ticketIds: [2], mode: 'implement', status: 'idle' },
      { id: 'rail-3', label: 'Rail 3', ticketIds: [], mode: 'implement', status: 'idle' },
    ])
    render(<DashboardPage />)
    fireEvent.click(screen.getByText('Launch all').closest('button')!)
    fireEvent.click(await screen.findByText('Launch 2 rails'))

    await waitFor(() => {
      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      const launches = calls.filter((c: unknown[]) =>
        typeof c[0] === 'string' && /\/rails\/\d+\/launch$/.test(c[0] as string))
      expect(launches.map((c: unknown[]) => c[0])).toEqual(
        expect.arrayContaining(['/api/rails/0/launch', '/api/rails/1/launch']),
      )
      expect(launches).toHaveLength(2) // the empty rail is never launched
    })
    // Ticket sync precedes each launch (same per-rail path as the Play button).
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.some((c: unknown[]) => c[0] === '/api/rails/0/tickets' && (c[1] as RequestInit)?.method === 'PUT')).toBe(true)
    // ONE summary toast, no per-rail success toasts.
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    expect((toast.success as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('2 rails launched in parallel')
    // Both rails flipped to running locally.
    const persisted = JSON.parse(localStorage.getItem('specrails-desktop:rails:proj-1')!)
    expect(persisted[0].status).toBe('running')
    expect(persisted[1].status).toBe('running')
  })

  it('summary toast reports per-reason skips (pr_decision_pending → skipped, not failed)', async () => {
    mockTickets = [ticket(1), ticket(2)]
    seedRails([
      { id: 'rail-1', label: 'Rail 1', ticketIds: [1], mode: 'implement', status: 'idle' },
      { id: 'rail-2', label: 'Rail 2', ticketIds: [2], mode: 'implement', status: 'idle' },
      { id: 'rail-3', label: 'Rail 3', ticketIds: [], mode: 'implement', status: 'idle' },
    ])
    global.fetch = mockFetch({
      onRequest: (u, init) => {
        if (u === '/api/rails/1/launch' && init?.method === 'POST') {
          return {
            ok: false, status: 409,
            json: () => Promise.resolve({ error: 'pr_decision_pending', prDeliveryId: 'd1' }),
          } as unknown as Response
        }
      },
    })
    render(<DashboardPage />)
    fireEvent.click(screen.getByText('Launch all').closest('button')!)
    fireEvent.click(await screen.findByText('Launch 2 rails'))

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    const [msg, opts] = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(msg).toBe('1 rail launched in parallel')
    expect((opts as { description: string }).description).toContain('awaiting a PR decision')
  })

  it('cancel closes the dialog without launching', async () => {
    mockTickets = [ticket(1)]
    seedRails([
      { id: 'rail-1', label: 'Rail 1', ticketIds: [1], mode: 'implement', status: 'idle' },
      { id: 'rail-2', label: 'Rail 2', ticketIds: [], mode: 'implement', status: 'idle' },
      { id: 'rail-3', label: 'Rail 3', ticketIds: [], mode: 'implement', status: 'idle' },
    ])
    render(<DashboardPage />)
    fireEvent.click(screen.getByText('Launch all').closest('button')!)
    fireEvent.click(await screen.findByText('Cancel'))
    await waitFor(() => {
      expect(screen.queryByText('Launch all rails')).not.toBeInTheDocument()
    })
    const launches = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).endsWith('/launch'))
    expect(launches).toHaveLength(0)
  })
})

describe('DashboardPage — server-backed add rail (dynamic rails)', () => {
  it('POSTs /rails and adds the slot with the SERVER-assigned index', async () => {
    global.fetch = mockFetch({
      onRequest: (u, init) => {
        if (u === '/api/rails' && init?.method === 'POST') {
          return {
            ok: true, status: 201,
            json: () => Promise.resolve({ rail: { railIndex: 3, ticketIds: [], mode: 'implement', name: null } }),
          } as unknown as Response
        }
      },
    })
    render(<DashboardPage />)
    fireEvent.click(screen.getByText('Add').closest('button')!)
    await waitFor(() => {
      const rails = JSON.parse(localStorage.getItem('specrails-desktop:rails:proj-1')!)
      expect(rails).toHaveLength(4)
      expect(rails[3].id).toBe('rail-4')
    })
    expect(toast.success).toHaveBeenCalledWith('Rail 4 added')
  })

  it('surfaces the rail_limit_reached error as a toast (no local add)', async () => {
    global.fetch = mockFetch({
      onRequest: (u, init) => {
        if (u === '/api/rails' && init?.method === 'POST') {
          return {
            ok: false, status: 400,
            json: () => Promise.resolve({ error: 'rail_limit_reached', maxRails: 12 }),
          } as unknown as Response
        }
      },
    })
    render(<DashboardPage />)
    fireEvent.click(screen.getByText('Add').closest('button')!)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Rail limit reached (12 max)'))
    const raw = localStorage.getItem('specrails-desktop:rails:proj-1')
    if (raw) expect(JSON.parse(raw)).toHaveLength(3)
  })
})

describe('DashboardPage — reconcile adopts agent-created rails', () => {
  it('appends a server rail this board never knew (created via MCP create_rail)', async () => {
    global.fetch = mockFetch({
      railsPayload: {
        rails: [
          { railIndex: 0, ticketIds: [] },
          { railIndex: 1, ticketIds: [] },
          { railIndex: 2, ticketIds: [] },
          { railIndex: 3, ticketIds: [5], mode: 'implement', name: 'Agent' },
        ],
        activeJobs: {},
        activeLoopRuns: {},
      },
    })
    render(<DashboardPage />)
    await waitFor(() => {
      const rails = JSON.parse(localStorage.getItem('specrails-desktop:rails:proj-1')!)
      expect(rails).toHaveLength(4)
      expect(rails[3]).toMatchObject({ id: 'rail-4', ticketIds: [5] })
      expect(rails[3].label).toBe('Rail Agent')
    })
  })

  it('drops a local empty idle rail the server deleted elsewhere', async () => {
    seedRails([
      { id: 'rail-1', label: 'Rail 1', ticketIds: [], mode: 'implement', status: 'idle' },
      { id: 'rail-2', label: 'Rail 2', ticketIds: [], mode: 'implement', status: 'idle' },
      { id: 'rail-3', label: 'Rail 3', ticketIds: [], mode: 'implement', status: 'idle' },
      { id: 'rail-4', label: 'Rail 4', ticketIds: [], mode: 'implement', status: 'idle' },
    ])
    render(<DashboardPage />) // server reports only the base three
    await waitFor(() => {
      const rails = JSON.parse(localStorage.getItem('specrails-desktop:rails:proj-1')!)
      expect(rails.map((r: { id: string }) => r.id)).toEqual(['rail-1', 'rail-2', 'rail-3'])
    })
  })
})
