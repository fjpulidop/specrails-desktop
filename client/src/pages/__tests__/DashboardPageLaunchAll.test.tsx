import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '../../test-utils'
import { toast } from 'sonner'
import DashboardPage from '../../features/dashboard/pages/DashboardPage'
import type { LocalTicket } from '../../types'
import { RailPrDecisionProvider } from '../../features/delivery/context/RailPrDecisionContext'

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
vi.mock('../../features/specs/hooks/useTickets', () => ({
  useTickets: () => ({
    tickets: mockTickets,
    isLoading: false,
    deleteTicket: vi.fn(),
    updateTicket: vi.fn(),
    createTicket: vi.fn(),
    refetch: vi.fn(),
  }),
}))

vi.mock('../../features/specs/components/SpecsBoard', () => ({
  SpecsBoard: (props: Record<string, unknown>) => {
    mockSpecsBoard(props)
    return <div data-testid="specs-board" />
  },
}))
vi.mock('../../features/specs/components/TicketDetailModal', () => ({ TicketDetailModal: () => null }))
vi.mock('../../features/specs/components/CreateTicketModal', () => ({ CreateTicketModal: () => null }))

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
    // Disabled reads as neutral (not faded green) and explains itself.
    expect(btn).toBe(screen.getByTestId('rails-launch-all'))
    expect(btn.className).not.toMatch(/bg-accent-success/)
    expect(screen.getByText('No rail is ready. Drag a spec onto a rail, or press M on a focused card.')).toBeInTheDocument()
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

  it('summary toast counts daily-budget refusals separately (rail-loop-budget-guard)', async () => {
    mockTickets = [ticket(1), ticket(2)]
    seedRails([
      { id: 'rail-1', label: 'Rail 1', ticketIds: [1], mode: 'implement', status: 'idle' },
      { id: 'rail-2', label: 'Rail 2', ticketIds: [2], mode: 'implement', status: 'idle' },
      { id: 'rail-3', label: 'Rail 3', ticketIds: [], mode: 'implement', status: 'idle' },
    ])
    global.fetch = mockFetch({
      onRequest: (u, init) => {
        if (/\/api\/rails\/[01]\/launch$/.test(u) && init?.method === 'POST') {
          return {
            ok: false, status: 409,
            json: () => Promise.resolve({ error: 'daily_budget_exceeded', scope: 'desktop', budgetUsd: 5, spentUsd: 6, resetsAt: null }),
          } as unknown as Response
        }
      },
    })
    render(<DashboardPage />)
    fireEvent.click(screen.getByText('Launch all').closest('button')!)
    fireEvent.click(await screen.findByText('Launch 2 rails'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    const [, opts] = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0]
    expect((opts as { description: string }).description).toContain('2 over the daily budget')
    expect((opts as { description: string }).description).not.toContain('failed')
    const persisted = JSON.parse(localStorage.getItem('specrails-desktop:rails:proj-1')!)
    expect(persisted[0].status).toBe('idle')
  })

  it('summary toast explains a repository without commits instead of counting a raw failure', async () => {
    mockTickets = [ticket(1)]
    seedRails([
      { id: 'rail-1', label: 'Rail 1', ticketIds: [1], mode: 'implement', status: 'idle' },
      { id: 'rail-2', label: 'Rail 2', ticketIds: [], mode: 'implement', status: 'idle' },
    ])
    global.fetch = mockFetch({
      onRequest: (u, init) => {
        if (/\/api\/rails\/0\/launch$/.test(u) && init?.method === 'POST') {
          return {
            ok: false, status: 409,
            json: () => Promise.resolve({ error: 'repository_has_no_commits', detail: 'fatal: invalid reference: HEAD' }),
          } as unknown as Response
        }
      },
    })
    render(<DashboardPage />)
    fireEvent.click(screen.getByText('Launch all').closest('button')!)
    fireEvent.click(await screen.findByText('Launch 1 rail'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    const [, opts] = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0]
    expect((opts as { description: string }).description).toContain('This repository has no commits yet.')
    expect((opts as { description: string }).description).not.toContain('failed')
    expect((opts as { description: string }).description).not.toContain('invalid reference')

    // The summary offers Create initial commit; it posts once and confirms.
    const action = (opts as { action: { label: string; onClick: () => void } }).action
    expect(action.label).toBe('Create initial commit')
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 201, json: async () => ({ sha: 'c'.repeat(40) }) }) as unknown as Response)
    act(() => action.onClick())
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Initial commit created. Launch the rail again.'))
    expect(String(fetchMock.mock.calls.at(-1)![0])).toMatch(/\/api\/projects\/proj-1\/git\/initial-commit$/)
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
    fireEvent.click(screen.getByTestId('rails-add'))
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
    fireEvent.click(screen.getByTestId('rails-add'))
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

describe('DashboardPage — review WIP limit (review-wip-limit)', () => {
  const delivery = (railIndex: number, id: string, ticketIds: number[], decision = 'on_review') => ({
    id, railIndex, railKey: `${railIndex}-factory:implement`, ticketIds, baseBranch: 'main', branch: null,
    prUrl: null, prNumber: null, prState: 'none', decision, runIds: [], originConversationId: null,
    createdAt: `2026-10-21 10:0${railIndex}:00`, updatedAt: `2026-10-21 10:0${railIndex}:00`,
  })

  function setup(limit: number | null, prDeliveries: Record<string, unknown>, onRequest?: (url: string, init?: RequestInit) => Response | undefined | void) {
    mockTickets = [ticket(1), ticket(2), ticket(3), ticket(9), ticket(8)]
    seedRails([
      { id: 'rail-1', label: 'Rail 1', ticketIds: [1], mode: 'implement', status: 'idle' },
      { id: 'rail-2', label: 'Rail 2', ticketIds: [2], mode: 'implement', status: 'idle' },
      { id: 'rail-3', label: 'Rail 3', ticketIds: [3], mode: 'implement', status: 'idle' },
    ])
    global.fetch = mockFetch({
      railsPayload: {
        rails: [{ railIndex: 0, ticketIds: [1] }, { railIndex: 1, ticketIds: [2] }, { railIndex: 2, ticketIds: [3] }],
        activeJobs: {}, activeLoopRuns: {}, prDeliveries,
      },
      onRequest: (u, init) => {
        const custom = onRequest?.(u, init)
        if (custom) return custom
        if (u === '/api/settings') return { ok: true, json: () => Promise.resolve({ reviewWipLimit: limit }) } as unknown as Response
      },
    })
    render(
      <RailPrDecisionProvider activeProjectId="proj-1">
        <DashboardPage />
      </RailPrDecisionProvider>,
    )
  }

  it('at the limit: badge, disabled Play with the reason, and a Launch all dialog that launches nothing', async () => {
    setup(2, { '5': delivery(5, 'd-5', [9]), '6': delivery(6, 'd-6', [8], 'pr_draft') })
    const badge = await screen.findByTestId('review-wip-badge')
    await waitFor(() => expect(badge.textContent).toContain('In review 2/2'))
    expect(badge.getAttribute('data-reached')).toBe('true')
    fireEvent.click(badge)
    const list = await screen.findByTestId('review-wip-list')
    expect(list.textContent).toContain('#9 Spec 9')
    expect(list.textContent).toContain('#8 Spec 8')

    const blocked = await screen.findAllByTestId('rail-play-blocked')
    expect(blocked).toHaveLength(3)
    expect(blocked[0].getAttribute('title')).toBe('Review limit reached (2/2 waiting). Decide a delivery to launch new work.')
    expect(blocked[0].querySelector('button')).toBeDisabled()

    const launchAll = screen.getByText('Launch all').closest('button')!
    expect(launchAll).not.toBeDisabled()
    fireEvent.click(launchAll)
    const notice = await screen.findByTestId('launch-all-review-limit')
    expect(notice.textContent).toContain('Review limit: 2/2 waiting.')
    expect(notice.textContent).toContain('3 rails would open new deliveries, so nothing launches.')
    expect(screen.getByText('Launch 0 rails').closest('button')).toBeDisabled()
    const launches = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).endsWith('/launch'))
    expect(launches).toHaveLength(0)
  })

  it('with partial capacity Launch all starts only up to the remaining slots, in board order, and says so', async () => {
    setup(3, { '5': delivery(5, 'd-5', [9]) })
    await waitFor(() => expect(screen.getByTestId('review-wip-badge').textContent).toContain('In review 1/3'))
    fireEvent.click(screen.getByText('Launch all').closest('button')!)
    const notice = await screen.findByTestId('launch-all-review-limit')
    expect(notice.textContent).toContain('Only 2 can start now; 1 rail waits until a delivery is decided.')
    fireEvent.click(screen.getByText('Launch 2 rails'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    const launches = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => typeof c[0] === 'string' && /\/rails\/\d+\/launch$/.test(c[0] as string))
      .map((c: unknown[]) => c[0])
    expect(launches).toEqual(['/api/rails/0/launch', '/api/rails/1/launch'])
    expect((toast.success as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ description: expect.stringContaining('1 held by the review limit') })
  })

  it('a rail continuing its own delivery is never blocked and takes no slot', async () => {
    setup(1, { '0': delivery(0, 'd-0', [1], 'pr_ready') })
    await waitFor(() => expect(screen.getByTestId('review-wip-badge').textContent).toContain('In review 1/1'))
    // Rails 2 and 3 would open new deliveries → blocked; rail 1 owns d-0 → not blocked.
    expect(await screen.findAllByTestId('rail-play-blocked')).toHaveLength(2)
  })

  it('a server refusal is counted as held by the review limit, not as a failure', async () => {
    setup(5, {}, (u, init) => {
      if (/\/api\/rails\/[01]\/launch$/.test(u) && init?.method === 'POST') {
        return { ok: false, status: 409, json: () => Promise.resolve({ error: 'review_wip_limit_reached', limit: 5, pending: [] }) } as unknown as Response
      }
    })
    await waitFor(() => expect(screen.getByTestId('review-wip-badge').textContent).toContain('In review 0/5'))
    fireEvent.click(screen.getByText('Launch all').closest('button')!)
    fireEvent.click(await screen.findByText('Launch 3 rails'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    const [, opts] = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0]
    expect((opts as { description: string }).description).toContain('2 held by the review limit')
    expect((opts as { description: string }).description).not.toContain('failed')
  })

  it('without a limit there is no badge and nothing is blocked', async () => {
    setup(null, { '5': delivery(5, 'd-5', [9]) })
    await waitFor(() => expect(screen.getByText('Launch all').closest('button')!.textContent).toContain('3'))
    expect(screen.queryByTestId('review-wip-badge')).toBeNull()
    expect(screen.queryAllByTestId('rail-play-blocked')).toHaveLength(0)
  })
})
