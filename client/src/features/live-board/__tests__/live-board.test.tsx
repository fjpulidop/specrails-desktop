import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, type Location } from 'react-router-dom'

const h = vi.hoisted(() => ({
  desktop: { projects: [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }], activeProjectId: 'p1' as string | null, setActiveProjectId: vi.fn() },
  mode: 'agent' as 'agent' | 'kanban',
  inbox: { runPrimary: vi.fn(async () => {}), openInbox: vi.fn(), busy: new Set<string>(), items: [] as unknown[] },
  openMission: vi.fn(),
  selectConversation: vi.fn(async () => {}),
  openAgentPanel: vi.fn(),
  native: false,
  openSurfaceWindow: vi.fn(async (_id: string, _params: unknown, requestId: string) => ({ windowLabel: 'surface-live-board-x', requestId, reused: false })),
  surfaceListener: null as null | ((event: { kind: string; requestId: string; result?: unknown }) => void),
}))
vi.mock('../../../hooks/useDesktop', () => ({ useDesktop: () => h.desktop }))
vi.mock('../../../context/UiModeContext', () => ({ useUiMode: () => ({ uiMode: h.mode }) }))
vi.mock('../../inbox/context/InboxContext', () => ({ useInbox: () => h.inbox }))
vi.mock('../../missions/hooks/useOpenMission', () => ({ useOpenMission: () => h.openMission }))
vi.mock('../../missions/context/AgentChatContext', () => ({ useAgentChat: () => ({ selectConversation: h.selectConversation, open: h.openAgentPanel }) }))
vi.mock('../../../lib/native-surfaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/native-surfaces')>()
  return {
    ...actual,
    nativeSurfaceEnabled: () => h.native,
    openSurfaceWindow: h.openSurfaceWindow,
    closeSurfaceWindow: vi.fn(async () => {}),
    listenSurfaceWindowEvents: vi.fn(async (callback: (event: { kind: string; requestId: string; result?: unknown }) => void) => { h.surfaceListener = callback; return () => { h.surfaceListener = null } }),
  }
})

import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'
import { LiveBoardProvider, useLiveBoard } from '../context/LiveBoardContext'
import { LiveBoardDialog } from '../components/LiveBoardDialog'
import { LiveBoardWindow } from '../components/LiveBoardWindow'
import { LAYOUT_KEY } from '../lib/live-board-model'
import { DISMISSALS_KEY } from '../../inbox/lib/inbox-model'
import { requestOpenLiveBoard } from '../../../lib/live-board-events'

const AT = new Date(Date.now() - 20 * 60_000).toISOString()
const question = {
  id: 'p1:question:r-ask', projectId: 'p1', projectName: 'Alpha', kind: 'question', title: 'Implement · #7', detail: null,
  at: AT, version: 'paused::', action: 'open-run', subjectId: 'r-ask', conversationId: null, diagnosis: null,
}
const card = (over: Record<string, unknown>) => ({
  projectId: 'p1', projectName: 'Alpha', kind: 'loop', column: 'working', urgency: 2, at: AT,
  status: { source: 'loop-run', status: 'running', outcome: null, restartReason: null },
  title: 'Run', phase: null, question: null, steps: null, provider: 'claude', model: null, startedAt: AT, finishedAt: null,
  costUsd: null, costEstimated: false, costEstimatedUsd: null, costTodayUsd: null, railIndex: null, ticketIds: [], conversationId: null, jobId: null, deliveryId: null, attention: null,
  ...over,
})
let body: Record<string, unknown>
function board() {
  return {
    generatedAt: new Date().toISOString(),
    projects: [{ projectId: 'p1', projectName: 'Alpha', count: 3 }, { projectId: 'p2', projectName: 'Beta', count: 1 }],
    cards: [
      card({ id: 'p1:loop-run:r-ask', column: 'needs', urgency: 0, title: 'Records top-5', status: { source: 'loop-run', status: 'paused', outcome: null, restartReason: null }, question: 'Per device or synced?', jobId: 'r-ask', conversationId: 'm1', attention: question }),
      card({ id: 'p1:loop-run:r-live', kind: 'rail', railIndex: 1, title: 'Next pieces preview', phase: 'implement-fix', jobId: 'r-live', conversationId: 'm1', costUsd: 0.62 }),
      card({ id: 'p2:job:j1', projectId: 'p2', projectName: 'Beta', kind: 'job', title: '/sr:implement #4', provider: 'codex', status: { source: 'job', status: 'running' }, phase: 'developer', steps: { done: 1, total: 3 }, jobId: 'j1' }),
      card({ id: 'p1:delivery:d1', kind: 'rail', railIndex: 0, column: 'done', urgency: 2, title: 'Ghost piece', status: { source: 'delivery', decision: 'merged', statusCode: null }, finishedAt: AT, jobId: 'r-old', deliveryId: 'd1' }),
    ],
    lanes: [
      { conversationId: 'm1', title: 'Records and screens', provider: 'claude', projectIds: ['p1'], cardIds: ['p1:loop-run:r-ask', 'p1:loop-run:r-live'], todayCostUsd: 1.46, urgency: 0 },
      { conversationId: null, title: null, provider: null, projectIds: ['p1', 'p2'], cardIds: ['p2:job:j1', 'p1:delivery:d1'], todayCostUsd: null, urgency: 2 },
    ],
    totals: { needsYou: 1, inProgress: 2, doneToday: 1, costTodayUsd: 4.82, costTodayEstimated: false },
  }
}

