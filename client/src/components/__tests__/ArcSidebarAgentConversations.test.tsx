import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '../../test-utils'
import { useLocation } from 'react-router-dom'
import { ArcSidebar } from '../ArcSidebar'
import type { DesktopProject } from '../../hooks/useDesktop'
import type { AgentConversation, ArchiveScope } from '../../features/missions/lib/agent-api'

const mockProjects: DesktopProject[] = [
  { id: 'proj-1', slug: 'proj-1', name: 'Project Alpha', path: '/alpha', db_path: '/alpha/.db', added_at: '', last_seen_at: '' },
  { id: 'proj-2', slug: 'proj-2', name: 'Project Beta', path: '/beta', db_path: '/beta/.db', added_at: '', last_seen_at: '' },
]

// Mutable so tests can move the active project the way a real switch would.
const desktopState = { activeProjectId: 'proj-1' }

const mockSetActiveProjectId = vi.fn()
vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: mockProjects,
    activeProjectId: desktopState.activeProjectId,
    setActiveProjectId: mockSetActiveProjectId,
    removeProject: vi.fn(),
    isLoading: false,
    setupProjectIds: new Set(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
    addProject: vi.fn(),
  }),
}))


let sidebarUiMode = 'agent'
const mockToggleUiMode = vi.fn()
vi.mock('../../context/UiModeContext', () => ({
  useUiMode: () => ({ uiMode: sidebarUiMode, setUiMode: vi.fn(), toggleUiMode: mockToggleUiMode }),
}))

const toastMocks = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastMocks.error, success: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

function conv(id: string, title: string | null, pinned: string | null): AgentConversation {
  return {
    id, title, provider: 'claude', model: null, session_id: null,
    pinned_project_id: pinned, archivedAt: agentChatState.archivedIds.has(id) ? 'stamp' : null, reasoning_effort: null, tier_level: 0, created_at: '', updated_at: '',
  }
}

const mockDeleteConversation = vi.fn((): Promise<void> => Promise.resolve())
const mockArchiveConversation = vi.fn(async (id: string) => { agentChatState.archivedIds.add(id) })
const mockUnarchiveConversation = vi.fn(async (id: string) => { agentChatState.archivedIds.delete(id) })
const mockSelectConversation = vi.fn(() => Promise.resolve())
const mockToggleFavoriteConversation = vi.fn()
const mockSetPinnedProject = vi.fn()

// Mutable so individual tests can activate a conversation / streaming state.
const agentChatState: {
  active: AgentConversation | null
  streamingIds: Set<string>
  unreadIds: Set<string>
  attentionIds: Set<string>
  attentionKinds: Map<string, 'decision' | 'failed'>
  archiveScope: ArchiveScope
  archivedIds: Set<string>
  loading: boolean
  empty: boolean
  favoriteIds: Set<string>
} = {
  active: null,
  streamingIds: new Set(),
  unreadIds: new Set(),
  attentionIds: new Set(),
  attentionKinds: new Map(),
  archiveScope: 'active', archivedIds: new Set(), loading: false, empty: false,
  favoriteIds: new Set(),
}

let useRealChat = false
vi.mock('../../features/missions/context/AgentChatContext', async (original) => {
  const actual = await original<typeof import('../../features/missions/context/AgentChatContext')>()
  return { ...actual, useAgentChat: () => useRealChat ? actual.useAgentChat() : ({
    archiveScope: agentChatState.archiveScope,
    setArchiveScope: mockSetArchiveScope,
    conversationsLoading: agentChatState.loading,
    conversations: agentChatState.empty ? [] : [
      conv('c-1', 'Fix the build', 'proj-1'),
      conv('c-2', null, null),
      conv('c-3', 'Beta mission', 'proj-2'),
      conv('c-4', 'Ghost mission', 'proj-gone'),
    ],
    active: agentChatState.active,
    isStreaming: agentChatState.active ? agentChatState.streamingIds.has(agentChatState.active.id) : false,
    streamingConversationIds: agentChatState.streamingIds,
    unreadConversationIds: agentChatState.unreadIds,
    attentionConversationIds: agentChatState.attentionIds,
    attentionKinds: agentChatState.attentionKinds,
    favoriteConversationIds: agentChatState.favoriteIds,
    selectConversation: mockSelectConversation,
    archiveConversation: mockArchiveConversation,
    unarchiveConversation: mockUnarchiveConversation,
    deleteConversation: mockDeleteConversation,
    toggleFavoriteConversation: mockToggleFavoriteConversation,
    startNewConversation: vi.fn(),
    setPinnedProject: mockSetPinnedProject,
  }) }
})

const mockSetArchiveScope = vi.fn((scope: ArchiveScope) => { agentChatState.archiveScope = scope })

