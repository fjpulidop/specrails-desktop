import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { CommandPalette } from '../CommandPalette'
import { registerPaletteSurface, resetPaletteSurfaces } from '../../lib/palette-bridge'
import { RECENT_ACTIONS_KEY } from '../command-palette/recent-actions'

beforeEach(() => {
  global.ResizeObserver = vi.fn().mockImplementation(function () {
    return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }
  })
  // cmdk scrolls the selected row into view
  Element.prototype.scrollIntoView = vi.fn()
})

const mockSetActiveProjectId = vi.fn()
vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [
      { id: 'p1', slug: 'alpha', name: 'Project Alpha', path: '/a', db_path: '/a/db', provider: 'claude', added_at: '', last_seen_at: '' },
      { id: 'p2', slug: 'beta', name: 'Project Beta', path: '/b', db_path: '/b/db', provider: 'claude', added_at: '', last_seen_at: '' },
    ],
    activeProjectId: 'p1',
    setActiveProjectId: mockSetActiveProjectId,
  }),
}))
vi.mock('../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), promise: vi.fn() } }))

const mockSetTheme = vi.fn(async () => {})
vi.mock('../../features/settings/context/ThemeContext', () => ({
  useThemeOptional: () => ({ themeId: 'specrails', setTheme: mockSetTheme }),
}))

let undoLabel: string | null = null
const mockUndoLast = vi.fn(async () => true)
vi.mock('../../hooks/useUndo', () => ({
  useUndo: () => ({ pushUndo: () => false, undoLast: mockUndoLast, peekUndo: () => undoLabel }),
}))

const mockPlaceBack = vi.fn()
let recentPlaces: { to: { pathname: string; search: string }; label: string; key: string }[] = []
vi.mock('../../hooks/usePlaceHistory', () => ({
  usePlaceHistory: () => ({
    canBack: true, canForward: false, back: mockPlaceBack, forward: vi.fn(),
    recent: () => recentPlaces,
  }),
}))

const mockStartNewConversation = vi.fn()
vi.mock('../../features/missions/context/AgentChatContext', async () => {
  const actual = await vi.importActual<typeof import('../../features/missions/context/AgentChatContext')>('../../features/missions/context/AgentChatContext')
  return { ...actual, useAgentChat: () => ({ ...actual.useAgentChat(), startNewConversation: mockStartNewConversation }) }
})

vi.mock('../../features/loops/lib/loops-api', () => ({
  loopsApi: {
    list: vi.fn(async () => [
      { id: 'l1', name: 'CI watch', graph: { nodes: [], edges: [] } },
      { id: 'l2', name: 'Needs ticket', graph: { nodes: [{ id: 'n', type: 'prompt', data: { prompt: 'do {{spec.title}}' } }], edges: [] } },
    ]),
    runStandalone: vi.fn(async () => ({ loopRunId: 'run-9' })),
  },
}))

function mockFetch() {
  global.fetch = vi.fn().mockImplementation(() => Promise.resolve({ ok: true, json: async () => ({ commands: [], jobs: [] }) }))
}

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Meta>}k{/Meta}')
  return await screen.findByPlaceholderText(/search/i)
}

