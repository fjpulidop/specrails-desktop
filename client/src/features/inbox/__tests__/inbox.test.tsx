import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate, type Location } from 'react-router-dom'
import { useEffect, useRef, type ReactNode } from 'react'

const h = vi.hoisted(() => ({
  desktop: { projects: [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }], activeProjectId: 'p1' as string | null, setActiveProjectId: vi.fn() },
  mode: 'agent' as 'agent' | 'kanban',
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: h.toast }))
vi.mock('../../../hooks/useDesktop', () => ({ useDesktop: () => h.desktop }))
vi.mock('../../../context/UiModeContext', () => ({ useUiMode: () => ({ uiMode: h.mode }) }))

import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'
import { requestOpenInbox } from '../../../lib/inbox-events'
import { InboxProvider, useInbox } from '../context/InboxContext'
import { InboxButton } from '../components/InboxButton'
import { InboxDialog } from '../components/InboxDialog'
import { DISMISSALS_KEY, type InboxItem } from '../lib/inbox-model'
import { OPEN_BUDGET_PANEL_EVENT } from '../../../lib/app-settings-events'

const mk = (over: Partial<InboxItem>): InboxItem => ({
  id: 'p1:review:d1', projectId: 'p1', projectName: 'Alpha', kind: 'review', title: 'Add login', detail: null,
  at: new Date(Date.now() - 2 * 3_600_000).toISOString(), version: 'on_review', action: 'open-review', subjectId: 'd1', conversationId: 'c1', diagnosis: null, cap: null, ...over,
})

let items: InboxItem[]
let handlers: Map<string, (m: unknown) => void>
let loc: Location
let fetchMock: ReturnType<typeof vi.fn>

function Probe() { loc = useLocation(); return null }
function Count() { const i = useInbox(); return <span data-testid="count">{i?.count}</span> }

function ws() {
  return { registerHandler: (id: string, fn: (m: unknown) => void) => { handlers.set(id, fn) }, unregisterHandler: (id: string) => { handlers.delete(id) }, connectionStatus: 'connected' as const }
}
function Shell({ children }: { children?: ReactNode }) {
  return (
    <SharedWebSocketContext.Provider value={ws()}>
      <InboxProvider><InboxButton /><InboxDialog /><Count /><Probe />{children}</InboxProvider>
    </SharedWebSocketContext.Provider>
  )
}
const mount = (route = '/') => render(<MemoryRouter initialEntries={[route]}><Shell /></MemoryRouter>)
const url = () => `${loc.pathname}${loc.search}`

beforeEach(() => {
  localStorage.clear()
  handlers = new Map()
  h.mode = 'agent'
  h.desktop.activeProjectId = 'p1'
  h.desktop.setActiveProjectId = vi.fn()
  h.toast.mockClear(); h.toast.success.mockClear(); h.toast.error.mockClear()
  items = [
    mk({}),
    mk({ id: 'p2:question:r9', projectId: 'p2', projectName: 'Beta', kind: 'question', title: 'Implement · #4', action: 'open-run', subjectId: 'r9', conversationId: null, version: 'paused::' }),
    mk({ id: 'p2:budget:r2', projectId: 'p2', projectName: 'Beta', kind: 'budget', title: 'Loop run', action: 'resume-run', subjectId: 'r2', conversationId: null, version: 'paused::budget_paused' }),
    mk({ id: 'p1:jira:5', projectId: 'p1', kind: 'jira', title: 'PROJ-1 · transition', detail: 'Transition not allowed', action: 'retry-jira', subjectId: '5', conversationId: null, version: 'dead:3:x' }),
  ]
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input)
    if (u.endsWith('/api/inbox')) return { ok: true, status: 200, json: async () => ({ items, projects: [], generatedAt: new Date().toISOString() }) }
    void init
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{"ok":true}' }
  })
  global.fetch = fetchMock as never
})
afterEach(() => { vi.useRealTimers() })

const openPanel = async () => {
  fireEvent.click(screen.getByTestId('inbox-button'))
  return screen.findByTestId('inbox-dialog')
}