let loc: Location
let handlers: Map<string, (m: unknown) => void>
let fetchMock: ReturnType<typeof vi.fn>
function Probe() { loc = useLocation(); return null }
function OpenButton() { const b = useLiveBoard(); return <button type="button" onClick={() => b?.openBoard()}>open-board</button> }
const ws = () => ({ registerHandler: (id: string, fn: (m: unknown) => void) => { handlers.set(id, fn) }, unregisterHandler: (id: string) => { handlers.delete(id) }, connectionStatus: 'connected' as const })
const mount = (route = '/?live=1') => render(
  <MemoryRouter initialEntries={[route]}>
    <SharedWebSocketContext.Provider value={ws()}>
      <LiveBoardProvider><LiveBoardDialog /><OpenButton /><Probe /></LiveBoardProvider>
    </SharedWebSocketContext.Provider>
  </MemoryRouter>,
)
const url = () => `${loc.pathname}${loc.search}`
const cardEl = (id: string) => screen.getAllByTestId('live-card').find((el) => el.dataset.cardId === id)!

beforeEach(() => {
  localStorage.clear()
  handlers = new Map()
  h.mode = 'agent'
  h.native = false
  h.desktop.activeProjectId = 'p1'
  h.desktop.setActiveProjectId = vi.fn()
  for (const fn of [h.inbox.runPrimary, h.inbox.openInbox, h.openMission, h.selectConversation, h.openAgentPanel, h.openSurfaceWindow]) fn.mockClear()
  body = board()
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/api/live-board')) return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  global.fetch = fetchMock as never
})
afterEach(() => { vi.useRealTimers() })

