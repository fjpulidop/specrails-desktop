import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { CommandPalette } from '../CommandPalette'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import type { AgentConversation, MissionSearchHit } from '../../features/missions/lib/agent-api'
import type { InboxItem } from '../../features/inbox/lib/inbox-model'

// "Jump back in": the first group of the empty ⌘K palette, its ⌘1…⌘6 chords and
// how the app's own digit chords stay quiet while the palette is open.

beforeEach(() => {
  global.ResizeObserver = vi.fn().mockImplementation(function () {
    return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }
  })
})

const setActiveProjectId = vi.fn()
vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [
      { id: 'p1', slug: 'alpha', name: 'Alpha', path: '/a', db_path: '/a/db', provider: 'claude', added_at: '', last_seen_at: '' },
      { id: 'p2', slug: 'beta', name: 'Beta', path: '/b', db_path: '/b/db', provider: 'claude', added_at: '', last_seen_at: '' },
    ],
    activeProjectId: 'p1',
    setActiveProjectId,
  }),
}))
vi.mock('../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))
const navigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigate }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../context/UiModeContext', () => ({
  useUiMode: () => ({ uiMode: 'kanban', setUiMode: vi.fn(), toggleUiMode: vi.fn() }),
}))

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
function conv(id: string, title: string, ago: number, pinned: string | null = 'p1'): AgentConversation {
  const at = minutesAgo(ago)
  return { id, title, provider: 'claude', model: null, session_id: null, pinned_project_id: pinned, tier_level: 0, reasoning_effort: null, archivedAt: null, created_at: at, updated_at: at }
}
function inboxItem(id: string, ago: number, over: Partial<InboxItem> = {}): InboxItem {
  return {
    id, projectId: 'p2', projectName: 'Beta', kind: 'question', title: `Question ${id}`, detail: null, at: minutesAgo(ago),
    version: 'v1', action: 'open-run', subjectId: `run-${id}`, conversationId: null, diagnosis: null, cap: null, ...over,
  }
}

// Mutable per test; the mocks hand out the same references until a test swaps them.
let chat: {
  conversations: AgentConversation[]
  attentionConversationIds: ReadonlySet<string>
  attentionKinds: ReadonlyMap<string, 'decision' | 'failed'>
  unreadConversationIds: ReadonlySet<string>
}
const selectConversation = vi.fn(async () => {})
const openAgentPanel = vi.fn()
const noLive = new Map()
vi.mock('../../features/missions/context/AgentChatContext', () => ({
  useAgentChat: () => ({ ...chat, liveByConversation: noLive, selectConversation, open: openAgentPanel, conversationsLoading: false }),
}))

const runPrimary = vi.fn(async () => {})
const openInbox = vi.fn()
let inboxItems: InboxItem[] = []
vi.mock('../../features/inbox/context/InboxContext', () => ({
  useInbox: () => ({ items: inboxItems, status: 'ready', count: inboxItems.length, runPrimary, openInbox }),
}))

const searchMissions = vi.fn<(q: string, limit?: number, signal?: AbortSignal) => Promise<MissionSearchHit[]>>()
vi.mock('../../features/missions/lib/agent-api', () => ({
  searchMissions: (...args: [string, number?, AbortSignal?]) => searchMissions(...args),
}))

let jobs: Array<{ id: string; command: string; status: string; started_at: string; finished_at?: string | null }> = []

const asPlatform = (platform: string) => vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue(platform)
const headings = () => Array.from(document.querySelectorAll('[cmdk-group-heading]')).map((el) => el.textContent ?? '')
const jumpRows = () => within(screen.getByTestId('palette-group-jump-back-in')).getAllByRole('option')
const jumpIds = () => jumpRows().map((row) => row.getAttribute('data-testid'))
const paletteOpen = () => screen.queryByPlaceholderText(/search/i) !== null

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Control>}k{/Control}')
  await waitFor(() => expect(paletteOpen()).toBe(true))
  // Settled once the jobs list of this opening answered.
  await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/projects/p1/jobs?limit=10'))
}

function digit(n: number, mods: KeyboardEventInit, target: EventTarget = document.activeElement ?? document.body) {
  fireEvent.keyDown(target, { code: `Digit${n}`, key: String(n), ...mods })
}

/** The app shell's global chords, mounted next to the palette. */
function WithGlobalShortcuts({ onPage, onProject }: { onPage: (n: number) => void; onProject: (n: number) => void }) {
  useKeyboardShortcuts({ onOpenCheatsheet: vi.fn(), onSwitchProjectPage: onPage, onSwitchProject: onProject })
  return <CommandPalette />
}