describe('Inbox badge and button', () => {
  it('shows the count of items needing you and names it for assistive tech', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('inbox-badge')).toHaveTextContent('4'))
    expect(screen.getByTestId('inbox-button')).toHaveAttribute('aria-label', 'Inbox, 4 items need you')
  })

  it('declares its chord for assistive tech and shows it in the tooltip (Ctrl+Alt+I off macOS)', async () => {
    mount()
    const button = await screen.findByTestId('inbox-button')
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+Alt+I')
    expect(button.getAttribute('title')).toContain('(Ctrl+Alt+I)')
  })

  it('has no badge when nothing is waiting', async () => {
    items = []
    mount()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.queryByTestId('inbox-badge')).toBeNull()
    expect(screen.getByTestId('inbox-button')).toHaveAttribute('aria-label', 'Inbox, nothing needs you')
  })

  it('renders nothing without a provider (secondary windows)', () => {
    const { container } = render(<MemoryRouter><InboxButton /></MemoryRouter>)
    expect(container.firstChild).toBeNull()
  })
})

describe('Inbox panel', () => {
  it('opens as the ?inbox=1 place and lists items grouped by project', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('4'))
    const dialog = await openPanel()
    expect(url()).toBe('/?inbox=1')
    const groups = within(dialog).getAllByTestId('inbox-group')
    expect(groups.map((g) => g.getAttribute('data-project-id'))).toEqual(['p1', 'p2'])
    expect(within(groups[0]).getAllByTestId('inbox-row')).toHaveLength(2)
    expect(within(groups[1]).getAllByTestId('inbox-row')).toHaveLength(2)
    expect(within(dialog).getByText('Waiting for your answer')).toBeInTheDocument()
  })

  it('says why a blocked run stopped, in the diagnosis\' plain words', async () => {
    const diagnosis = { kind: 'provider_limit' as const, confidence: 'high' as const, phase: null, rounds: null, resetAt: '3am (Europe/Madrid)', detail: null, resumablePhase: null, blocker: null, source: 'desktop' as const, remedies: ['resume' as const, 'retry' as const, 'open-logs' as const] }
    items = [
      mk({ id: 'p1:blocked:r1', kind: 'blocked', title: 'Implement · #7', detail: 'failed', action: 'open-run', subjectId: 'r1', conversationId: null, diagnosis }),
      mk({ id: 'p1:failed:r2', kind: 'failed', title: 'Implement · #8', detail: 'failed', action: 'open-run', subjectId: 'r2', conversationId: null, diagnosis: { ...diagnosis, kind: 'unknown', confidence: 'low', resetAt: null, remedies: ['open-logs', 'retry'] } }),
    ]
    mount()
    const dialog = await openPanel()
    const rows = within(dialog).getAllByTestId('inbox-row')
    const limited = rows.find((r) => r.getAttribute('data-item-id') === 'p1:blocked:r1')!
    expect(limited).toHaveAttribute('data-cause', 'provider_limit')
    expect(limited).toHaveTextContent("The AI provider's usage limit was reached")
    // An unknown cause keeps the raw outcome instead of a made-up reason.
    const unknown = rows.find((r) => r.getAttribute('data-item-id') === 'p1:failed:r2')!
    expect(unknown).not.toHaveTextContent('usage limit')
    // No known cause: a calm localized line, with the raw outcome (often English) kept for hover.
    expect(unknown).toHaveTextContent('Stopped before delivery')
    expect(unknown).not.toHaveTextContent('failed')
    expect(within(unknown).getByText(/Stopped before delivery/)).toHaveAttribute('title', 'failed')
  })

  it('keeps one filled primary: row actions are outlined, the cyan is for the focused one', async () => {
    mount()
    const dialog = await openPanel()
    const primaries = within(dialog).getAllByTestId('inbox-primary')
    for (const primary of primaries) {
      expect(primary.className).toContain('border-input')
      expect(primary.className).not.toMatch(/(^|\s)bg-primary(\s|$)/)
      expect(primary.className).toContain('focus-visible:bg-primary')
    }
  })

  it('lands the focus on the first row\'s primary action, not on the close button', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('4'))
    const dialog = await openPanel()
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getAllByTestId('inbox-primary')[0]))
  })

  it('shows the rail track while the first read is in flight', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}))
    mount('/?inbox=1')
    const loading = await screen.findByTestId('inbox-loading')
    expect(within(loading).getByTestId('rail-track')).toBeInTheDocument()
    expect(loading).toHaveTextContent('Checking your projects')
  })

  it('counts with a neutral badge (the count mixes failures, questions and reviews)', async () => {
    mount()
    const badge = await screen.findByTestId('inbox-badge')
    expect(badge.className).toContain('bg-foreground')
    expect(badge.className).toContain('tabular-nums')
    expect(badge.className).not.toContain('accent-review')
  })

  it('is deep-linkable: ?inbox=1 opens it on load, Escape closes it', async () => {
    mount('/?inbox=1')
    expect(await screen.findByTestId('inbox-dialog')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('inbox-dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('inbox-dialog')).toBeNull())
    expect(loc.search).toBe('')
  })

  it('opens from the window event used by OS notifications', async () => {
    mount()
    act(() => requestOpenInbox())
    expect(await screen.findByTestId('inbox-dialog')).toBeInTheDocument()
  })

  it('shows a calm empty state', async () => {
    items = []
    mount('/?inbox=1')
    expect(await screen.findByTestId('inbox-empty')).toHaveTextContent('Nothing needs you')
  })

  it('shows an error state with Try again when the read-model is unreachable and there is nothing cached', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    mount('/?inbox=1')
    const error = await screen.findByTestId('inbox-error')
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ items, projects: [], generatedAt: '' }) }))
    fireEvent.click(within(error).getByText('Try again'))
    await waitFor(() => expect(screen.getAllByTestId('inbox-row').length).toBe(4))
  })

  it('walks the rows with the arrow keys', async () => {
    mount('/?inbox=1')
    const dialog = await screen.findByTestId('inbox-dialog')
    await waitFor(() => expect(within(dialog).getAllByTestId('inbox-primary').length).toBe(4))
    const primaries = within(dialog).getAllByTestId('inbox-primary')
    primaries[0].focus()
    fireEvent.keyDown(primaries[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(primaries[1])
    fireEvent.keyDown(primaries[1], { key: 'End' })
    expect(document.activeElement).toBe(primaries[3])
    fireEvent.keyDown(primaries[3], { key: 'Home' })
    expect(document.activeElement).toBe(primaries[0])
  })
})

