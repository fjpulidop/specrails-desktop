import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '../../test-utils'
import { useLocation } from 'react-router-dom'
import { ArcSidebar } from '../ArcSidebar'
import type { DesktopProject } from '../../hooks/useDesktop'
import type { AgentConversation } from '../../features/missions/lib/agent-api'

const mockProjects: DesktopProject[] = [
  { id: 'proj-1', slug: 'proj-1', name: 'Project Alpha', path: '/alpha', db_path: '/alpha/.db', added_at: '', last_seen_at: '' },
]

const mockSetActiveProjectId = vi.fn()
vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: mockProjects,
    activeProjectId: 'proj-1',
    setActiveProjectId: mockSetActiveProjectId,
    removeProject: vi.fn(),
    isLoading: false,
    setupProjectIds: new Set(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
    addProject: vi.fn(),
  }),
}))


const mockToggleUiMode = vi.fn()
vi.mock('../../context/UiModeContext', () => ({
  useUiMode: () => ({ uiMode: 'agent', setUiMode: vi.fn(), toggleUiMode: mockToggleUiMode }),
}))

const toastMocks = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastMocks.error, success: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

function conv(id: string, title: string | null, pinned: string | null): AgentConversation {
  return {
    id, title, provider: 'claude', model: null, session_id: null,
    pinned_project_id: pinned, tier_level: 0, created_at: '', updated_at: '',
  }
}

const mockDeleteConversation = vi.fn((): Promise<void> => Promise.resolve())
const mockSelectConversation = vi.fn(() => Promise.resolve())
const mockToggleFavoriteConversation = vi.fn()

// Mutable so individual tests can activate a conversation / streaming state.
const agentChatState: {
  active: AgentConversation | null
  streamingIds: Set<string>
  unreadIds: Set<string>
  attentionIds: Set<string>
  attentionKinds: Map<string, 'decision' | 'failed'>
  favoriteIds: Set<string>
} = {
  active: null,
  streamingIds: new Set(),
  unreadIds: new Set(),
  attentionIds: new Set(),
  attentionKinds: new Map(),
  favoriteIds: new Set(),
}

vi.mock('../../features/missions/context/AgentChatContext', () => ({
  useAgentChat: () => ({
    conversations: [conv('c-1', 'Fix the build', 'proj-1'), conv('c-2', null, null)],
    active: agentChatState.active,
    isStreaming: agentChatState.active ? agentChatState.streamingIds.has(agentChatState.active.id) : false,
    streamingConversationIds: agentChatState.streamingIds,
    unreadConversationIds: agentChatState.unreadIds,
    attentionConversationIds: agentChatState.attentionIds,
    attentionKinds: agentChatState.attentionKinds,
    favoriteConversationIds: agentChatState.favoriteIds,
    selectConversation: mockSelectConversation,
    deleteConversation: mockDeleteConversation,
    toggleFavoriteConversation: mockToggleFavoriteConversation,
    startNewConversation: vi.fn(),
  }),
}))

const defaultProps = {
  onAddProject: vi.fn(),
  onOpenLoops: vi.fn(),
  onOpenAnalytics: vi.fn(),
  onOpenDocs: vi.fn(),
  onOpenSettings: vi.fn(),
}

function renderExpanded() {
  // New users start pinned open, so the tree labels render.
  render(<ArcSidebar {...defaultProps} />)
}

function renderCollapsed() {
  window.localStorage.setItem('specrails-desktop:sidebar-mode:left', 'pinned-collapsed')
  render(<ArcSidebar {...defaultProps} />)
}

beforeEach(() => {
  window.localStorage.clear()
  vi.clearAllMocks()
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

  it('shows a hover delete button per conversation row', () => {
    renderExpanded()
    expect(screen.getByRole('button', { name: 'Delete "Fix the build"' })).toBeInTheDocument()
  })

  it('first click arms confirm, second click deletes the conversation', () => {
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

  it('marks a mission in Flow with the extension’s icon and "In Flow"', async () => {
    const { MissionExtensionsProvider } = await import('../../features/missions/context/MissionExtensionsContext')
    const marks = new Map([['c-1', { label: 'In Flow', description: 'Flow mode' }]])
    render(<MissionExtensionsProvider value={{ useConversationMarks: () => marks }}><ArcSidebar {...defaultProps} /></MissionExtensionsProvider>)
    const row = screen.getAllByText('Fix the build')[0].closest('button') as HTMLElement
    expect(row.querySelector('[data-testid="mission-mode-row-mark"]')).toHaveTextContent('In Flow')
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
    expect(screen.getByRole('button', { name: 'Delete "Untitled"' })).toBeInTheDocument()
  })

  it('reports a failed delete with a toast', async () => {
    mockDeleteConversation.mockImplementationOnce(() => Promise.reject(new Error('offline')))
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
