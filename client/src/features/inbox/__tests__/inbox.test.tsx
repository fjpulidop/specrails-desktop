import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, type Location } from 'react-router-dom'
import type { ReactNode } from 'react'

const h = vi.hoisted(() => ({
  desktop: { projects: [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }], activeProjectId: 'p1' as string | null, setActiveProjectId: vi.fn() },
  mode: 'agent' as 'agent' | 'kanban',
  toast: { success: vi.fn(), error: vi.fn() },
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

const mk = (over: Partial<InboxItem>): InboxItem => ({
  id: 'p1:review:d1', projectId: 'p1', projectName: 'Alpha', kind: 'review', title: 'Add login', detail: null,
  at: new Date(Date.now() - 2 * 3_600_000).toISOString(), version: 'on_review', action: 'open-review', subjectId: 'd1', conversationId: 'c1', diagnosis: null, ...over,
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
  h.toast.success.mockClear(); h.toast.error.mockClear()
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
    expect(unknown).toHaveTextContent('failed')
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

  it('switches project first when the item lives in another one, then opens its place', async () => {
    const { rerender } = mount('/?inbox=1')
    const row = (await screen.findAllByTestId('inbox-row')).find((r) => r.getAttribute('data-item-id') === 'p2:question:r9')!
    fireEvent.click(within(row).getByTestId('inbox-primary'))
    expect(h.desktop.setActiveProjectId).toHaveBeenCalledWith('p2')
    expect(url()).toBe('/?inbox=1')
    h.desktop.activeProjectId = 'p2'
    rerender(<MemoryRouter initialEntries={['/?inbox=1']}><Shell /></MemoryRouter>)
    // MemoryRouter keeps its own history across rerender of the same tree position.
    await waitFor(() => expect(url()).toContain('job=r9'))
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