describe('CommandPalette: Jump back in', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    searchMissions.mockResolvedValue([])
    chat = {
      conversations: [conv('m-decision', 'Ship the pricing page', 30), conv('m-recent', 'Tidy the logs', 2), conv('m-old', 'Old idea', 500), conv('m-other', 'Beta mission', 3, 'p2')],
      attentionConversationIds: new Set(['m-decision']),
      attentionKinds: new Map(),
      unreadConversationIds: new Set(),
    }
    inboxItems = [inboxItem('q1', 10), inboxItem('r1', 60, { kind: 'blocked', action: 'resume-run', projectId: 'p1', projectName: 'Alpha' })]
    jobs = [
      { id: 'j-run', command: '/specrails:implement', status: 'running', started_at: minutesAgo(1), finished_at: null },
      { id: 'j-old', command: '/specrails:old', status: 'completed', started_at: minutesAgo(900), finished_at: minutesAgo(899) },
    ]
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/jobs')) return Promise.resolve({ ok: true, json: async () => ({ jobs }) })
      if (url.includes('/config')) return Promise.resolve({ ok: true, json: async () => ({ commands: [] }) })
      return Promise.resolve({ ok: false, json: async () => ({}) })
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('leads the empty palette with ONE row about what needs you (it opens the inbox), then the recent missions and jobs with ⌘1–6', async () => {
    asPlatform('MacIntel')
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)
    await waitFor(() => expect(jumpIds()).toContain('palette-jump-job-j-run'))

    expect(headings()[0]).toBe('Jump back in')
    // No inbox item is listed here: the inbox is the list of what needs you.
    expect(jumpIds()).toEqual([
      'palette-jump-inbox',
      'palette-jump-job-j-run', 'palette-jump-mission-m-recent', 'palette-jump-mission-m-other',
      'palette-jump-mission-m-decision', 'palette-jump-mission-m-old', 'palette-jump-job-j-old',
    ])
    const [inboxRow, job, recent, other, decision] = jumpRows()
    expect(inboxRow).toHaveTextContent('2 things need you')
    expect(inboxRow).toHaveTextContent('Open inbox')
    // The inbox row has no chord: ⌘1 is the first recent.
    expect(inboxRow).not.toHaveAttribute('aria-keyshortcuts')
    expect(within(job).getByText('⌘1')).toBeInTheDocument()
    expect(within(recent).getByText('⌘2')).toBeInTheDocument()
    // The shared vocabulary: mission attention and job status through their mappers.
    expect(decision).toHaveAttribute('data-run-state', 'review')
    expect(job).toHaveAttribute('data-run-state', 'working')
    // Project name only outside the active project.
    expect(other).toHaveTextContent('Beta')
    expect(recent).not.toHaveTextContent('Alpha')
    expect(other).toHaveAttribute('aria-label', 'Beta mission, Beta, ⌘3')
    expect(other).toHaveAttribute('aria-keyshortcuts', 'Meta+3')
  })

  it('shows no inbox row when nothing needs you, and opens the inbox from it', async () => {
    const user = userEvent.setup()
    inboxItems = []
    const { unmount } = render(<CommandPalette />)
    await openPalette(user)
    await waitFor(() => expect(jumpIds()).toContain('palette-jump-job-j-run'))
    expect(screen.queryByTestId('palette-jump-inbox')).toBeNull()
    unmount()
    inboxItems = [inboxItem('q1', 10)]
    render(<CommandPalette />)
    await openPalette(user)
    await user.click(await screen.findByTestId('palette-jump-inbox'))
    await waitFor(() => expect(paletteOpen()).toBe(false))
    expect(openInbox).toHaveBeenCalledTimes(1)
    expect(runPrimary).not.toHaveBeenCalled()
  })

  it('is only there while nothing is typed (not with a query, a scope or actions)', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)
    expect(screen.getByTestId('palette-group-jump-back-in')).toBeInTheDocument()
    await user.keyboard('tidy')
    expect(screen.queryByTestId('palette-group-jump-back-in')).toBeNull()
    expect(screen.getByTestId('palette-mission-m-recent')).toBeInTheDocument()
    await user.clear(screen.getByRole('combobox'))
    await user.keyboard('>')
    expect(screen.queryByTestId('palette-group-jump-back-in')).toBeNull()
    await user.clear(screen.getByRole('combobox'))
    await user.keyboard('@')
    expect(screen.getByTestId('palette-scope-chip')).toBeInTheDocument()
    expect(screen.queryByTestId('palette-group-jump-back-in')).toBeNull()
  })

  it('does not list a row twice: jump rows leave the Missions and Jobs groups', async () => {
    chat = { ...chat, conversations: [...chat.conversations, conv('m-ancient', 'Ancient idea', 2000)] }
    jobs = [...jobs, { id: 'j-ancient', command: '/specrails:ancient', status: 'completed', started_at: minutesAgo(3000), finished_at: minutesAgo(2999) }]
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)
    await waitFor(() => expect(jumpIds()).toContain('palette-jump-job-j-run'))
    const missions = within(screen.getByTestId('palette-group-missions')).getAllByTestId(/^palette-mission-/)
    expect(missions.map((m) => m.getAttribute('data-testid'))).toEqual(['palette-mission-m-ancient'])
    const jobGroup = screen.getByText('Jobs').closest('[cmdk-group]') as HTMLElement
    expect(within(jobGroup).getAllByRole('option')).toHaveLength(1)
    expect(within(jobGroup).getByText('/specrails:ancient')).toBeInTheDocument()
    expect(within(jobGroup).queryByText('/specrails:implement')).toBeNull()
  })

  it('⌘N opens that row and closes the palette, with each kind\'s own handler', async () => {
    asPlatform('MacIntel')
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)
    await waitFor(() => expect(jumpIds()).toContain('palette-jump-job-j-run'))

    digit(1, { metaKey: true })
    await waitFor(() => expect(paletteOpen()).toBe(false))
    expect(navigate).toHaveBeenCalledWith('/jobs/j-run')

    await openPalette(user)
    await waitFor(() => expect(jumpIds()).toContain('palette-jump-job-j-run'))
    digit(2, { metaKey: true })
    await waitFor(() => expect(paletteOpen()).toBe(false))
    expect(selectConversation).toHaveBeenCalledWith('m-recent')
    expect(openAgentPanel).toHaveBeenCalled()
    // Never an inbox action from a digit.
    expect(runPrimary).not.toHaveBeenCalled()
    expect(openInbox).not.toHaveBeenCalled()
  })

  it('Enter on a row opens it like a click does', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)
    await user.click(screen.getByTestId('palette-jump-mission-m-recent'))
    await waitFor(() => expect(paletteOpen()).toBe(false))
    expect(selectConversation).toHaveBeenCalledWith('m-recent')
  })

  it('uses Ctrl off macOS: the hint says Ctrl+N and ⌘N does nothing', async () => {
    asPlatform('Win32')
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)
    await waitFor(() => expect(jumpIds()).toContain('palette-jump-job-j-run'))
    const first = jumpRows()[1]
    expect(within(first).getByText('Ctrl+1')).toBeInTheDocument()
    expect(first).toHaveAttribute('aria-keyshortcuts', 'Control+1')

    digit(2, { metaKey: true })
    expect(paletteOpen()).toBe(true)
    expect(selectConversation).not.toHaveBeenCalled()
    digit(2, { ctrlKey: true })
    await waitFor(() => expect(paletteOpen()).toBe(false))
    expect(selectConversation).toHaveBeenCalledWith('m-recent')
  })

  it('keeps the app\'s own digit chords quiet while open (page ⌘1–5 and project ⌥⌘1–9), and only then', async () => {
    asPlatform('MacIntel')
    const onPage = vi.fn()
    const onProject = vi.fn()
    const user = userEvent.setup()
    render(<WithGlobalShortcuts onPage={onPage} onProject={onProject} />)
    await openPalette(user)

    // From outside any field or dialog the global handler would otherwise take them
    // (⌘7: past the six rows, so nothing is activated either).
    digit(7, { metaKey: true }, document.body)
    digit(2, { metaKey: true, altKey: true }, document.body)
    expect(paletteOpen()).toBe(true)
    expect(onPage).not.toHaveBeenCalled()
    expect(onProject).not.toHaveBeenCalled()
    // With a query ⌘N is nothing special and still never navigates.
    await user.keyboard('zzz')
    digit(1, { metaKey: true }, document.body)
    digit(3, { ctrlKey: true }, document.body)
    expect(paletteOpen()).toBe(true)
    expect(onPage).not.toHaveBeenCalled()
    expect(runPrimary).not.toHaveBeenCalled()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(paletteOpen()).toBe(false))
    digit(2, { metaKey: true }, document.body)
    expect(onPage).toHaveBeenCalledWith(2)
  })

  it('freezes the order for the opening: states update in place, the next opening re-sorts', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<CommandPalette />)
    await openPalette(user)
    await waitFor(() => expect(jumpIds()).toContain('palette-jump-job-j-run'))
    const before = jumpIds()

    // m-decision is now the newest and failed; the inbox count changes in place.
    chat = {
      ...chat,
      conversations: chat.conversations.map((c) => (c.id === 'm-decision' ? { ...c, updated_at: minutesAgo(0) } : c)),
      attentionKinds: new Map([['m-decision', 'failed']]),
    }
    inboxItems = [inboxItem('new', 0), ...inboxItems]
    rerender(<CommandPalette />)

    expect(jumpIds()).toEqual(before)
    expect(screen.getByTestId('palette-jump-mission-m-decision')).toHaveAttribute('data-run-state', 'failed')
    expect(screen.getByTestId('palette-jump-inbox')).toHaveTextContent('3 things need you')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(paletteOpen()).toBe(false))
    await openPalette(user)
    // Re-sorted: m-decision is the open project's newest.
    await waitFor(() => expect(jumpIds()[1]).toBe('palette-jump-mission-m-decision'))
  })

})