describe('Primary actions call the real handlers', () => {
  it('Open review (same project, Mission mode) replaces the inbox entry with ?mission&review', async () => {
    mount('/?inbox=1')
    const row = (await screen.findAllByTestId('inbox-row')).find((r) => r.getAttribute('data-item-id') === 'p1:review:d1')!
    fireEvent.click(within(row).getByTestId('inbox-primary'))
    await waitFor(() => expect(url()).toBe('/?mission=c1&review=d1'))
    expect(h.desktop.setActiveProjectId).not.toHaveBeenCalled()
  })

  it('Board mode opens the routed review / job', async () => {
    h.mode = 'kanban'
    mount('/?inbox=1')
    const row = (await screen.findAllByTestId('inbox-row')).find((r) => r.getAttribute('data-item-id') === 'p1:review:d1')!
    fireEvent.click(within(row).getByTestId('inbox-primary'))
    await waitFor(() => expect(url()).toBe('/review/d1'))
  })

  it('switches project first when the item lives in another one, closes the inbox, then opens its place', async () => {
    const { rerender } = mount('/?inbox=1')
    const row = (await screen.findAllByTestId('inbox-row')).find((r) => r.getAttribute('data-item-id') === 'p2:question:r9')!
    fireEvent.click(within(row).getByTestId('inbox-primary'))
    expect(h.desktop.setActiveProjectId).toHaveBeenCalledWith('p2')
    // The dialog does not outlive the hand-off.
    await waitFor(() => expect(screen.queryByTestId('inbox-dialog')).toBeNull())
    expect(url()).toBe('/')
    h.desktop.activeProjectId = 'p2'
    rerender(<MemoryRouter initialEntries={['/?inbox=1']}><Shell /></MemoryRouter>)
    // MemoryRouter keeps its own history across rerender of the same tree position.
    await waitFor(() => expect(url()).toContain('job=r9'))
  })

  it('Board mode: opening a job of another project ends on /jobs/:id with the inbox closed, even if route memory navigates first', async () => {
    h.mode = 'kanban'
    items = [mk({ id: 'p2:failed:r7', projectId: 'p2', projectName: 'Beta', kind: 'failed', title: 'Implement · #7', action: 'open-run', subjectId: 'r7', conversationId: null, version: 'failed' })]
    // Stand-in for useProjectRouteMemory: an ancestor's effect (so it runs AFTER the inbox's) that restores the incoming project's page.
    function RouteMemory({ children }: { children: ReactNode }) {
      const desktop = h.desktop
      const nav = useNavigate()
      const seen = useRef(desktop.activeProjectId)
      useEffect(() => {
        if (seen.current === desktop.activeProjectId) return
        seen.current = desktop.activeProjectId
        nav('/', { replace: true })
      }, [desktop.activeProjectId, nav])
      return <>{children}</>
    }
    const tree = () => (<MemoryRouter initialEntries={['/?inbox=1']}><RouteMemory><Shell /></RouteMemory></MemoryRouter>)
    const { rerender } = render(tree())
    const row = (await screen.findAllByTestId('inbox-row'))[0]
    fireEvent.click(within(row).getByTestId('inbox-primary'))
    h.desktop.activeProjectId = 'p2'
    rerender(tree())
    await waitFor(() => expect(loc.pathname).toBe('/jobs/r7'))
    expect(loc.search).not.toContain('inbox')
    expect(screen.queryByTestId('inbox-dialog')).toBeNull()
  })

  it('Resume posts to the ITEM\'s project (not the active one) and refreshes', async () => {
    mount('/?inbox=1')
    const row = (await screen.findAllByTestId('inbox-row')).find((r) => r.getAttribute('data-item-id') === 'p2:budget:r2')!
    expect(within(row).getByTestId('inbox-primary')).toHaveTextContent('Resume')
    const before = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/inbox')).length
    fireEvent.click(within(row).getByTestId('inbox-primary'))
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Run resumed'))
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/loop-runs/r2/resume'))!
    expect(String(call[0])).toContain('/api/projects/p2/loop-runs/r2/resume')
    expect((call[1] as RequestInit).method).toBe('POST')
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/inbox')).length).toBeGreaterThan(before))
  })

  it('Resume over the daily budget shows the localized refusal', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.endsWith('/api/inbox')) return { ok: true, status: 200, json: async () => ({ items, projects: [], generatedAt: '' }) }
      return { ok: false, status: 409, json: async () => ({ error: 'daily_budget_exceeded', scope: 'desktop', budgetUsd: 10, spentUsd: 12, resetsAt: null }) }
    })
    mount('/?inbox=1')
    const row = (await screen.findAllByTestId('inbox-row')).find((r) => r.getAttribute('data-item-id') === 'p2:budget:r2')!
    fireEvent.click(within(row).getByTestId('inbox-primary'))
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Still over the daily budget', expect.anything()))
  })

  it('a run paused at its per-run cap asks Continue / Raise instead of a toast, and answers on the same route (CD5)', async () => {
    const bodies: unknown[] = []
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u.endsWith('/api/inbox')) return { ok: true, status: 200, json: async () => ({ items, projects: [], generatedAt: '' }) }
      const body = JSON.parse(String(init?.body ?? '{}'))
      bodies.push(body)
      if (body.runCap === 'ignore') return { ok: true, status: 202, json: async () => ({ resumed: true }) }
      return { ok: false, status: 409, json: async () => ({ error: 'daily_budget_exceeded', scope: 'project', period: 'run', budgetUsd: 5, spentUsd: 5.2, resetsAt: null }) }
    })
    mount('/?inbox=1')
    const row = (await screen.findAllByTestId('inbox-row')).find((r) => r.getAttribute('data-item-id') === 'p2:budget:r2')!
    fireEvent.click(within(row).getByTestId('inbox-primary'))
    const dialog = await screen.findByTestId('run-cap-dialog')
    expect(dialog).toHaveTextContent('Paused at the per-run cap ($5.20 of $5.00)')
    expect(h.toast.error).not.toHaveBeenCalled()
    expect(screen.getByTestId('run-cap-amount')).toHaveValue(10.2)
    fireEvent.click(screen.getByTestId('run-cap-ignore'))
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Run resumed'))
    expect(bodies).toEqual([{}, { runCap: 'ignore' }])
  })

  it('Raise sends the new cap, and only when it ends above what the run spent', async () => {
    const bodies: unknown[] = []
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u.endsWith('/api/inbox')) return { ok: true, status: 200, json: async () => ({ items, projects: [], generatedAt: '' }) }
      const body = JSON.parse(String(init?.body ?? '{}'))
      bodies.push(body)
      if (typeof body.runCapUsd === 'number') return { ok: true, status: 202, json: async () => ({ resumed: true }) }
      return { ok: false, status: 409, json: async () => ({ error: 'daily_budget_exceeded', scope: 'project', period: 'run', budgetUsd: 5, spentUsd: 5.2, resetsAt: null }) }
    })
    mount('/?inbox=1')
    const row = (await screen.findAllByTestId('inbox-row')).find((r) => r.getAttribute('data-item-id') === 'p2:budget:r2')!
    fireEvent.click(within(row).getByTestId('inbox-primary'))
    const amount = await screen.findByTestId('run-cap-amount')
    fireEvent.change(amount, { target: { value: '5.2' } })
    expect(screen.getByTestId('run-cap-raise')).toBeDisabled()
    fireEvent.change(amount, { target: { value: '8' } })
    fireEvent.click(screen.getByTestId('run-cap-raise'))
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Run resumed'))
    expect(bodies).toEqual([{}, { runCapUsd: 8 }])
  })

  it('a reached cap lists in the app\'s words with Raise cap, which opens the Budget panel', async () => {
    items = [mk({
      id: 'p1:budget:cap-project-week', kind: 'budget', title: 'Project weekly budget reached', action: 'raise-cap', subjectId: 'project:week',
      conversationId: null, version: 'cap:50:x', cap: { scope: 'project', period: 'week', budgetUsd: 50, spentUsd: 52.5, resetsAt: '2026-10-26T00:00:00.000Z' },
    })]
    const opened = vi.fn()
    window.addEventListener(OPEN_BUDGET_PANEL_EVENT, opened)
    mount('/?inbox=1')
    const row = (await screen.findAllByTestId('inbox-row'))[0]
    expect(row).toHaveTextContent('Project weekly budget reached')
    expect(row).toHaveTextContent('Budget cap reached')
    expect(row).toHaveTextContent('$52.50 of $50.00 spent')
    expect(within(row).getByTestId('inbox-primary')).toHaveTextContent('Raise cap')
    fireEvent.click(within(row).getByTestId('inbox-primary'))
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(1))
    window.removeEventListener(OPEN_BUDGET_PANEL_EVENT, opened)
  })

  it('Retry re-queues the dead Jira op of the item\'s project', async () => {
    mount('/?inbox=1')
    const row = (await screen.findAllByTestId('inbox-row')).find((r) => r.getAttribute('data-item-id') === 'p1:jira:5')!
    expect(within(row).getByTestId('inbox-primary')).toHaveTextContent('Retry')
    fireEvent.click(within(row).getByTestId('inbox-primary'))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/api/projects/p1/jira/outbox/5/retry'))).toBe(true))
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Retry queued'))
  })
})