describe('live board (by status)', () => {
  it('opens from the place and renders the three columns with the summary', async () => {
    mount()
    expect(await screen.findByTestId('live-board-dialog')).toBeInTheDocument()
    await screen.findByText('Records top-5')
    const columns = screen.getAllByTestId('live-column').map((el) => [el.dataset.column, within(el).queryAllByTestId('live-card').length])
    expect(columns).toEqual([['needs', 1], ['working', 2], ['done', 1]])
    expect(screen.getByTestId('live-board-summary')).toHaveTextContent('1 needs you')
    expect(screen.getByTestId('live-board-summary')).toHaveTextContent('2 in progress')
    expect(screen.getByTestId('live-board-summary')).toHaveTextContent('today $4.82')
    // A question shows its text; a running run its step; a job its steps.
    expect(within(cardEl('p1:loop-run:r-ask')).getByTestId('live-card-question')).toHaveTextContent('Per device or synced?')
    expect(cardEl('p1:loop-run:r-live')).toHaveTextContent('Implement fix')
    expect(cardEl('p1:loop-run:r-live')).toHaveTextContent('Rail 2')
    expect(within(cardEl('p2:job:j1')).getByTestId('live-card-steps')).toHaveAttribute('aria-label', '1 of 3 steps done')
    expect(cardEl('p1:delivery:d1').dataset.runState).toBe('done')
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/live-board'))).toHaveLength(1)
  })

  it('puts reviews in Needs you with their own glyph, and the header counts are the columns\' counts', async () => {
    const review = { ...question, id: 'p1:review:d2', kind: 'review', action: 'open-review', subjectId: 'd2', title: 'Add per-mode records' }
    const paused = card({ id: 'p1:loop-run:r-p', title: 'Paused loop', status: { source: 'loop-run', status: 'paused', outcome: null, restartReason: 'fork' }, jobId: 'r-p' })
    body.cards = [...board().cards.slice(0, 1),
      card({ id: 'p1:delivery:d2', kind: 'rail', railIndex: 3, column: 'needs', urgency: 0, title: 'Add per-mode records', status: { source: 'delivery', decision: 'pr_ready', statusCode: null }, deliveryId: 'd2', attention: review }),
      ...board().cards.slice(1, 3), paused, ...board().cards.slice(3)]
    mount()
    await screen.findByText('Paused loop')
    const needs = screen.getAllByTestId('live-column').find((el) => el.dataset.column === 'needs')!
    expect(within(needs).getAllByTestId('live-card').map((el) => el.dataset.runState)).toEqual(['needs-input', 'review'])
    for (const column of screen.getAllByTestId('live-column')) {
      const shown = within(column).queryAllByTestId('live-card').length
      const paused = within(column).queryAllByTestId('live-card').filter((el) => el.dataset.runState === 'paused').length
      expect(within(column).getByTestId('live-column-count')).toHaveTextContent(String(column.dataset.column === 'working' ? shown - paused : shown))
    }
    expect(screen.getByTestId('live-board-summary')).toHaveTextContent('2 need you')
    // The header and the In progress heading agree: running and paused are counted apart.
    expect(screen.getByTestId('live-board-summary')).toHaveTextContent('2 in progress')
    expect(screen.getByTestId('live-board-summary')).toHaveTextContent('1 paused')
    const working = screen.getAllByTestId('live-column').find((el) => el.dataset.column === 'working')!
    expect(within(working).getByTestId('live-column-count')).toHaveTextContent('2')
    expect(within(working).getByTestId('live-column-paused')).toHaveTextContent('1 paused')
    // A paused run has the paused look, never the question look.
    expect(cardEl('p1:loop-run:r-p').dataset.runState).toBe('paused')
    // The mixed column wears no state glyph of its own.
    expect(needs.querySelector('h3 [data-run-state]')).toBeNull()
  })

  it('says each thing once: the question is not repeated, and the project shows only on a multi-project board', async () => {
    body.cards[0] = { ...board().cards[0], attention: { ...question, detail: 'Per device or synced?' } }
    const { unmount } = mount()
    await screen.findByText('Records top-5')
    const ask = cardEl('p1:loop-run:r-ask')
    expect(ask.textContent?.match(/Per device or synced\?/g)).toHaveLength(1)
    expect(within(ask).getByTestId('live-card-phrase')).toHaveTextContent('Waiting for your answer')
    expect(within(cardEl('p2:job:j1')).getByTestId('live-card-meta')).toHaveTextContent('Beta · Job')
    unmount()
    body = { ...board(), projects: [{ projectId: 'p1', projectName: 'Alpha', count: 3 }] }
    mount()
    await screen.findByText('Records top-5')
    expect(within(cardEl('p1:loop-run:r-live')).getByTestId('live-card-meta')).toHaveTextContent(/^Rail 2$/)
  })

  it('names an inbox item that is not a run exactly as the inbox does', async () => {
    const cap = { ...question, id: 'p1:budget:cap-day', kind: 'budget', action: 'raise-cap', subjectId: 'cap-day', title: 'Daily cap reached', cap: { scope: 'project', period: 'day', budgetUsd: 5, spentUsd: 5.12, resetsAt: '' } }
    body.cards = [card({ id: 'p1:budget:cap-day', kind: null, column: 'needs', urgency: 0, title: 'Daily cap reached', status: { source: 'attention' }, attention: cap })]
    mount()
    const el = await waitFor(() => cardEl('p1:budget:cap-day'))
    expect(within(el).getByTestId('live-card-title')).toHaveTextContent('Project daily limit reached')
    expect(within(el).getByTestId('live-card-phrase')).toHaveTextContent('Work paused · $5.12 of $5.00 spent')
    expect(el.dataset.runState).toBe('paused')
  })

  it('shows a merge preview as a short chip with the full sentence for hover and focus', async () => {
    body.cards[1] = { ...board().cards[1], mergePreview: { status: 'conflicts', conflictFileCount: 2, siblingConflictCount: 1, baseAdvancedBy: 3 } }
    mount()
    await screen.findByText('Next pieces preview')
    const chip = within(cardEl('p1:loop-run:r-live')).getByTestId('live-card-merge-preview')
    expect(chip).toHaveTextContent(/^2 conflicts$/)
    expect(chip).toHaveAccessibleName('Conflicts with the base in 2 files · Collides with 1 other run · Base moved 3 commits')
  })

  it('opens the inbox in place of the board', async () => {
    mount('/?mission=m0&live=1')
    await screen.findByText('Records top-5')
    fireEvent.click(screen.getByTestId('live-board-open-inbox'))
    expect(url()).toBe('/?mission=m0&inbox=1')
  })

  it('opens with the event (shell, sidebar, palette) and closes with Back semantics', async () => {
    mount('/')
    expect(screen.queryByTestId('live-board-dialog')).not.toBeInTheDocument()
    act(() => requestOpenLiveBoard())
    await screen.findByTestId('live-board-dialog')
    expect(url()).toBe('/?live=1')
    fireEvent.keyDown(screen.getByTestId('live-board-dialog'), { key: 'Escape' })
    await waitFor(() => expect(url()).toBe('/'))
  })

  it('filters by project, kind and engine without refetching', async () => {
    mount()
    await screen.findByText('Records top-5')
    fireEvent.click(screen.getAllByTestId('live-filter-project').find((el) => el.textContent === 'Beta')!)
    expect(screen.getAllByTestId('live-card').map((el) => el.dataset.cardId)).toEqual(['p2:job:j1'])
    fireEvent.click(screen.getByTestId('live-filter-project-all'))
    fireEvent.click(screen.getByTestId('live-filter-kind-rail'))
    expect(screen.getAllByTestId('live-card').map((el) => el.dataset.cardId)).toEqual(['p1:loop-run:r-live', 'p1:delivery:d1'])
    fireEvent.click(screen.getByTestId('live-filter-kind-rail'))
    fireEvent.click(screen.getAllByTestId('live-filter-engine').find((el) => el.textContent === 'Codex')!)
    expect(screen.getAllByTestId('live-card').map((el) => el.dataset.cardId)).toEqual(['p2:job:j1'])
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/live-board'))).toHaveLength(1)
  })

  it('hides an inbox item the person snoozed in the inbox', async () => {
    localStorage.setItem(DISMISSALS_KEY, JSON.stringify({ 'p1:question:r-ask': { version: 'paused::', at: Date.now(), until: Date.now() + 3_600_000 } }))
    mount()
    await screen.findByText('Next pieces preview')
    expect(screen.queryByText('Records top-5')).not.toBeInTheDocument()
    expect(screen.getByTestId('live-board-summary')).toHaveTextContent('0 need you')
  })

  it('shows the empty state and the error state with retry', async () => {
    body = { ...board(), cards: [], lanes: [], projects: [] }
    const { unmount } = mount()
    expect(await screen.findByTestId('live-board-empty')).toBeInTheDocument()
    unmount()
    fetchMock.mockImplementation(async () => new Response('boom', { status: 500 }))
    mount()
    expect(await screen.findByTestId('live-board-error')).toBeInTheDocument()
  })

  it('refetches (debounced) on the WebSocket events that move a card, and ignores others', async () => {
    mount()
    await screen.findByText('Records top-5')
    vi.useFakeTimers()
    const calls = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/live-board')).length
    act(() => { handlers.get('live-board')!({ type: 'agent_stream' }) })
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(calls()).toBe(1)
    act(() => {
      handlers.get('live-board')!({ type: 'loop.run_completed', projectId: 'p2' })
      handlers.get('live-board')!({ type: 'rail.pr_state', projectId: 'p1' })
    })
    act(() => { vi.advanceTimersByTime(2_500) })
    expect(calls()).toBe(2)
  })
})