const defaultProps = {
  onAddProject: vi.fn(),
  onOpenLoops: vi.fn(),
  onOpenAnalytics: vi.fn(),
  onOpenDocs: vi.fn(),
  onOpenSettings: vi.fn(),
}

function renderExpanded() {
  // New users start pinned open, so the tree labels render.
  return render(<ArcSidebar {...defaultProps} />)
}

function renderCollapsed() {
  window.localStorage.setItem('specrails-desktop:sidebar-mode:left', 'pinned-collapsed')
  return render(<ArcSidebar {...defaultProps} />)
}

beforeEach(() => {
  window.localStorage.clear()
  vi.clearAllMocks()
  useRealChat = false
  sidebarUiMode = 'agent'
  agentChatState.archiveScope = 'active'
  agentChatState.archivedIds = new Set()
  agentChatState.loading = false
  agentChatState.empty = false
  desktopState.activeProjectId = 'proj-1'
  agentChatState.active = null
  agentChatState.streamingIds = new Set()
  agentChatState.unreadIds = new Set()
  agentChatState.attentionIds = new Set()
  agentChatState.attentionKinds = new Map()
  agentChatState.favoriteIds = new Set()
})

function conversationIcon(title: string): SVGElement {
  const row = screen.getAllByText(title)[0].closest('button')
  const icon = row?.querySelector('svg')
  expect(icon).toBeInTheDocument()
  return icon as SVGElement
}