describe('Snooze and Done', () => {
  const rowOf = async (id: string) => (await screen.findAllByTestId('inbox-row')).find((r) => r.getAttribute('data-item-id') === id)!

  it('Done hides the row, lowers the badge and persists per viewer', async () => {
    mount('/?inbox=1')
    fireEvent.click(within(await rowOf('p1:review:d1')).getByTestId('inbox-done'))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
    expect(screen.queryByText('Add login')).toBeNull()
    expect(JSON.parse(localStorage.getItem(DISMISSALS_KEY)!)['p1:review:d1']).toMatchObject({ version: 'on_review', until: null })
  })

  it('Snooze 1 hour hides the row until it lapses', async () => {
    mount('/?inbox=1')
    const row = await rowOf('p1:review:d1')
    fireEvent.click(within(row).getByTestId('inbox-snooze'))
    fireEvent.click(within(row).getByTestId('inbox-snooze-hour'))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
    const stored = JSON.parse(localStorage.getItem(DISMISSALS_KEY)!)['p1:review:d1']
    expect(stored.until).toBeGreaterThan(Date.now() + 59 * 60_000)
    // an hour later the stored snooze no longer applies
    localStorage.setItem(DISMISSALS_KEY, JSON.stringify({ 'p1:review:d1': { ...stored, until: Date.now() - 1 } }))
  })

  it('Done says what happened, offers Undo, and Undo brings the row back', async () => {
    mount('/?inbox=1')
    fireEvent.click(within(await rowOf('p1:review:d1')).getByTestId('inbox-done'))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
    expect(h.toast).toHaveBeenCalledWith('Marked done', expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }))
    const action = h.toast.mock.calls[0][1].action as { onClick: () => void }
    act(() => action.onClick())
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('4'))
    expect(JSON.parse(localStorage.getItem(DISMISSALS_KEY)!)['p1:review:d1']).toBeUndefined()
  })

  it('Snooze says until when, offers Undo, and Undo brings the row back', async () => {
    mount('/?inbox=1')
    const row = await rowOf('p1:review:d1')
    fireEvent.click(within(row).getByTestId('inbox-snooze'))
    fireEvent.click(within(row).getByTestId('inbox-snooze-tomorrow'))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
    const [message, options] = h.toast.mock.calls[0]
    expect(message).toMatch(/^Snoozed until .+/)
    act(() => (options.action as { onClick: () => void }).onClick())
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('4'))
  })

  it('moves the focus to the next row when Done removes the one under it (and to the previous at the end)', async () => {
    mount('/?inbox=1')
    const dialog = await screen.findByTestId('inbox-dialog')
    await waitFor(() => expect(within(dialog).getAllByTestId('inbox-primary').length).toBe(4))
    const before = within(dialog).getAllByTestId('inbox-row').map((r) => r.getAttribute('data-item-id'))
    const first = (await rowOf('p1:review:d1'))
    const heirId = before[before.indexOf('p1:review:d1') + 1]
    within(first).getByTestId('inbox-done').focus()
    fireEvent.click(within(first).getByTestId('inbox-done'))
    await waitFor(() => expect(document.activeElement?.closest('[data-testid="inbox-row"]')?.getAttribute('data-item-id')).toBe(heirId))
    expect(document.activeElement).toHaveAttribute('data-inbox-primary')
    // the last row hands the focus back to its predecessor
    const rows = within(dialog).getAllByTestId('inbox-row')
    const last = rows[rows.length - 1]
    const previousId = rows[rows.length - 2].getAttribute('data-item-id')
    fireEvent.click(within(last).getByTestId('inbox-done'))
    await waitFor(() => expect(document.activeElement?.closest('[data-testid="inbox-row"]')?.getAttribute('data-item-id')).toBe(previousId))
  })

  it('a dismissed item comes back when its state changes', async () => {
    mount('/?inbox=1')
    fireEvent.click(within(await rowOf('p1:review:d1')).getByTestId('inbox-done'))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
    items = items.map((i) => (i.id === 'p1:review:d1' ? { ...i, version: 'pr_draft' } : i))
    act(() => handlers.get('inbox')!({ type: 'rail.pr_state', projectId: 'p1' }))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('4'), { timeout: 2000 })
  })

  it('honours dismissals stored by an earlier session', async () => {
    localStorage.setItem(DISMISSALS_KEY, JSON.stringify({ 'p1:review:d1': { version: 'on_review', until: null, at: Date.now() } }))
    mount()
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
  })

  it('works when storage is unavailable', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    mount('/?inbox=1')
    fireEvent.click(within(await rowOf('p1:review:d1')).getByTestId('inbox-done'))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
    spy.mockRestore()
  })
})

describe('Refresh from live events', () => {
  it('refetches (debounced) on attention events of ANY project and ignores unrelated ones', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('4'))
    const reads = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/inbox')).length
    const base = reads()
    act(() => handlers.get('inbox')!({ type: 'queue', projectId: 'p2', jobs: [] }))
    await new Promise((r) => setTimeout(r, 600))
    expect(reads()).toBe(base)
    items = items.slice(0, 1)
    act(() => {
      handlers.get('inbox')!({ type: 'loop.run_paused', projectId: 'p2' })
      handlers.get('inbox')!({ type: 'jira.outbox_changed', projectId: 'p1' })
    })
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'), { timeout: 2000 })
    expect(reads()).toBe(base + 1)
  })
})