describe('CommandPalette actions (QW1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    resetPaletteSurfaces()
    undoLabel = null
    recentPlaces = []
    mockFetch()
  })
  afterEach(() => resetPaletteSurfaces())

  it('offers the hand-off actions only while the spec modal of the focused spec is open', async () => {
    const exportHandoff = vi.fn()
    const copyPrDescription = vi.fn()
    const user = userEvent.setup()
    // No surface: the actions are hidden even with a focused spec.
    const first = render(<CommandPalette />, { route: '/?spec=15' })
    let input = await openPalette(user)
    await user.type(input, 'hand-off')
    expect(screen.queryByTestId('palette-action-a-spec.exportHandoff')).not.toBeInTheDocument()
    first.unmount()

    registerPaletteSurface('handoff', { ticketId: () => 15, exportHandoff, copyPrDescription })
    render(<CommandPalette />, { route: '/?spec=15' })
    input = await openPalette(user)
    await user.type(input, 'hand-off')
    const row = await screen.findByTestId('palette-action-a-spec.exportHandoff')
    expect(row).toHaveTextContent('Export hand-off for #15')
    await user.click(row)
    expect(exportHandoff).toHaveBeenCalledWith(15)
    await waitFor(() => expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument())

    input = await openPalette(user)
    await user.type(input, 'pr description')
    const copy = await screen.findByTestId('palette-action-a-spec.copyPrDescription')
    expect(copy).toHaveTextContent('Copy PR description for #15')
    await user.click(copy)
    expect(copyPrDescription).toHaveBeenCalledWith(15)
  })

  it('hides the hand-off actions when the open modal belongs to another spec', async () => {
    registerPaletteSurface('handoff', { ticketId: () => 99, exportHandoff: vi.fn(), copyPrDescription: vi.fn() })
    const user = userEvent.setup()
    render(<CommandPalette />, { route: '/?spec=15' })
    const input = await openPalette(user)
    await user.type(input, 'hand-off')
    expect(screen.queryByTestId('palette-action-a-spec.exportHandoff')).not.toBeInTheDocument()
  })

  it('shows no Actions group for an empty query, and hints at >', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    await openPalette(user)
    expect(screen.queryByTestId('palette-group-actions')).not.toBeInTheDocument()
    expect(screen.getByText('actions')).toBeInTheDocument()
  })

  it('leads with Actions for a verb and runs the board handler (New spec, Explore)', async () => {
    const openNewSpec = vi.fn()
    registerPaletteSurface('specs', { openNewSpec })
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, 'new spec')
    const actions = await screen.findByTestId('palette-group-actions')
    const groups = Array.from(document.querySelectorAll('[cmdk-group]')).map((g) => g.getAttribute('data-testid'))
    expect(groups[0]).toBe('palette-group-actions')
    expect(actions).toHaveTextContent('New spec (Explore)')
    await user.click(screen.getByTestId('palette-action-a-spec.newExplore'))
    expect(openNewSpec).toHaveBeenCalledWith('explore')
    await waitFor(() => expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument())
  })

  it('keeps the existing groups first when the query is not action-like', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, 'alpha')
    await screen.findByTestId('palette-group-projects')
    expect(screen.queryByTestId('palette-group-actions')).not.toBeInTheDocument()
  })

  it('> shows only actions', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, '>')
    await screen.findByTestId('palette-group-actions')
    expect(screen.queryByTestId('palette-group-projects')).not.toBeInTheDocument()
  })

  it('shows each action shortcut', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, 'toggle')
    const row = await screen.findByTestId('palette-action-a-sidebar.left')
    expect(row).toHaveTextContent(/⌘B|Ctrl\+B/)
  })

  it('Launch: opens the rail page, Backspace on an empty query returns, disabled rails do nothing', async () => {
    const launchOnRail = vi.fn()
    registerPaletteSurface('board', {
      specs: () => [{ id: 15, title: 'Add achievements', status: 'todo' }],
      rails: () => [{ id: 'r1', label: 'Rail 1', running: false, hasSpec: false }, { id: 'r2', label: 'Rail 2', running: true, hasSpec: false }],
      launchBlocker: () => null,
      launchOnRail,
      statusOptions: async () => [],
      moveStatus: vi.fn(),
      reviewPath: () => null,
    })
    const user = userEvent.setup()
    render(<CommandPalette />, { route: '/?spec=15' })
    const input = await openPalette(user)
    await user.type(input, 'launch')
    await user.click(await screen.findByTestId('palette-action-a-spec.launch'))
    // second page, not a dialog
    expect(await screen.findByTestId('palette-page')).toHaveTextContent('Rail for #15')
    expect(screen.getByPlaceholderText('Pick a rail...')).toBeInTheDocument()
    // Backspace on the empty query goes back to the first page
    await user.keyboard('{Backspace}')
    await waitFor(() => expect(screen.queryByTestId('palette-page')).not.toBeInTheDocument())
    // again, then pick
    await user.type(screen.getByPlaceholderText(/search/i), 'launch')
    await user.click(await screen.findByTestId('palette-action-a-spec.launch'))
    await user.click(await screen.findByTestId('palette-option-rail-r2'))
    expect(launchOnRail).not.toHaveBeenCalled() // running rail is disabled
    await user.click(screen.getByTestId('palette-option-rail-r1'))
    expect(launchOnRail).toHaveBeenCalledWith(15, 'r1')
  })

  it('marks rows that open options with a chevron announced as "opens options", never a ▸ glyph', async () => {
    registerPaletteSurface('board', {
      specs: () => [{ id: 15, title: 'Add achievements', status: 'todo' }],
      rails: () => [{ id: 'r1', label: 'Rail 1', running: false, hasSpec: false }],
      launchBlocker: () => null,
      launchOnRail: vi.fn(),
      statusOptions: async () => [],
      moveStatus: vi.fn(),
      reviewPath: () => null,
    })
    const user = userEvent.setup()
    render(<CommandPalette />, { route: '/?spec=15' })
    const input = await openPalette(user)
    await user.type(input, 'launch')
    const row = await screen.findByTestId('palette-action-a-spec.launch')
    expect(row.textContent).not.toContain('▸')
    expect(row.querySelector('svg.lucide-chevron-right')).not.toBeNull()
    expect(row.querySelector('.sr-only')).toHaveTextContent('opens options')
    // Action icons stay quiet unless the row is selected.
    const icon = row.querySelector('svg')!
    expect(icon.getAttribute('class')).toContain('text-muted-foreground')
    expect(icon.getAttribute('class')).toContain('group-data-[selected=true]:text-accent-primary')
    expect(icon.getAttribute('class')).not.toMatch(/(^|\s)text-accent-primary(\s|$)/)
  })

  it('on an options page the footer teaches Backspace instead of ">", and the loading state is the rail track, not a spinner', async () => {
    let resolve!: (options: { id: string; label: string }[]) => void
    registerPaletteSurface('board', {
      specs: () => [{ id: 15, title: 'Add achievements', status: 'todo' }],
      rails: () => [],
      launchBlocker: () => null,
      launchOnRail: vi.fn(),
      statusOptions: () => new Promise((r) => { resolve = r }),
      moveStatus: vi.fn(),
      reviewPath: () => null,
    })
    const user = userEvent.setup()
    render(<CommandPalette />, { route: '/?spec=15' })
    const input = await openPalette(user)
    expect(screen.queryByTestId('palette-footer-back')).toBeNull()
    await user.type(input, 'move')
    await user.click(await screen.findByTestId('palette-action-a-spec.move'))
    const loading = await screen.findByTestId('palette-page-loading')
    expect(loading.querySelector('[data-testid="rail-track"]')).not.toBeNull()
    expect(loading.querySelector('.animate-spin')).toBeNull()
    expect(screen.getByTestId('palette-footer-back')).toHaveTextContent('back')
    expect(screen.queryByText('actions')).toBeNull()
    act(() => resolve([]))
  })

  it('Launch hides when the spec cannot launch (guard honoured)', async () => {
    registerPaletteSurface('board', {
      specs: () => [{ id: 15, title: 'Frozen', status: 'on_review' }],
      rails: () => [{ id: 'r1', label: 'Rail 1', running: false, hasSpec: false }],
      launchBlocker: () => 'On review',
      launchOnRail: vi.fn(), statusOptions: async () => [], moveStatus: vi.fn(), reviewPath: () => null,
    })
    const user = userEvent.setup()
    render(<CommandPalette />, { route: '/?spec=15' })
    const input = await openPalette(user)
    await user.type(input, 'launch')
    await waitFor(() => expect(screen.queryByTestId('palette-action-a-spec.launch')).not.toBeInTheDocument())
  })

  it('Move: picks a spec then loads the status page; the choice calls moveStatus', async () => {
    const moveStatus = vi.fn()
    registerPaletteSurface('board', {
      specs: () => [{ id: 15, title: 'Add achievements', status: 'todo' }],
      rails: () => [], launchBlocker: () => null, launchOnRail: vi.fn(),
      statusOptions: async () => [{ id: 'todo', label: 'To do', current: true }, { id: 'done', label: 'Done', current: false }],
      moveStatus, reviewPath: () => null,
    })
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, 'move')
    await user.click(await screen.findByTestId('palette-action-a-spec.move'))
    await user.click(await screen.findByTestId('palette-option-spec-15'))
    await user.click(await screen.findByTestId('palette-option-status-done'))
    expect(moveStatus).toHaveBeenCalledWith(15, 'done')
  })

  it('Flow actions run the strip controls and vanish when the strip is gone', async () => {
    const run = vi.fn()
    const unregister = registerPaletteSurface('flow', { controls: () => [{ id: 'pause', label: 'Pause', disabled: false, run }] })
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, 'pause')
    await user.click(await screen.findByTestId('palette-action-a-flow.pause'))
    expect(run).toHaveBeenCalled()
    act(() => unregister())
    await user.keyboard('{Meta>}k{/Meta}')
    await user.type(await screen.findByPlaceholderText(/search/i), 'pause')
    await waitFor(() => expect(screen.queryByTestId('palette-action-a-flow.pause')).not.toBeInTheDocument())
  })

  it('Switch theme opens the theme page and applies the pick', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, 'switch theme')
    await user.click(await screen.findByTestId('palette-action-a-theme.switch'))
    await user.click(await screen.findByTestId('palette-option-theme-dracula'))
    expect(mockSetTheme).toHaveBeenCalledWith('dracula')
  })

  it('Run loop lists only loops that need no spec, then runs and opens the job', async () => {
    const { loopsApi } = await import('../../features/loops/lib/loops-api')
    const user = userEvent.setup()
    render(<CommandPalette />)
    const input = await openPalette(user)
    await user.type(input, 'run loop')
    await user.click(await screen.findByTestId('palette-action-a-loop.run'))
    expect(await screen.findByTestId('palette-option-loop-l1')).toBeInTheDocument()
    expect(screen.queryByTestId('palette-option-loop-l2')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('palette-option-loop-l1'))
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/jobs/run-9'))
    expect(loopsApi.runStandalone).toHaveBeenCalledWith('p1', 'l1')
  })

  it('Undo last only shows when there is a live entry', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<CommandPalette />)
    let input = await openPalette(user)
    await user.type(input, 'undo')
    await waitFor(() => expect(screen.queryByTestId('palette-action-a-undo.last')).not.toBeInTheDocument())
    unmount()
    undoLabel = 'Spec #3 deleted'
    render(<CommandPalette />)
    input = await openPalette(user)
    await user.type(input, 'undo')
    const row = await screen.findByTestId('palette-action-a-undo.last')
    expect(row).toHaveTextContent('Undo: Spec #3 deleted')
    await user.click(row)
    expect(mockUndoLast).toHaveBeenCalled()
  })

  it('New mission starts a draft for the active project', async () => {
    const { UiModeProvider } = await import('../../context/UiModeContext')
    const user = userEvent.setup()
    render(<UiModeProvider initialMode="agent" persist={false}><CommandPalette /></UiModeProvider>)
    const input = await openPalette(user)
    await user.type(input, 'new mission')
    await user.click(await screen.findByTestId('palette-action-a-mission.new'))
    expect(mockStartNewConversation).toHaveBeenCalledWith('p1')
  })

  it('Open project settings: the sidebar modal in Mission mode, the /settings route on the board', async () => {
    const events: string[] = []
    const onEvent = (e: Event) => events.push((e as CustomEvent<{ section: string }>).detail.section)
    window.addEventListener('specrails:open-project-settings', onEvent)
    const user = userEvent.setup()
    render(<CommandPalette />)
    let input = await openPalette(user)
    await user.type(input, 'open project settings')
    await user.click(await screen.findByTestId('palette-action-a-settings.project'))
    await user.click(await screen.findByTestId('palette-option-section-budget'))
    expect(mockNavigate).toHaveBeenCalledWith('/settings')
    expect(events).toEqual([])
    window.removeEventListener('specrails:open-project-settings', onEvent)
    void input
  })

  describe('empty query', () => {
    it('lists recent actions (persisted, only the available ones) and re-runs them', async () => {
      window.localStorage.setItem(RECENT_ACTIONS_KEY, JSON.stringify(['sidebar.left', 'spec.new', 'history.back']))
      const user = userEvent.setup()
      render(<CommandPalette />)
      await openPalette(user)
      const group = await screen.findByTestId('palette-group-recent-actions')
      expect(group).toHaveTextContent('Collapse left sidebar')
      expect(group).toHaveTextContent('Go back')
      expect(group).not.toHaveTextContent('New spec') // not available here
      await user.click(screen.getByTestId('palette-action-r-history.back'))
      expect(mockPlaceBack).toHaveBeenCalled()
    })

    it('records the action it runs', async () => {
      const user = userEvent.setup()
      render(<CommandPalette />)
      const input = await openPalette(user)
      await user.type(input, 'go back')
      await user.click(await screen.findByTestId('palette-action-a-history.back'))
      expect(JSON.parse(window.localStorage.getItem(RECENT_ACTIONS_KEY) ?? '[]')).toEqual(['history.back'])
    })

    it('lists recent places and pushes the chosen one', async () => {
      recentPlaces = [
        { to: { pathname: '/', search: '?spec=15' }, label: 'Spec #15 · Add achievements', key: 'k|p1|/|s=15|o=' },
        { to: { pathname: '/jobs', search: '' }, label: 'Jobs', key: 'k|p1|/jobs|s=|o=' },
      ]
      const user = userEvent.setup()
      render(<CommandPalette />)
      await openPalette(user)
      const group = await screen.findByTestId('palette-group-recent-places')
      expect(group).toHaveTextContent('Jobs')
      await user.click(screen.getByText('Spec #15 · Add achievements'))
      expect(mockNavigate).toHaveBeenCalledWith({ pathname: '/', search: '?spec=15' })
    })

    it('opening the palette is never a place: it does not navigate', async () => {
      const user = userEvent.setup()
      render(<CommandPalette />)
      await openPalette(user)
      expect(mockNavigate).not.toHaveBeenCalled()
    })

    it('survives unavailable localStorage', async () => {
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
      const user = userEvent.setup()
      render(<CommandPalette />)
      await openPalette(user)
      expect(screen.queryByTestId('palette-group-recent-actions')).not.toBeInTheDocument()
      spy.mockRestore()
    })
  })
})