describe('ArcSidebar agent-mode conversation rows', () => {
  it('renders project-pinned conversations under the auto-expanded active project', () => {
    renderExpanded()
    expect(screen.getByText('Fix the build')).toBeInTheDocument()
  })

  it('[spec:mission-archive/mission-archive-row-actions] offers Archive without Delete on active rows', () => {
    renderExpanded()
    expect(screen.getByRole('button', { name: 'Archive "Fix the build"' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete "Fix the build"' })).not.toBeInTheDocument()
  })

  it('[spec:mission-archive/mission-archive-row-actions] first click arms confirm, second click deletes the conversation', () => {
    agentChatState.archiveScope = 'all'
    agentChatState.archivedIds.add('c-1')
    renderExpanded()
    fireEvent.click(screen.getByRole('button', { name: 'Delete "Fix the build"' }))
    expect(mockDeleteConversation).not.toHaveBeenCalled()
    const confirmBtn = screen.getByRole('button', { name: 'Confirm delete "Fix the build"' })
    fireEvent.click(confirmBtn)
    expect(mockDeleteConversation).toHaveBeenCalledWith('c-1')
    expect(mockSelectConversation).not.toHaveBeenCalled()
  })

  it('confirm state expires after 5 seconds without a second click', () => {
    vi.useFakeTimers()
    try {
      agentChatState.archiveScope = 'all'
      agentChatState.archivedIds.add('c-1')
      renderExpanded()
      fireEvent.click(screen.getByRole('button', { name: 'Delete "Fix the build"' }))
      expect(screen.getByRole('button', { name: 'Confirm delete "Fix the build"' })).toHaveTextContent('Delete?')
      act(() => { vi.advanceTimersByTime(3100) })
      expect(screen.getByRole('button', { name: 'Confirm delete "Fix the build"' })).toBeInTheDocument()
      act(() => { vi.advanceTimersByTime(2000) })
      expect(screen.queryByRole('button', { name: 'Confirm delete "Fix the build"' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Delete "Fix the build"' })).toBeInTheDocument()
      expect(mockDeleteConversation).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('delete click does not select the conversation (stopPropagation)', () => {
    agentChatState.archiveScope = 'all'
    agentChatState.archivedIds.add('c-1')
    renderExpanded()
    fireEvent.click(screen.getByRole('button', { name: 'Delete "Fix the build"' }))
    expect(mockSelectConversation).not.toHaveBeenCalled()
  })

  it('favorite heart toggles a project mission without selecting it', () => {
    renderExpanded()
    fireEvent.click(screen.getByRole('button', { name: 'Add "Fix the build" to favorites' }))
    expect(mockToggleFavoriteConversation).toHaveBeenCalledWith('c-1')
    expect(mockSelectConversation).not.toHaveBeenCalled()
  })

  it('renders favorite missions above projects and removes them from the project tree', () => {
    agentChatState.favoriteIds = new Set(['c-1'])
    renderExpanded()
    fireEvent.click(screen.getByRole('button', { name: 'Favorite missions' }))
    expect(screen.getByText('Favorite missions')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove "Fix the build" from favorites' })).toBeInTheDocument()
    expect(screen.getAllByText('Fix the build')).toHaveLength(1)
  })

  it('collapses favorite missions behind a single favorites icon when the sidebar is collapsed', () => {
    agentChatState.favoriteIds = new Set(['c-1'])
    renderCollapsed()
    const favoritesButton = screen.getByRole('button', { name: 'Favorite missions' })
    expect(favoritesButton).toBeInTheDocument()
    expect(favoritesButton.parentElement?.className).toContain('border-b')
    expect(screen.queryByText('Favorite missions')).not.toBeInTheDocument()
    expect(screen.queryByText('Fix the build')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove "Fix the build" from favorites' })).not.toBeInTheDocument()
  })

  it('favorite missions section expands and collapses like a project tree', () => {
    agentChatState.favoriteIds = new Set(['c-1'])
    renderExpanded()
    expect(screen.queryByRole('button', { name: 'Remove "Fix the build" from favorites' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Favorite missions' }))
    expect(screen.getByRole('button', { name: 'Remove "Fix the build" from favorites' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Favorite missions' }))
    expect(screen.queryByRole('button', { name: 'Remove "Fix the build" from favorites' })).not.toBeInTheDocument()
  })

  it('removing a favorite from the favorite section calls the same toggle', () => {
    agentChatState.favoriteIds = new Set(['c-1'])
    renderExpanded()
    fireEvent.click(screen.getByRole('button', { name: 'Favorite missions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove "Fix the build" from favorites' }))
    expect(mockToggleFavoriteConversation).toHaveBeenCalledWith('c-1')
  })

  it('untitled Home conversation gets a delete button labelled with the fallback title', () => {
    agentChatState.archiveScope = 'all'
    agentChatState.archivedIds.add('c-2')
    renderExpanded()
    // Home group renders null-pinned conversations behind its own toggle.
    fireEvent.click(screen.getByRole('button', { name: 'Unassigned missions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete "Untitled"' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete "Untitled"' }))
    expect(mockDeleteConversation).toHaveBeenCalledWith('c-2')
  })

  it('clicking the row itself selects the conversation', () => {
    renderExpanded()
    fireEvent.click(screen.getByText('Fix the build'))
    expect(mockSelectConversation).toHaveBeenCalledWith('c-1')
  })

  describe('selecting a mission follows its pinned project', () => {
    const openBetaMission = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand Project Beta' }))
      return screen.getByText('Beta mission')
    }

    it('[spec:mission-project-follow/selecting-a-mission-activates-its-pinned-project] switches the active project to the mission\'s pinned project and selects it', () => {
      renderExpanded()
      fireEvent.click(openBetaMission())
      expect(mockSetActiveProjectId).toHaveBeenCalledWith('proj-2')
      expect(mockSelectConversation).toHaveBeenCalledWith('c-3')
    })

    it('[spec:mission-project-follow/selection-leaves-the-project-unchanged-when-there-is-nothing-to-switch-to] does not switch for a mission of the already-active project', () => {
      renderExpanded()
      fireEvent.click(screen.getByText('Fix the build'))
      expect(mockSetActiveProjectId).not.toHaveBeenCalled()
      expect(mockSelectConversation).toHaveBeenCalledWith('c-1')
    })

    it('[spec:mission-project-follow/selection-leaves-the-project-unchanged-when-there-is-nothing-to-switch-to] does not switch for a Home mission and still opens it', () => {
      renderExpanded()
      fireEvent.click(screen.getByRole('button', { name: 'Unassigned missions' }))
      fireEvent.click(screen.getByText('Untitled'))
      expect(mockSetActiveProjectId).not.toHaveBeenCalled()
      expect(mockSelectConversation).toHaveBeenCalledWith('c-2')
    })

    it('[spec:mission-project-follow/selection-leaves-the-project-unchanged-when-there-is-nothing-to-switch-to] does not switch for an unregistered project and still opens the mission', () => {
      renderExpanded()
      fireEvent.click(screen.getByRole('button', { name: 'Unassigned missions' }))
      fireEvent.click(screen.getByText('Ghost mission'))
      expect(mockSetActiveProjectId).not.toHaveBeenCalled()
      expect(mockSelectConversation).toHaveBeenCalledWith('c-4')
    })

    it('[spec:mission-project-follow/selecting-a-mission-activates-its-pinned-project] ends on the last selected mission\'s project for rapid A to B to A selections', () => {
      const view = render(<ArcSidebar {...defaultProps} />)
      fireEvent.click(openBetaMission())
      desktopState.activeProjectId = 'proj-2'
      view.rerender(<ArcSidebar {...defaultProps} />)
      fireEvent.click(screen.getByText('Fix the build'))
      expect(mockSetActiveProjectId.mock.calls).toEqual([['proj-2'], ['proj-1']])
    })

    it('[spec:mission-project-follow/the-switch-never-alters-pins-or-user-work] never rewrites a mission pin', () => {
      renderExpanded()
      fireEvent.click(openBetaMission())
      expect(mockSetPinnedProject).not.toHaveBeenCalled()
    })
  })

  it('sweeps the title shimmer while the active conversation streams', () => {
    agentChatState.active = conv('c-1', 'Fix the build', 'proj-1')
    agentChatState.streamingIds = new Set(['c-1'])
    renderExpanded()
    const overlay = document.querySelector('.title-shimmer')
    expect(overlay).toBeInTheDocument()
    expect(overlay?.textContent).toBe('Fix the build')
    expect(overlay?.className).toContain('opacity-100')
  })

  it('keeps the shimmer on a BACKGROUND conversation that is still streaming', () => {
    // Focus moved to c-2 (Home) while c-1's agent keeps working — the c-1 row
    // must keep its luminous working cue.
    agentChatState.active = conv('c-2', null, null)
    agentChatState.streamingIds = new Set(['c-1'])
    renderExpanded()
    const overlay = document.querySelector('.title-shimmer')
    expect(overlay).toBeInTheDocument()
    expect(overlay?.textContent).toBe('Fix the build')
    expect(overlay?.className).toContain('opacity-100')
  })

  it('marks a mission waiting for the person’s decision with a dot AND words (not color alone)', () => {
    agentChatState.attentionIds = new Set(['c-1'])
    renderExpanded()
    const row = screen.getAllByText('Fix the build')[0].closest('button') as HTMLElement
    const mark = row.querySelector('[data-testid="mission-attention-mark"]') as HTMLElement
    expect(mark).toBeInTheDocument()
    expect(mark).toHaveAttribute('title', 'Waiting for your decision')
    expect(mark).toHaveTextContent('Waiting for your decision')
    expect(document.querySelectorAll('[data-testid="mission-attention-mark"]')).toHaveLength(1)
  })

  it('tells a failed run apart from a waiting decision, in words', () => {
    agentChatState.attentionIds = new Set(['c-1'])
    agentChatState.attentionKinds = new Map([['c-1', 'failed']])
    renderExpanded()
    const mark = document.querySelector('[data-testid="mission-attention-mark"]') as HTMLElement
    expect(mark).toHaveAttribute('data-kind', 'failed')
    expect(mark).toHaveAttribute('title', 'Needs attention: a run failed')
    expect(mark).toHaveTextContent('Needs attention: a run failed')
    expect(mark).not.toHaveTextContent('Waiting for your decision')
  })

  it('marks a mission in Intent with the extension’s icon and "In Intent"', async () => {
    const { MissionExtensionsProvider } = await import('../../features/missions/context/MissionExtensionsContext')
    const marks = new Map([['c-1', { label: 'In Intent', description: 'Intent mode' }]])
    render(<MissionExtensionsProvider value={{ useConversationMarks: () => marks }}><ArcSidebar {...defaultProps} /></MissionExtensionsProvider>)
    const row = screen.getAllByText('Fix the build')[0].closest('button') as HTMLElement
    expect(row.querySelector('[data-testid="mission-mode-row-mark"]')).toHaveTextContent('In Intent')
  })

  it('marks unread background conversations calmly: accent icon, dot and words', () => {
    agentChatState.active = conv('c-2', null, null)
    agentChatState.unreadIds = new Set(['c-1'])
    renderExpanded()
    const icon = conversationIcon('Fix the build')
    expect(icon.className.baseVal).not.toContain('text-destructive')
    expect(icon.className.baseVal).toContain('conversation-unread-glow')
    const row = screen.getAllByText('Fix the build')[0].closest('button') as HTMLElement
    expect(row.querySelector('[data-testid="conversation-unread-dot"]')).toBeInTheDocument()
    expect(row).toHaveTextContent('Unread')
    expect(screen.getAllByText('Fix the build')[0].className).toContain('font-medium')
  })

  it('keeps the streaming title shimmer when a row is also unread', () => {
    agentChatState.active = conv('c-2', null, null)
    agentChatState.streamingIds = new Set(['c-1'])
    agentChatState.unreadIds = new Set(['c-1'])
    renderExpanded()
    const icon = conversationIcon('Fix the build')
    const overlay = document.querySelector('.title-shimmer')
    expect(icon.className.baseVal).toContain('conversation-unread-glow')
    expect(icon.className.baseVal).not.toContain('animate-pulse')
    expect(overlay).toBeInTheDocument()
    expect(overlay?.textContent).toBe('Fix the build')
    expect(overlay?.className).toContain('opacity-100')
  })

  it('hover gear opens the project settings ROUTE (one container, not a modal twin) and selects the project', async () => {
    function Where() { return <span data-testid="where">{useLocation().pathname}</span> }
    render(<><ArcSidebar {...defaultProps} /><Where /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Settings for Project Alpha' }))
    expect(mockSetActiveProjectId).toHaveBeenCalledWith('proj-1')
    expect(screen.getByTestId('where')).toHaveTextContent('/settings')
    expect(screen.queryByTestId('project-settings-dialog')).toBeNull()
    // The gear never selects the row itself.
    expect(mockSelectConversation).not.toHaveBeenCalled()
  })

  it('no shimmer overlay when idle', () => {
    agentChatState.active = conv('c-1', 'Fix the build', 'proj-1')
    agentChatState.streamingIds = new Set()
    renderExpanded()
    expect(document.querySelector('.title-shimmer')).not.toBeInTheDocument()
  })

  it('conversation rows are real buttons with the actions as siblings (no nested controls)', () => {
    renderExpanded()
    const row = screen.getAllByText('Fix the build')[0].closest('button') as HTMLElement
    expect(row.querySelector('button')).toBeNull()
    expect(document.querySelector('[role="button"]')).toBeNull()
  })

  it('rolls a waiting mission up to its project row while the tree is closed', () => {
    agentChatState.attentionIds = new Set(['c-1'])
    agentChatState.attentionKinds = new Map([['c-1', 'failed']])
    renderExpanded()
    // Close the auto-expanded tree.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Project Alpha' }))
    const projectRow = screen.getByText('Project Alpha').closest('button') as HTMLElement
    const mark = projectRow.querySelector('[data-testid="mission-attention-mark"]') as HTMLElement
    expect(mark).toHaveAttribute('data-kind', 'failed')
    expect(screen.queryByText('Fix the build')).not.toBeInTheDocument()
  })

  it('shows the rolled-up attention as a badge on the collapsed rail', () => {
    agentChatState.attentionIds = new Set(['c-1'])
    renderCollapsed()
    expect(screen.getByTestId('project-attention-badge')).toBeInTheDocument()
  })

  it('opening Unassigned missions from the collapsed rail pins the sidebar open on that group', () => {
    renderCollapsed()
    fireEvent.click(screen.getByRole('button', { name: 'Unassigned missions' }))
    expect(window.localStorage.getItem('specrails-desktop:sidebar-mode:left')).toBe('pinned-open')
    expect(screen.getByRole('button', { name: 'Archive "Untitled"' })).toBeInTheDocument()
  })

  it('reports a failed delete with a toast', async () => {
    mockDeleteConversation.mockImplementationOnce(() => Promise.reject(new Error('offline')))
    agentChatState.archiveScope = 'all'
    agentChatState.archivedIds.add('c-1')
    renderExpanded()
    fireEvent.click(screen.getByRole('button', { name: 'Delete "Fix the build"' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete "Fix the build"' }))
    await act(async () => { await Promise.resolve() })
    expect(toastMocks.error).toHaveBeenCalledWith("Couldn't delete the mission. Try again.")
  })

  it('names the current mode in a labelled segmented control', () => {
    renderExpanded()
    const group = screen.getByRole('radiogroup', { name: 'Interface mode' })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Mission' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Mission' }))
    expect(mockToggleUiMode).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'Board' }))
    expect(mockToggleUiMode).toHaveBeenCalledOnce()
  })

  it('arrow keys move focus to the other radio at once (no waiting for the transition)', () => {
    renderExpanded()
    const mission = screen.getByRole('radio', { name: 'Mission' })
    const board = screen.getByRole('radio', { name: 'Board' })
    mission.focus()
    fireEvent.keyDown(mission, { key: 'ArrowRight' })
    expect(mockToggleUiMode).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(board)
  })

  it('shows the current mode as one icon button on the collapsed rail', () => {
    renderCollapsed()
    expect(screen.getByRole('button', { name: 'Current mode: Mission. Click to switch.' })).toBeInTheDocument()
  })
})

describe('ArcSidebar active-missions filter', () => {
  const ACTIVE_ONLY_KEY = 'specrails-desktop:agentActiveOnly'
  const filterButton = () => screen.getByRole('button', { name: 'Show only active missions' })

  it('[spec:mission-sidebar-active-filter/active-missions-toggle] offers an unpressed filter toggle in the expanded sidebar', () => {
    renderExpanded()
    expect(filterButton()).toHaveAttribute('aria-pressed', 'false')
    expect(filterButton()).toHaveAttribute('title', 'Show only active missions')
  })

  it('[spec:mission-sidebar-active-filter/active-missions-toggle] does not render the toggle on the collapsed rail', () => {
    renderCollapsed()
    expect(screen.queryByRole('button', { name: 'Show only active missions' })).not.toBeInTheDocument()
  })

  it('[spec:mission-sidebar-active-filter/toggle-state-is-exposed] reports the pressed state', () => {
    renderExpanded()
    fireEvent.click(filterButton())
    expect(filterButton()).toHaveAttribute('aria-pressed', 'true')
  })

  it('[spec:mission-sidebar-active-filter/filter-limits-missions-to-live-ones] shows only live missions across Home and project groups when on', () => {
    agentChatState.streamingIds = new Set(['c-1'])
    renderExpanded()
    fireEvent.click(filterButton())
    expect(screen.getAllByText('Fix the build').length).toBeGreaterThan(0)
    expect(screen.queryByText('Unassigned missions')).not.toBeInTheDocument()
  })

  it('[spec:mission-sidebar-active-filter/filter-limits-missions-to-live-ones] keeps a live favorite and drops a non-live one', () => {
    agentChatState.favoriteIds = new Set(['c-1', 'c-2'])
    agentChatState.streamingIds = new Set(['c-1'])
    window.localStorage.setItem(ACTIVE_ONLY_KEY, 'true')
    renderExpanded()
    fireEvent.click(screen.getByRole('button', { name: 'Favorite missions' }))
    expect(screen.getAllByText('Fix the build').length).toBeGreaterThan(0)
    expect(screen.queryByText('Untitled')).not.toBeInTheDocument()
  })

  it('[spec:mission-sidebar-active-filter/filter-limits-missions-to-live-ones] hides the favorites group when no favorite is live', () => {
    agentChatState.favoriteIds = new Set(['c-1'])
    agentChatState.streamingIds = new Set(['c-2'])
    window.localStorage.setItem(ACTIVE_ONLY_KEY, 'true')
    renderExpanded()
    expect(screen.queryByText('Favorite missions')).not.toBeInTheDocument()
  })

  it('[spec:mission-sidebar-active-filter/filter-limits-missions-to-live-ones] lists every mission again when turned off', () => {
    agentChatState.streamingIds = new Set(['c-1'])
    renderExpanded()
    fireEvent.click(filterButton())
    fireEvent.click(filterButton())
    expect(filterButton()).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Unassigned missions')).toBeInTheDocument()
    expect(screen.getAllByText('Fix the build').length).toBeGreaterThan(0)
  })

  it('[spec:mission-sidebar-active-filter/open-mission-stays-visible] keeps the open mission visible even when it is not live', () => {
    agentChatState.active = conv('c-1', 'Fix the build', 'proj-1')
    window.localStorage.setItem(ACTIVE_ONLY_KEY, 'true')
    renderExpanded()
    expect(screen.getByText('Fix the build')).toBeInTheDocument()
    expect(screen.queryByText('No active missions')).not.toBeInTheDocument()
  })

  it('[spec:mission-sidebar-active-filter/empty-groups-and-empty-state] shows the empty state when nothing is live', () => {
    window.localStorage.setItem(ACTIVE_ONLY_KEY, 'true')
    renderExpanded()
    expect(screen.getByText('No active missions')).toBeInTheDocument()
  })

  it('[spec:mission-sidebar-active-filter/live-updates-without-reload] drops a mission that stops being live without a reload', () => {
    agentChatState.streamingIds = new Set(['c-1'])
    window.localStorage.setItem(ACTIVE_ONLY_KEY, 'true')
    const { rerender } = render(<ArcSidebar {...defaultProps} />)
    expect(screen.getAllByText('Fix the build').length).toBeGreaterThan(0)
    agentChatState.streamingIds = new Set()
    rerender(<ArcSidebar {...defaultProps} />)
    expect(screen.queryByText('Fix the build')).not.toBeInTheDocument()
  })

  it('[spec:mission-sidebar-active-filter/live-updates-without-reload] shows a mission that starts streaming without a reload', () => {
    window.localStorage.setItem(ACTIVE_ONLY_KEY, 'true')
    const { rerender } = render(<ArcSidebar {...defaultProps} />)
    expect(screen.queryByText('Fix the build')).not.toBeInTheDocument()
    expect(screen.getByText('No active missions')).toBeInTheDocument()
    agentChatState.streamingIds = new Set(['c-1'])
    rerender(<ArcSidebar {...defaultProps} />)
    expect(screen.getAllByText('Fix the build').length).toBeGreaterThan(0)
    expect(screen.queryByText('No active missions')).not.toBeInTheDocument()
  })

  it('[spec:mission-sidebar-active-filter/toggle-state-is-exposed] is a focusable native button whose click toggles the state', () => {
    renderExpanded()
    const button = filterButton()
    expect(button.tagName).toBe('BUTTON')
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'true')
  })

  it('[spec:mission-sidebar-active-filter/filter-state-persists] persists the state and restores it after an unmount and remount', () => {
    const first = render(<ArcSidebar {...defaultProps} />)
    fireEvent.click(filterButton())
    expect(window.localStorage.getItem(ACTIVE_ONLY_KEY)).toBe('true')
    first.unmount()
    render(<ArcSidebar {...defaultProps} />)
    expect(filterButton()).toHaveAttribute('aria-pressed', 'true')
  })

  it('[spec:mission-sidebar-active-filter/filter-state-persists] falls back to off for a corrupt stored value', () => {
    window.localStorage.setItem(ACTIVE_ONLY_KEY, '{oops')
    renderExpanded()
    expect(filterButton()).toHaveAttribute('aria-pressed', 'false')
  })

  it('[spec:mission-sidebar-active-filter/live-updates-without-reload] keeps filtering on the collapsed rail (a waiting, non-live mission no longer rolls up)', () => {
    agentChatState.attentionIds = new Set(['c-1'])
    agentChatState.attentionKinds = new Map([['c-1', 'failed']])
    window.localStorage.setItem(ACTIVE_ONLY_KEY, 'true')
    renderCollapsed()
    expect(screen.queryByTestId('project-attention-badge')).not.toBeInTheDocument()
  })

  it('[spec:mission-sidebar-active-filter/live-updates-without-reload] the collapsed rail shows the waiting mission when the filter is off', () => {
    agentChatState.attentionIds = new Set(['c-1'])
    agentChatState.attentionKinds = new Map([['c-1', 'failed']])
    renderCollapsed()
    expect(screen.getByTestId('project-attention-badge')).toBeInTheDocument()
  })
})

describe('sidebar archive scopes', () => {
  it('[spec:mission-archive/sidebar-archive-selector] offers accessible Active, Archived and All beside Projects in expanded Mission mode', () => {
    renderExpanded()
    const selector = screen.getByRole('combobox', { name: 'Mission archive scope' })
    expect(selector).toHaveValue('active')
    expect([...selector.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['Active', 'Archived', 'All'])
    expect(selector.parentElement?.parentElement).toHaveTextContent('Projects')
  })

  it('scopes project, Home and favorite groups before the open-row exception', () => {
    agentChatState.archivedIds = new Set(['c-1', 'c-2'])
    agentChatState.active = conv('c-1', 'Fix the build', 'proj-1')
    agentChatState.favoriteIds = new Set(['c-1'])
    localStorage.setItem('specrails-desktop:agentTreeExpanded', JSON.stringify(['__favorites__', '__home__', 'proj-2']))
    const view = renderExpanded()
    expect(screen.queryByText('Fix the build')).not.toBeInTheDocument()
    expect(screen.queryByText('Untitled')).not.toBeInTheDocument()
    expect(screen.getByText('Beta mission')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'archived' } })
    view.rerender(<ArcSidebar {...defaultProps} />)
    expect(mockSetArchiveScope).toHaveBeenCalledWith('archived')
    expect(screen.getByText('Fix the build')).toBeInTheDocument()
    expect(screen.getByText('Untitled')).toBeInTheDocument()
    expect(screen.queryByText('Beta mission')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'all' } })
    view.rerender(<ArcSidebar {...defaultProps} />)
    expect(screen.getByText('Beta mission')).toBeInTheDocument()
    expect(screen.getAllByText('Archived')).toHaveLength(3)
  })

  it.each(['active', 'archived', 'all'] as const)('shows the empty %s state', (scope) => {
    agentChatState.archiveScope = scope
    agentChatState.empty = true
    renderExpanded()
    expect(screen.getByText(scope === 'active' ? 'No active missions' : scope === 'archived' ? 'No archived missions' : 'No missions')).toBeInTheDocument()
  })

  it('shows loading instead of a false empty state', () => {
    agentChatState.archiveScope = 'archived'
    agentChatState.empty = true
    agentChatState.loading = true
    renderExpanded()
    expect(screen.getByRole('status')).toHaveTextContent('Loading missions…')
    expect(screen.queryByText('No archived missions')).not.toBeInTheDocument()
  })

  it.each(['scope-first', 'live-first'])('combines archive scope and live-only independently (%s)', (order) => {
    agentChatState.archivedIds = new Set(['c-1', 'c-2'])
    agentChatState.streamingIds = new Set(['c-1'])
    localStorage.setItem('specrails-desktop:agentTreeExpanded', JSON.stringify(['__home__']))
    const view = renderExpanded()
    const scope = () => { fireEvent.change(screen.getByRole('combobox'), { target: { value: 'archived' } }); view.rerender(<ArcSidebar {...defaultProps} />) }
    const live = () => fireEvent.click(screen.getByRole('button', { name: 'Show only active missions' }))
    if (order === 'scope-first') { scope(); live() } else { live(); scope() }
    expect(screen.getByRole('combobox')).toHaveValue('archived')
    expect(screen.getByRole('button', { name: 'Show only active missions' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByText('Fix the build')).toHaveLength(2)
    expect(screen.queryByText('Untitled')).not.toBeInTheDocument()
    live()
    expect(screen.getByRole('combobox')).toHaveValue('archived')
    expect(screen.getByText('Untitled')).toBeInTheDocument()
  })

  it('hides scope selection in collapsed and Board modes', () => {
    const view = renderCollapsed()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    view.unmount()
    localStorage.clear()
    sidebarUiMode = 'kanban'
    renderExpanded()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})

vi.mock('../../hooks/useSharedWebSocket', async (original) => ({
  ...await original<typeof import('../../hooks/useSharedWebSocket')>(),
  useSharedWebSocket: () => ({ registerHandler: () => {}, unregisterHandler: () => {}, connectionStatus: 'connected' }),
}))
vi.mock('../../features/missions/lib/agent-api', async (original) => ({
  ...await original<typeof import('../../features/missions/lib/agent-api')>(),
  listAgentConversations: vi.fn(async () => []),
  getMcpStatus: vi.fn(async () => ({ enabled: true, running: true })),
  getAvailableProviders: vi.fn(async () => ({ any: true, installed: [] })),
  getAgentActiveTurns: vi.fn(async () => ({ snapshotVersion: 1, capturedAt: '', turns: [] })),
}))
import { AgentChatProvider } from '../../features/missions/context/AgentChatContext'

it('restores sidebar scope across real-provider remounts', async () => {
  useRealChat = true
  const first = render(<AgentChatProvider><ArcSidebar {...defaultProps} /></AgentChatProvider>)
  expect(screen.getByRole('combobox', { name: 'Mission archive scope' })).toHaveValue('active')
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'archived' } })
  await waitFor(() => expect(screen.getByText('No archived missions')).toBeInTheDocument())
  expect(localStorage.getItem('specrails-desktop:missionArchiveScope')).toBe('archived')
  first.unmount()
  render(<AgentChatProvider><ArcSidebar {...defaultProps} /></AgentChatProvider>)
  expect(screen.getByRole('combobox')).toHaveValue('archived')
  await waitFor(() => expect(screen.getByText('No archived missions')).toBeInTheDocument())
})

vi.mock('../../features/missions/hooks/useAgentLive', async (original) => {
  const actual = await original<typeof import('../../features/missions/hooks/useAgentLive')>()
  return { ...actual, useStreamingConversationIds: () => useRealChat ? actual.useStreamingConversationIds() : agentChatState.streamingIds }
})

describe('sidebar archive actions', () => {
  it.each(['project', 'favorite', 'home'])('[spec:mission-archive/mission-archive-row-actions] archives from the %s group without selecting', async (group) => {
    if (group === 'favorite') agentChatState.favoriteIds.add('c-1')
    localStorage.setItem('specrails-desktop:agentTreeExpanded', JSON.stringify(['__favorites__', '__home__']))
    renderExpanded()
    const id = group === 'home' ? 'c-2' : 'c-1'
    const label = group === 'home' ? 'Untitled' : 'Fix the build'
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Archive "${label}"` })) })
    expect(mockArchiveConversation).toHaveBeenCalledWith(id)
    expect(mockSelectConversation).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: `Archive "${label}"` })).not.toBeInTheDocument()
    expect(mockDeleteConversation).not.toHaveBeenCalled()
  })

  it('[spec:mission-archive/mission-archive-row-actions] restores archived rows to Active and keeps favorite membership', async () => {
    agentChatState.archiveScope = 'archived'
    agentChatState.archivedIds.add('c-1')
    agentChatState.favoriteIds.add('c-1')
    localStorage.setItem('specrails-desktop:agentTreeExpanded', JSON.stringify(['__favorites__']))
    const view = renderExpanded()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore "Fix the build"' })) })
    expect(mockUnarchiveConversation).toHaveBeenCalledWith('c-1')
    expect(screen.queryByText('Fix the build')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'active' } })
    view.rerender(<ArcSidebar {...defaultProps} />)
    expect(screen.getByText('Fix the build')).toBeInTheDocument()
    expect(agentChatState.favoriteIds.has('c-1')).toBe(true)
  })

  it('[spec:mission-archive/mission-archive-row-actions] delegates open-mission selection to the archive context action', async () => {
    agentChatState.active = conv('c-1', 'Fix the build', 'proj-1')
    renderExpanded()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archive "Fix the build"' })) })
    expect(mockArchiveConversation).toHaveBeenCalledWith('c-1')
    expect(mockSelectConversation).not.toHaveBeenCalled()
  })

  it.each([
    ['MISSION_LIVE', 'Wait for this mission to finish its work before archiving.'],
    ['network', 'Couldn’t archive the mission'],
  ])('shows %s errors without removing rows', async (code, message) => {
    mockArchiveConversation.mockRejectedValueOnce(Object.assign(new Error('refused'), { code }))
    renderExpanded()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archive "Fix the build"' })) })
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(screen.getByText('Fix the build')).toBeInTheDocument()
    expect(mockSelectConversation).not.toHaveBeenCalled()
  })

  it('disables duplicate pending actions', async () => {
    let finish!: () => void
    mockArchiveConversation.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve }))
    renderExpanded()
    const button = screen.getByRole('button', { name: 'Archive "Fix the build"' })
    fireEvent.click(button)
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(mockArchiveConversation).toHaveBeenCalledOnce()
    await act(async () => { finish() })
    expect(button).not.toBeDisabled()
  })
})
