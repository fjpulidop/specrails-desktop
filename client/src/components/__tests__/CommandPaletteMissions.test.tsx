import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { CommandPalette } from '../CommandPalette'
import type { AgentConversation, MissionSearchHit } from '../../lib/agent-api'

// Mission-search behaviour of the ⌘K palette (search-missions-in-palette).
// The generic palette suite lives in CommandPalette.test.tsx; this file mocks
// the agent chat context, the UI mode and the search endpoint.

beforeEach(() => {
  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }))
})

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [
      { id: 'p1', slug: 'neotetris', name: 'NeoTetris', path: '/a', db_path: '/a/db', provider: 'claude', added_at: '', last_seen_at: '' },
    ],
    activeProjectId: 'p1',
    setActiveProjectId: vi.fn(),
  }),
}))

vi.mock('../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => vi.fn() }
})

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

let uiMode: 'kanban' | 'agent' = 'agent'
vi.mock('../../context/UiModeContext', () => ({
  useUiMode: () => ({ uiMode, setUiMode: vi.fn(), toggleUiMode: vi.fn() }),
}))

function conv(id: string, title: string | null, updatedAt: string, pinned: string | null = null): AgentConversation {
  return {
    id, title, provider: 'claude', model: null, session_id: null, pinned_project_id: pinned,
    tier_level: 0, reasoning_effort: null, created_at: updatedAt, updated_at: updatedAt,
  }
}

const tetris = conv('c-tetris', 'Tetris rewrite', new Date(Date.now() - 3 * 60_000).toISOString(), 'p1')
const deploy = conv('c-deploy', 'Revisar la misión de deploy', new Date(Date.now() - 60 * 60_000).toISOString())
const oldOne = conv('c-old', 'Ancient thread', new Date(Date.now() - 48 * 3_600_000).toISOString())

const selectConversation = vi.fn(async () => {})
const openAgentPanel = vi.fn()
const liveByConversation = new Map<string, { isStreaming: boolean }>([['c-tetris', { isStreaming: true }]])
vi.mock('../../context/AgentChatContext', () => ({
  useAgentChat: () => ({
    conversations: [tetris, deploy, oldOne],
    liveByConversation,
    selectConversation,
    open: openAgentPanel,
  }),
}))

const searchMissions = vi.fn<(q: string, limit?: number, signal?: AbortSignal) => Promise<MissionSearchHit[]>>()
vi.mock('../../lib/agent-api', () => ({
  searchMissions: (...args: [string, number?, AbortSignal?]) => searchMissions(...args),
}))

function contentHit(conversation: AgentConversation, text: string, ranges: Array<[number, number]>): MissionSearchHit {
  return { conversation, match: 'content', messageId: `m-${conversation.id}`, snippet: { text, ranges } }
}

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Meta>}k{/Meta}')
  await waitFor(() => expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument())
}

/** Group headings in DOM order (cmdk renders them as `[cmdk-group-heading]`). */
function groupHeadings(): string[] {
  return Array.from(document.querySelectorAll('[cmdk-group-heading]')).map((el) => el.textContent ?? '')
}