describe('live board chain cards', () => {
  it('shows the chain\'s total cost, keeps the estimated part apart, and names the latest attempt\'s own cost', async () => {
    body.cards = [
      // attempt 4 of 4: $2.15 across the chain, $0.25 of it a rate-card estimate; this attempt $0.40.
      card({ id: 'p1:loop-run:fork-c', title: 'Chain run', jobId: 'fork-c', costUsd: 2.15, costEstimated: true, costEstimatedUsd: 0.25,
        attempt: { number: 4, of: 4, costUsd: 0.4, costEstimated: false } }),
      card({ id: 'p1:loop-run:codex', title: 'Codex run', jobId: 'codex', costUsd: 0.3, costEstimated: true, costEstimatedUsd: 0.3 }),
    ]
    body.lanes = [{ conversationId: null, title: null, provider: null, projectIds: ['p1'], cardIds: ['p1:loop-run:fork-c', 'p1:loop-run:codex'], todayCostUsd: 2.45, urgency: 1 }]
    mount()
    await screen.findByText('Chain run')
    const chainCost = within(cardEl('p1:loop-run:fork-c')).getByTestId('live-card-cost')
    expect(chainCost).toHaveTextContent('$2.15')
    expect(chainCost.textContent).not.toMatch(/^~/)
    expect(chainCost).toHaveAttribute('title', 'Includes ~$0.25 estimated from the rate card, not billed')
    const attempt = within(cardEl('p1:loop-run:fork-c')).getByTestId('live-card-attempt')
    expect(attempt).toHaveTextContent('attempt 4')
    expect(attempt).toHaveAttribute('title', "This attempt: $0.40. The card's cost covers all 4 attempts.")
    // A cost that is all estimate keeps its estimate reading.
    expect(within(cardEl('p1:loop-run:codex')).getByTestId('live-card-cost').textContent).toMatch(/^~\$0\.30/)
  })
})

