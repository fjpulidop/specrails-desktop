import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { CommandPalette } from '../CommandPalette'
import { OPEN_APP_SETTINGS_EVENT, OPEN_BUDGET_PANEL_EVENT, OPEN_PROJECT_SETTINGS_EVENT } from '../../lib/app-settings-events'
import { OPEN_DOCS_EVENT } from '../../lib/docs-events'
import type { AgentConversation } from '../../features/missions/lib/agent-api'

// Scoped ⌘K search (CD6): prefixes, scope chip, each scope's rows and what
// selecting them does. The generic palette suite is CommandPalette.test.tsx.

beforeEach(() => {
  global.ResizeObserver = vi.fn().mockImplementation(function () {
    return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }
  })
})

let activeProjectId: string | null = 'p1'
vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [{ id: 'p1', slug: 'neotetris', name: 'NeoTetris', path: '/a', db_path: '/a/db', provider: 'claude', added_at: '', last_seen_at: '' }],
    activeProjectId,
    setActiveProjectId: vi.fn(),
  }),
}))
vi.mock('../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))

const navigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigate }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

let uiMode: 'kanban' | 'agent' = 'agent'
vi.mock('../../context/UiModeContext', () => ({
  useUiMode: () => ({ uiMode, setUiMode: vi.fn(), toggleUiMode: vi.fn() }),
}))

const openTicketDetail = vi.fn()
vi.mock('../../features/specs/context/TicketDetailModalContext', () => ({
  useTicketDetailModal: () => ({ openTicketDetail }),
}))

function conv(id: string, title: string): AgentConversation {
  const at = new Date(Date.now() - 60_000).toISOString()
  return { id, title, provider: 'claude', model: null, session_id: null, pinned_project_id: 'p1', tier_level: 0, reasoning_effort: null, created_at: at, updated_at: at }
}
const selectConversation = vi.fn(async () => {})
vi.mock('../../features/missions/context/AgentChatContext', () => ({
  useAgentChat: () => ({
    conversations: [conv('c-tetris', 'Tetris rewrite'), conv('c-deploy', 'Deploy review')],
    liveByConversation: new Map(),
    selectConversation,
    open: vi.fn(),
    startNewConversation: vi.fn(),
  }),
}))
const searchMissions = vi.fn(async () => [])
vi.mock('../../features/missions/lib/agent-api', () => ({
  searchMissions: (...args: unknown[]) => (searchMissions as unknown as (...a: unknown[]) => Promise<unknown[]>)(...args),
}))

const responses: Record<string, unknown> = {}
const fetchMock = vi.fn(async (url: string) => {
  const key = Object.keys(responses).find((k) => url.includes(k))
  return { ok: key !== undefined, json: async () => (key ? responses[key] : {}) }
})

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Meta>}k{/Meta}')
  return screen.findByRole('combobox')
}
const calls = (fragment: string) => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(fragment))

