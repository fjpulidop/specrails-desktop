import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '../../test-utils'
import { ArcSidebar } from '../ArcSidebar'
import type { DesktopProject } from '../../hooks/useDesktop'
import type { AgentConversation } from '../../lib/agent-api'

const mockProjects: DesktopProject[] = [
  { id: 'proj-1', slug: 'proj-1', name: 'Project Alpha', path: '/alpha', db_path: '/alpha/.db', added_at: '', last_seen_at: '' },
]

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: mockProjects,
    activeProjectId: 'proj-1',
    setActiveProjectId: vi.fn(),
    removeProject: vi.fn(),
    isLoading: false,
    setupProjectIds: new Set(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
    addProject: vi.fn(),
  }),
}))

vi.mock('../../context/UiModeContext', () => ({
  useUiMode: () => ({ uiMode: 'agent', setUiMode: vi.fn(), toggleUiMode: vi.fn() }),
}))

function conv(id: string, title: string | null, pinned: string | null): AgentConversation {
  return {
    id, title, provider: 'claude', model: null, session_id: null,
    pinned_project_id: pinned, tier_level: 0, created_at: '', updated_at: '',
  }
}

const mockDeleteConversation = vi.fn(() => Promise.resolve())
const mockSelectConversation = vi.fn(() => Promise.resolve())

// Mutable so individual tests can activate a conversation / streaming state.
const agentChatState: { active: AgentConversation | null; isStreaming: boolean } = {
  active: null,
  isStreaming: false,
}

vi.mock('../../context/AgentChatContext', () => ({
  useAgentChat: () => ({
    conversations: [conv('c-1', 'Fix the build', 'proj-1'), conv('c-2', null, null)],
    active: agentChatState.active,
    isStreaming: agentChatState.isStreaming,
    selectConversation: mockSelectConversation,
    deleteConversation: mockDeleteConversation,
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
  render(<ArcSidebar {...defaultProps} />)
  // unpinned → pinned-open so the tree labels render
  fireEvent.click(screen.getByRole('button', { name: /Pin left sidebar open/i }))
}

beforeEach(() => {
  window.localStorage.clear()
  vi.clearAllMocks()
  agentChatState.active = null
  agentChatState.isStreaming = false
})

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

  it('confirm state expires after 3 seconds without a second click', () => {
    vi.useFakeTimers()
    try {
      renderExpanded()
      fireEvent.click(screen.getByRole('button', { name: 'Delete "Fix the build"' }))
      expect(screen.getByRole('button', { name: 'Confirm delete "Fix the build"' })).toBeInTheDocument()
      act(() => { vi.advanceTimersByTime(3100) })
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

  it('untitled Home conversation gets a delete button labelled with the fallback title', () => {
    renderExpanded()
    // Home group renders null-pinned conversations behind its own toggle.
    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
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
    agentChatState.isStreaming = true
    renderExpanded()
    const overlay = document.querySelector('.title-shimmer')
    expect(overlay).toBeInTheDocument()
    expect(overlay?.textContent).toBe('Fix the build')
    expect(overlay?.className).toContain('opacity-100')
  })

  it('no shimmer overlay when idle', () => {
    agentChatState.active = conv('c-1', 'Fix the build', 'proj-1')
    agentChatState.isStreaming = false
    renderExpanded()
    expect(document.querySelector('.title-shimmer')).not.toBeInTheDocument()
  })
})