describe('live board actions reuse the existing handlers', () => {
  it('runs the inbox primary for an inbox item and leaves the board in place', async () => {
    mount('/?mission=m0&live=1')
    await screen.findByText('Records top-5')
    fireEvent.click(within(cardEl('p1:loop-run:r-ask')).getByTestId('live-card-primary'))
    expect(h.inbox.runPrimary).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1:question:r-ask', action: 'open-run' }))
    expect(url()).toBe('/?mission=m0')
  })

  it('stays on the board for Resume', async () => {
    body.cards = [card({ id: 'p1:loop-run:r-b', column: 'needs', urgency: 0, title: 'Budget run', jobId: 'r-b', attention: { ...question, id: 'p1:budget:r-b', kind: 'budget', action: 'resume-run', subjectId: 'r-b' } })]
    mount()
    await screen.findByText('Budget run')
    expect(within(cardEl('p1:loop-run:r-b')).getByTestId('live-card-primary')).toHaveTextContent('Resume')
    fireEvent.click(within(cardEl('p1:loop-run:r-b')).getByTestId('live-card-primary'))
    expect(h.inbox.runPrimary).toHaveBeenCalledTimes(1)
    expect(url()).toBe('/?live=1')
    // The run itself still opens.
    expect(within(cardEl('p1:loop-run:r-b')).getByTestId('live-card-open')).toBeInTheDocument()
  })

  it('opens the mission that launched a run (Mission mode) and the floating panel on the board', async () => {
    mount()
    await screen.findByText('Next pieces preview')
    fireEvent.click(within(cardEl('p1:loop-run:r-live')).getByTestId('live-card-primary'))
    expect(h.openMission).toHaveBeenCalledWith('m1')
    expect(url()).toBe('/')
  })

  it('opens the panel in Board mode', async () => {
    h.mode = 'kanban'
    mount()
    await screen.findByText('Next pieces preview')
    fireEvent.click(within(cardEl('p1:loop-run:r-live')).getByTestId('live-card-title'))
    expect(h.selectConversation).toHaveBeenCalledWith('m1')
    expect(h.openAgentPanel).toHaveBeenCalled()
  })

  it('opens the run detail of another project after switching to it', async () => {
    mount()
    await screen.findByText('/sr:implement #4')
    fireEvent.click(within(cardEl('p2:job:j1')).getByTestId('live-card-primary'))
    expect(h.desktop.setActiveProjectId).toHaveBeenCalledWith('p2')
    expect(url()).toBe('/')
  })

  it('opens the run detail of the active project as the job place', async () => {
    mount()
    await screen.findByText('Ghost piece')
    fireEvent.click(within(cardEl('p1:delivery:d1')).getByTestId('live-card-primary'))
    expect(url()).toBe('/?job=r-old')
  })
})

