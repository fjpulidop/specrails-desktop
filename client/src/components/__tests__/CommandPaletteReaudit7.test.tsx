import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { CommandPalette } from '../CommandPalette'
import type { AgentConversation, MissionSearchHit } from '../../features/missions/lib/agent-api'

// Re-audit 7: a lighter empty palette (5 missions, 5 jobs, open project first), jobs named by
// their spec, settings ahead of a mission that only mentions the word, no duplicate "esc".

beforeEach(() => {
  global.ResizeObserver = vi.fn().mockImplementation(function () {
    return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }
  })
})

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [
      { id: 'p1', slug: 'alpha', name: 'Alpha', path: '/a', db_path: '/a/db', provider: 'claude', added_at: '', last_seen_at: '' },
      { id: 'p2', slug: 'beta', name: 'Beta', path: '/b', db_path: '/b/db', provider: 'claude', added_at: '', last_seen_at: '' },
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
vi.mock('../../context/UiModeContext', () => ({
  useUiMode: () => ({ uiMode: 'kanban', setUiMode: vi.fn(), toggleUiMode: vi.fn() }),
}))

function conv(id: string, title: string, minutesAgo: number, pinned: string | null = null): AgentConversation {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  return { id, title, provider: 'claude', model: null, session_id: null, pinned_project_id: pinned, tier_level: 0, reasoning_effort: null, created_at: at, updated_at: at }
}

// The two newest missions belong to ANOTHER project; seven more of this one follow.
const conversations: AgentConversation[] = [
  conv('x1', 'Other project newest', 1, 'p2'),
  conv('x2', 'Other project second', 2, 'p2'),
  ...Array.from({ length: 7 }, (_, i) => conv(`m${i}`, `Own mission ${i}`, 10 + i, 'p1')),
]
vi.mock('../../features/missions/context/AgentChatContext', () => ({
  useAgentChat: () => ({ conversations, liveByConversation: new Map(), selectConversation: vi.fn(async () => {}), open: vi.fn() }),
}))

const searchMissions = vi.fn<(q: string, limit?: number, signal?: AbortSignal) => Promise<MissionSearchHit[]>>()
vi.mock('../../features/missions/lib/agent-api', () => ({
  searchMissions: (...args: [string, number?, AbortSignal?]) => searchMissions(...args),
}))

const jobs = [
  { id: 'j1', command: 'loop: Flow → Spec #14', status: 'running', started_at: '2026-10-24T10:00:00Z', ticketId: 14, ticketTitle: 'Add live job status' },
  ...Array.from({ length: 6 }, (_, i) => ({ id: `j${i + 2}`, command: `/specrails:task-${i}`, status: 'completed', started_at: '2026-10-24T09:00:00Z' })),
]

function groupHeadings(): string[] {
  return Array.from(document.querySelectorAll('[cmdk-group-heading]')).map((el) => el.textContent ?? '')
}
async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Meta>}k{/Meta}')
  await waitFor(() => expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument())
}

describe('CommandPalette: re-audit 7', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    searchMissions.mockResolvedValue([])
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/jobs')) return Promise.resolve({ ok: true, json: async () => ({ jobs }) })
      if (url.includes('/config')) return Promise.resolve({ ok: true, json: async () => ({ commands: [] }) })
      return Promise.resolve({ ok: false, json: async () => ({}) })
    })
  })

  it('keeps the empty palette short: 5 missions (open project first) and 5 jobs', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)
    await screen.findByText('Add live job status', { exact: false })

    const missions = within(screen.getByTestId('palette-group-missions')).getAllByTestId(/^palette-mission-/)
    expect(missions).toHaveLength(5)
    // Enter on the first row must stay in this project: its own missions lead, the other project's trail.
    expect(missions.map((m) => m.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Own mission 0')]))
    expect(screen.queryByText('Other project newest')).toBeNull()
    expect(screen.getByText('Own mission 4')).toBeInTheDocument()

    const jobGroup = screen.getByText('Jobs').closest('[cmdk-group]') as HTMLElement
    expect(within(jobGroup).getAllByRole('option')).toHaveLength(5)
  })

  it('names a job by its spec instead of the raw command, with a lamp for the state', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)
    const row = (await screen.findByText('#14 Add live job status')).closest('[cmdk-item]') as HTMLElement
    expect(row).not.toHaveTextContent('loop: Flow')
    expect(row.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(row.querySelector('[aria-hidden="true"]:not(svg)')).not.toBeNull()
    // A typed spec title finds the job too.
    await user.keyboard('live job')
    await waitFor(() => expect(screen.getByText('#14 Add live job status')).toBeInTheDocument())
    expect(screen.queryByText('/specrails:task-0')).toBeNull()
  })

  it('puts a setting that starts with the query before a mission that only mentions it', async () => {
    searchMissions.mockResolvedValue([
      { conversation: conversations[2]!, match: 'content', messageId: 'mm', snippet: { text: 'mentions density somewhere', ranges: [[9, 16]] } },
    ])
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)
    await user.keyboard('density')
    await waitFor(() => expect(screen.getByTestId('palette-group-settings')).toBeInTheDocument())
    await screen.findByTestId('palette-mission-m0')
    const headings = groupHeadings()
    expect(headings.indexOf('Settings')).toBeLessThan(headings.indexOf('Missions'))
  })

  it('keeps settings last when the query only matches a keyword', async () => {
    searchMissions.mockResolvedValue([
      { conversation: conversations[2]!, match: 'content', messageId: 'mm', snippet: { text: 'spacing notes', ranges: [[0, 7]] } },
    ])
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)
    await user.keyboard('spacing')
    await screen.findByTestId('palette-mission-m0')
    const headings = groupHeadings()
    if (headings.includes('Settings')) expect(headings.indexOf('Settings')).toBeGreaterThan(headings.indexOf('Missions'))
  })

  it('has one "esc" hint (the footer), not a second chip beside the input', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)
    expect(screen.getAllByText('esc')).toHaveLength(1)
  })
})