describe('CommandPalette — scoped search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeProjectId = 'p1'
    uiMode = 'agent'
    for (const k of Object.keys(responses)) delete responses[k]
    global.fetch = fetchMock as unknown as typeof fetch
  })
  afterEach(() => { vi.useRealTimers() })

  it('lists the prefixes on an empty query and a hint enters its scope', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)
    const hints = await screen.findByTestId('palette-scope-hints')
    for (const prefix of ['#', '@', '/', 'f:', 'log:', '?']) expect(within(hints).getByText(prefix)).toBeInTheDocument()

    await user.click(screen.getByTestId('palette-scope-hint-settings'))
    expect(screen.getByTestId('palette-scope-chip')).toHaveTextContent('Settings')
    expect(screen.getByPlaceholderText('Search settings…')).toBeInTheDocument()
    expect(screen.queryByTestId('palette-scope-hints')).not.toBeInTheDocument()
  })

  it('turns a typed prefix into a chip and keeps only the query in the input; Backspace on empty removes it', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)

    await user.type(input, '#')
    const chip = screen.getByTestId('palette-scope-chip')
    expect(chip).toHaveTextContent('Specs')
    expect(input).toHaveValue('')
    expect(screen.getByTestId('palette-scope-prompt')).toHaveTextContent('Type to search specs.')
    expect(screen.getByTestId('palette-footer-remove-scope')).toBeInTheDocument()

    await user.type(input, 'ab')
    expect(input).toHaveValue('ab')
    await user.keyboard('{Backspace}{Backspace}')
    expect(input).toHaveValue('')
    expect(screen.getByTestId('palette-scope-chip')).toBeInTheDocument()
    await user.keyboard('{Backspace}')
    expect(screen.queryByTestId('palette-scope-chip')).not.toBeInTheDocument()
    expect(screen.getByTestId('palette-scope-hints')).toBeInTheDocument()
  })

  it('recognises every prefix, including the word ones, and the chip button removes the scope', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    const expected: Array<[string, string]> = [['@', 'Missions'], ['/', 'Settings'], ['f:', 'Files'], ['log:', 'Job logs'], ['?', 'Guide']]
    for (const [prefix, label] of expected) {
      await user.type(input, prefix)
      expect(screen.getByTestId('palette-scope-chip')).toHaveTextContent(label)
      await user.click(screen.getByTestId('palette-scope-remove'))
      expect(screen.queryByTestId('palette-scope-chip')).not.toBeInTheDocument()
    }
  })

  it('keeps ">" actions and unscoped search as they were (no chip)', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, '>new')
    expect(screen.queryByTestId('palette-scope-chip')).not.toBeInTheDocument()
    expect(input).toHaveValue('>new')
    expect(await screen.findByTestId('palette-group-actions')).toBeInTheDocument()
  })

  it('# searches specs of the active project, highlights the snippet and opens the spec', async () => {
    responses['/search/specs'] = {
      results: [
        { id: 12, title: 'Rate limiter', status: 'in_progress', priority: 'high', field: 'description', snippet: { text: '…throttle the API per token…', ranges: [[1, 9]] } },
        { id: 3, title: 'Throttle <b>uploads</b>', status: 'todo', priority: null, field: 'title', snippet: null },
      ],
    }
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, '#throttle')

    const row = await screen.findByTestId('palette-spec-12')
    expect(calls('/search/specs')[0]).toContain('q=throttle')
    expect(row).toHaveTextContent('#12')
    expect(row).toHaveTextContent('In Progress')
    const mark = within(screen.getByTestId('palette-spec-snippet-12')).getByText('throttle')
    expect(mark.tagName).toBe('MARK')
    expect(row).toHaveTextContent('Description')
    // Highlight is by ranges, never HTML: a title with markup shows literally.
    expect(screen.getByTestId('palette-spec-3')).toHaveTextContent('Throttle <b>uploads</b>')
    expect(document.querySelector('[data-testid="palette-spec-3"] b')).toBeNull()

    await user.click(row)
    expect(openTicketDetail).toHaveBeenCalledWith(12)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('@ lists missions only and selects one', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, '@')
    expect(screen.getByTestId('palette-mission-c-tetris')).toBeInTheDocument()
    expect(screen.queryByTestId('palette-group-projects')).not.toBeInTheDocument()
    await user.type(input, 'tetris')
    expect(screen.queryByTestId('palette-mission-c-deploy')).not.toBeInTheDocument()
    await waitFor(() => expect(searchMissions).toHaveBeenCalledWith('tetris', expect.any(Number), expect.any(AbortSignal)))
    await user.click(screen.getByTestId('palette-mission-c-tetris'))
    expect(selectConversation).toHaveBeenCalledWith('c-tetris')
  })

  it('/ lists settings in the active locale, opens the app modal at the field and the project modal in Mission mode', async () => {
    const appEvents: unknown[] = []
    const projectEvents: unknown[] = []
    const onApp = (e: Event) => appEvents.push((e as CustomEvent).detail)
    const onProject = (e: Event) => projectEvents.push((e as CustomEvent).detail)
    window.addEventListener(OPEN_APP_SETTINGS_EVENT, onApp)
    window.addEventListener(OPEN_PROJECT_SETTINGS_EVENT, onProject)
    try {
      const user = userEvent.setup()
      render(<CommandPalette />)
      const input = await openPalette(user)
      await user.type(input, '/webhook')
      const row = await screen.findByTestId('palette-setting-webhooks')
      expect(row).toHaveTextContent('Outbound webhooks')
      expect(row).toHaveTextContent('Desktop settings · Webhooks')
      await user.click(row)
      expect(appEvents).toEqual([{ section: 'webhooks', settingId: 'webhooks' }])

      await user.keyboard('{Meta>}k{/Meta}')
      const input2 = await screen.findByRole('combobox')
      await user.type(input2, '/budget')
      await user.click(await screen.findByTestId('palette-setting-projectBudget'))
      expect(projectEvents).toEqual([{ section: 'budget', settingId: 'projectBudget' }])
    } finally {
      window.removeEventListener(OPEN_APP_SETTINGS_EVENT, onApp)
      window.removeEventListener(OPEN_PROJECT_SETTINGS_EVENT, onProject)
    }
  })

  it('/implement lists the matching slash command under the settings instead of "Nothing found"', async () => {
    responses['/config'] = { commands: [
      { id: 'c1', name: 'Implement', slug: 'implement', description: 'Implement a spec end to end' },
      { id: 'c2', name: 'Batch implement', slug: 'batch-implement', description: '' },
      { id: 'c3', name: 'Retry', slug: 'retry', description: '' },
    ] }
    responses['/spawn'] = { jobId: 'job-1' }
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, '/implement')
    const group = await screen.findByTestId('palette-group-slash-commands')
    expect(group).toHaveTextContent('Commands matching “/implement”')
    expect(within(group).getByTestId('palette-slash-command-implement')).toBeInTheDocument()
    expect(within(group).getByTestId('palette-slash-command-batch-implement')).toBeInTheDocument()
    expect(within(group).queryByTestId('palette-slash-command-retry')).toBeNull()
    // While there are command rows the "nothing found" message stays away.
    expect(screen.queryByTestId('palette-scope-empty')).toBeNull()
    await user.click(within(group).getByTestId('palette-slash-command-implement'))
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/spawn'))).toBe(true))
  })

  it('/ keeps "Nothing found" when neither a setting nor a command matches', async () => {
    responses['/config'] = { commands: [{ id: 'c1', name: 'Implement', slug: 'implement', description: '' }] }
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, '/zzzzqq')
    expect(await screen.findByTestId('palette-scope-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('palette-group-slash-commands')).toBeNull()
  })

  it('/budget finds the Budget panel (weekly and monthly caps live there) and opens it', async () => {
    const opened = vi.fn()
    window.addEventListener(OPEN_BUDGET_PANEL_EVENT, opened)
    try {
      const user = userEvent.setup()
      render(<CommandPalette />)
      const input = await openPalette(user)
      await user.type(input, '/weekly')
      // "weekly" is only a keyword of the panel: no settings block carries it.
      const row = await screen.findByTestId('palette-setting-action-budget.open')
      expect(row).toHaveTextContent('Open Budget (caps, projection, what-if)')
      await user.click(row)
      expect(opened).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    } finally { window.removeEventListener(OPEN_BUDGET_PANEL_EVENT, opened) }
  })

  it('/ does not offer the Budget panel without a project', async () => {
    activeProjectId = null
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, '/weekly')
    expect(screen.queryByTestId('palette-setting-action-budget.open')).toBeNull()
  })

  it('the empty palette: one-line hints without a label, the open project is not offered as a switch, and the placeholder teaches the prefixes', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)
    const hints = await screen.findByTestId('palette-scope-hints')
    expect(hints).toHaveClass('flex-nowrap', 'overflow-hidden')
    expect(hints).not.toHaveTextContent('Search in')
    expect(screen.getByPlaceholderText('Search, or type # @ / ? to narrow…')).toBeInTheDocument()
    // NeoTetris is the only (and the active) project: nothing to switch to, so Enter can't switch.
    expect(screen.queryByTestId('palette-group-projects')).toBeNull()
  })

  it('/ sends Board mode to /settings?setting= and hides project settings without a project', async () => {
    uiMode = 'kanban'
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, '/integration')
    await user.click(await screen.findByTestId('palette-setting-integrationBranch'))
    expect(navigate).toHaveBeenCalledWith('/settings?setting=integrationBranch')

    activeProjectId = null
    await user.keyboard('{Meta>}k{/Meta}')
    const input2 = await screen.findByRole('combobox')
    await user.type(input2, '/integration')
    expect(screen.queryByTestId('palette-setting-integrationBranch')).not.toBeInTheDocument()
  })

  it('shows a small Settings group for a strong unscoped match, not for weak ones', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, 'webhook')
    const group = await screen.findByTestId('palette-group-settings')
    expect(within(group).getAllByRole('option').length).toBeLessThanOrEqual(3)
    expect(within(group).getByTestId('palette-setting-webhooks')).toBeInTheDocument()

    await user.clear(input)
    await user.type(input, 'th')
    expect(screen.queryByTestId('palette-group-settings')).not.toBeInTheDocument()
  })

  it('f: uses the code explorer file finder and opens the file in the explorer', async () => {
    responses['/code/find'] = { query: 'store', matches: [{ path: 'server/db/store.ts', sizeBytes: 10, match: 'name' }, { path: 'README.md', sizeBytes: 4, match: 'path' }] }
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, 'f:store')
    const rows = await screen.findAllByTestId('palette-file')
    expect(calls('/code/find')[0]).toContain('/api/projects/p1/code/find?q=store')
    expect(rows[0]).toHaveTextContent('store.ts')
    expect(rows[0]).toHaveTextContent('server/db')
    expect(within(rows[0]).getByText('store').tagName).toBe('MARK')
    await user.click(rows[0])
    expect(navigate).toHaveBeenCalledWith('/code?path=server%2Fdb%2Fstore.ts')
  })

  it('log: searches job logs with highlighted snippets and opens the job', async () => {
    responses['/search/jobs'] = {
      results: [{ jobId: 'job-9', command: '/specrails:implement #4', status: 'failed', startedAt: '', field: 'detail', snippet: { text: 'Playwright browsers are not installed', ranges: [[0, 10]] } }],
    }
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, 'log:playwright')
    const row = await screen.findByTestId('palette-log-job-9')
    expect(calls('/search/jobs')[0]).toContain('q=playwright')
    expect(row).toHaveTextContent('Failed')
    expect(row).toHaveTextContent('Detail')
    expect(within(screen.getByTestId('palette-log-snippet-job-9')).getByText('Playwright').tagName).toBe('MARK')
    await user.click(row)
    expect(navigate).toHaveBeenCalledWith('/jobs/job-9')
  })

  it('? searches the guide and opens it at the heading', async () => {
    responses['/api/docs/search'] = {
      results: [
        { category: 'pipeline', categoryName: 'Pipeline', slug: 'rails-and-jobs', title: 'Rails and jobs', heading: 'Daily budgets', anchor: 'daily-budgets' },
        { category: 'start', categoryName: 'Start', slug: 'budget', title: 'Budget basics', heading: null, anchor: null },
      ],
    }
    const docEvents: unknown[] = []
    const onDocs = (e: Event) => docEvents.push((e as CustomEvent).detail)
    window.addEventListener(OPEN_DOCS_EVENT, onDocs)
    try {
      const user = userEvent.setup()
      render(<CommandPalette />)
      const input = await openPalette(user)
      await user.type(input, '?budget')
      const rows = await screen.findAllByTestId('palette-doc')
      expect(calls('/api/docs/search')[0]).toMatch(/lang=en&q=budget/)
      expect(rows[0]).toHaveTextContent('Daily budgets')
      expect(rows[0]).toHaveTextContent('Rails and jobs')
      await user.click(rows[0])
      expect(docEvents).toEqual([{ target: { category: 'pipeline', slug: 'rails-and-jobs', anchor: 'daily-budgets', heading: 'Daily budgets' } }])
    } finally {
      window.removeEventListener(OPEN_DOCS_EVENT, onDocs)
    }
  })

  it('caps the rows of a scope and says so when nothing matches or the request fails', async () => {
    responses['/code/find'] = { matches: Array.from({ length: 40 }, (_, i) => ({ path: `src/file-${i}.ts`, sizeBytes: 1, match: 'name' })) }
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, 'f:file')
    await waitFor(() => expect(screen.getAllByTestId('palette-file').length).toBe(10))

    await user.clear(input)
    delete responses['/code/find']
    await user.type(input, 'zzz')
    expect(await screen.findByTestId('palette-scope-failed')).toBeInTheDocument()

    await user.keyboard('{Backspace}{Backspace}{Backspace}')
    responses['/code/find'] = { matches: [] }
    await user.type(input, 'qqq')
    expect(await screen.findByTestId('palette-scope-empty')).toHaveTextContent('Nothing found for “qqq”.')
  })

  it('asks to open a project for project-bound scopes and never calls the API', async () => {
    activeProjectId = null
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, 'log:abc')
    expect(await screen.findByTestId('palette-scope-needs-project')).toBeInTheDocument()
    expect(calls('/search/')).toEqual([])
  })

  it('debounces typing into one request and drops a superseded answer', async () => {
    let resolveFirst!: (v: unknown) => void
    let n = 0
    const slow = vi.fn(async (url: string) => {
      n++
      if (n === 1) return new Promise((r) => { resolveFirst = () => r({ ok: true, json: async () => ({ results: [{ id: 1, title: 'old answer', status: 'todo', priority: null, field: 'title', snippet: null }] }) }) })
      return { ok: true, json: async () => ({ results: [{ id: 2, title: 'new answer', status: 'todo', priority: null, field: 'title', snippet: null }] }) }
    })
    global.fetch = slow as unknown as typeof fetch
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, '#ol')
    await waitFor(() => expect(slow.mock.calls.filter((c) => String(c[0]).includes('/search/specs')).length).toBe(1))
    fireEvent.change(input, { target: { value: 'new' } })
    expect(await screen.findByTestId('palette-spec-2')).toBeInTheDocument()
    resolveFirst(null)
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId('palette-spec-1')).not.toBeInTheDocument()
  })
})