describe('CommandPalette — missions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    uiMode = 'agent'
    searchMissions.mockResolvedValue([])
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
  })

  it('lists recent missions first in Agent Mode and uses the mission placeholder', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)

    expect(screen.getByPlaceholderText('Search missions, projects, jobs...')).toBeInTheDocument()
    const headings = groupHeadings()
    expect(headings.indexOf('Missions')).toBeGreaterThanOrEqual(0)
    expect(headings.indexOf('Missions')).toBeLessThan(headings.indexOf('Projects'))
    expect(screen.getByText('Tetris rewrite')).toBeInTheDocument()
    expect(screen.getByText('Revisar la misión de deploy')).toBeInTheDocument()
    expect(screen.getByTestId('palette-mission-live-c-tetris')).toBeInTheDocument()
    expect(searchMissions).not.toHaveBeenCalled()
  })

  it('renders projects before missions on the board and keeps the classic placeholder', async () => {
    uiMode = 'kanban'
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)

    expect(screen.getByPlaceholderText('Search projects, commands, jobs...')).toBeInTheDocument()
    const headings = groupHeadings()
    expect(headings.indexOf('Projects')).toBeGreaterThanOrEqual(0)
    expect(headings.indexOf('Projects')).toBeLessThan(headings.indexOf('Missions'))
  })

  it('shows title matches before the server answers, then merges the content snippet', async () => {
    let resolve!: (hits: MissionSearchHit[]) => void
    searchMissions.mockImplementation(() => new Promise<MissionSearchHit[]>((r) => { resolve = r }))
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)

    await user.type(screen.getByPlaceholderText(/search/i), 'tetris')

    // Phase A: the title row is already there while the request is pending.
    expect(screen.getByText('Tetris rewrite')).toBeInTheDocument()
    expect(screen.queryByText('Revisar la misión de deploy')).not.toBeInTheDocument()
    await waitFor(() => expect(searchMissions).toHaveBeenCalledWith('tetris', expect.any(Number), expect.any(AbortSignal)))

    // Phase B: the server adds an older content hit with its highlighted snippet.
    resolve([contentHit(oldOne, '…the tetris scoring bug…', [[5, 11]])])
    await waitFor(() => expect(screen.getByText('Ancient thread')).toBeInTheDocument())
    const snippet = screen.getByTestId('palette-mission-snippet-c-old')
    expect(snippet).toHaveTextContent('the tetris scoring bug')
    expect(within(snippet).getByText('tetris').tagName).toBe('MARK')
    // Row metadata: pinned project name for the tetris mission, Home for the unpinned one.
    expect(within(screen.getByTestId('palette-mission-c-tetris')).getByText('NeoTetris')).toBeInTheDocument()
    expect(within(screen.getByTestId('palette-mission-c-old')).getByText('Home')).toBeInTheDocument()
  })

  it('matches titles with folded diacritics from memory', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)

    await user.type(screen.getByPlaceholderText(/search/i), 'mision')
    expect(screen.getByText('Revisar la misión de deploy')).toBeInTheDocument()
    expect(screen.queryByText('Tetris rewrite')).not.toBeInTheDocument()
  })

  it('discards a stale server answer that belongs to an earlier query', async () => {
    const pending = new Map<string, (hits: MissionSearchHit[]) => void>()
    searchMissions.mockImplementation((q) => new Promise<MissionSearchHit[]>((r) => { pending.set(q, r) }))
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)

    const input = screen.getByPlaceholderText(/search/i)
    await user.type(input, 'anc')
    await waitFor(() => expect(pending.has('anc')).toBe(true))
    await user.type(input, 'ient')
    await waitFor(() => expect(pending.has('ancient')).toBe(true))

    // The old answer arrives late: it must not add rows to the "ancient" query.
    pending.get('anc')!([contentHit(deploy, 'anc… stale', [[0, 3]])])
    pending.get('ancient')!([])
    await waitFor(() => expect(screen.getByText('Ancient thread')).toBeInTheDocument())
    expect(screen.queryByTestId('palette-mission-snippet-c-deploy')).not.toBeInTheDocument()
    expect(screen.queryByText('Revisar la misión de deploy')).not.toBeInTheDocument()
  })

  it('Enter opens the mission in Agent Mode without touching the floating panel', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)

    await user.click(screen.getByText('Tetris rewrite'))

    expect(selectConversation).toHaveBeenCalledWith('c-tetris')
    expect(openAgentPanel).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument())
  })

  it('Enter on the board opens the mission AND the floating panel', async () => {
    uiMode = 'kanban'
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)

    await user.click(screen.getByText('Tetris rewrite'))

    expect(selectConversation).toHaveBeenCalledWith('c-tetris')
    expect(openAgentPanel).toHaveBeenCalledTimes(1)
  })

  it('keeps the empty state when nothing matches anywhere', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)

    await user.type(screen.getByPlaceholderText(/search/i), 'zzzz-nothing')
    await waitFor(() => expect(screen.getByText('No results found.')).toBeInTheDocument())
    expect(screen.queryByTestId('palette-group-missions')).not.toBeInTheDocument()
  })
})