describe('live board (by mission)', () => {
  it('renders one lane per mission, remembers the layout, and closes the list with the runs without one', async () => {
    mount()
    await screen.findByText('Records top-5')
    fireEvent.click(within(screen.getByTestId('live-board-layout')).getByText('By mission'))
    expect(localStorage.getItem(LAYOUT_KEY)).toBe('mission')
    const lanes = await screen.findAllByTestId('live-lane')
    expect(lanes.map((el) => el.dataset.conversationId)).toEqual(['m1', ''])
    expect(lanes[0]).toHaveTextContent('Records and screens')
    expect(lanes[0]).toHaveTextContent('2 runs')
    expect(lanes[0]).toHaveTextContent('$1.46 today')
    expect(lanes[1]).toHaveTextContent('Not from a mission')
    expect(within(lanes[1]).getAllByTestId('live-card')).toHaveLength(2)
  })

  it('opens in the remembered layout', async () => {
    localStorage.setItem(LAYOUT_KEY, 'mission')
    mount()
    expect(await screen.findByTestId('live-board-lanes')).toBeInTheDocument()
    expect(within(screen.getByTestId('live-board-layout')).getByText('By mission')).toHaveAttribute('aria-checked', 'true')
  })
})

describe('live board in its own window', () => {
  it('hides "Open in window" where native windows are not available', async () => {
    mount()
    await screen.findByText('Records top-5')
    expect(screen.queryByTestId('live-board-open-window')).not.toBeInTheDocument()
  })

  it('in the desktop app, opens as its own window from a ?live=1 entry and runs the window\'s actions here', async () => {
    h.native = true
    mount()
    await waitFor(() => expect(h.openSurfaceWindow).toHaveBeenCalledWith('live-board', {}, expect.any(String)))
    // The main window keeps its page; the board is never drawn in-page.
    await waitFor(() => expect(url()).toBe('/'))
    expect(screen.queryByTestId('live-card')).not.toBeInTheDocument()
    const requestId = h.openSurfaceWindow.mock.calls[0][2]
    const forwarded = board().cards[0]
    act(() => h.surfaceListener?.({ kind: 'result', requestId, result: { action: 'primary', card: forwarded } }))
    expect(h.inbox.runPrimary).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1:question:r-ask' }))
    act(() => h.surfaceListener?.({ kind: 'result', requestId, result: { action: 'open', card: board().cards[1] } }))
    expect(h.openMission).toHaveBeenCalledWith('m1')
    act(() => h.surfaceListener?.({ kind: 'result', requestId, result: { action: 'inbox' } }))
    expect(h.inbox.openInbox).toHaveBeenCalledTimes(1)
  })

  it('in the desktop app, opening it again focuses the window instead of drawing it in-page', async () => {
    h.native = true
    mount('/')
    fireEvent.click(screen.getByText('open-board'))
    await waitFor(() => expect(h.openSurfaceWindow).toHaveBeenCalledTimes(1))
    expect(url()).toBe('/')
    fireEvent.click(screen.getByText('open-board'))
    // The singleton is asked for again, which focuses it (surface_windows.rs reuses the window).
    await waitFor(() => expect(h.openSurfaceWindow).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('live-card')).not.toBeInTheDocument()
  })

  it('in the window, forwards card actions as results instead of running them', async () => {
    const report = vi.fn()
    render(
      <MemoryRouter>
        <SharedWebSocketContext.Provider value={ws()}><LiveBoardWindow report={report} onClose={vi.fn()} /></SharedWebSocketContext.Provider>
      </MemoryRouter>,
    )
    await screen.findByText('Records top-5')
    expect(screen.queryByTestId('live-board-open-window')).not.toBeInTheDocument()
    fireEvent.click(within(cardEl('p1:loop-run:r-ask')).getByTestId('live-card-primary'))
    expect(report).toHaveBeenCalledWith({ action: 'primary', card: expect.objectContaining({ id: 'p1:loop-run:r-ask' }) })
    fireEvent.click(screen.getByTestId('live-board-open-inbox'))
    expect(report).toHaveBeenCalledWith({ action: 'inbox' })
    expect(h.inbox.runPrimary).not.toHaveBeenCalled()
  })
})
