import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const renameConversation = vi.fn(async () => {})
const deleteConversation = vi.fn(async () => {})
const startNewConversation = vi.fn()
const toggleFavoriteConversation = vi.fn()
let active: { id: string; title: string | null; pinned_project_id: string | null } | null = {
  id: 'conv-1', title: 'Greeting And Friendly Introduction', pinned_project_id: 'p1',
}
let favoriteConversationIds = new Set<string>()
vi.mock('../../../context/AgentChatContext', () => ({
  useAgentChat: () => ({
    active,
    renameConversation,
    deleteConversation,
    startNewConversation,
    favoriteConversationIds,
    toggleFavoriteConversation,
  }),
}))
vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects: [{ id: 'p1', slug: 'outrun', name: 'outrun', path: '/Users/javi/repos/outrun' }] }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { AgentConversationHeader } from '../AgentConversationHeader'

const writeText = vi.fn(async () => {})
beforeEach(() => {
  vi.clearAllMocks()
  active = { id: 'conv-1', title: 'Greeting And Friendly Introduction', pinned_project_id: 'p1' }
  favoriteConversationIds = new Set()
  Object.assign(navigator, { clipboard: { writeText } })
})

describe('AgentConversationHeader', () => {
  it('renders the breadcrumb: project path / conversation title', () => {
    render(<AgentConversationHeader />)
    expect(screen.getByText('/Users/javi/repos/outrun')).toBeInTheDocument()
    expect(screen.getByText('Greeting And Friendly Introduction')).toBeInTheDocument()
  })

  it('renders nothing when there is no active conversation', () => {
    active = null
    const { container } = render(<AgentConversationHeader />)
    expect(container.firstChild).toBeNull()
  })

  it('opens the ⋮ menu with Rename + copy items', () => {
    render(<AgentConversationHeader />)
    expect(screen.queryByTestId('agent-conv-menu')).toBeNull()
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    expect(screen.getByTestId('agent-conv-menu')).toBeInTheDocument()
    expect(screen.getByTestId('agent-conv-rename')).toBeInTheDocument()
    expect(screen.getByTestId('agent-conv-favorite')).toHaveTextContent('Add to favorites')
    expect(screen.getByTestId('agent-conv-copy-name')).toBeInTheDocument()
    expect(screen.getByTestId('agent-conv-copy-id')).toBeInTheDocument()
    expect(screen.getByTestId('agent-conv-copy-project')).toBeInTheDocument()
    expect(screen.getByTestId('agent-conv-copy-path')).toBeInTheDocument()
  })

  it('Rename → inline input → Enter commits via renameConversation', async () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    fireEvent.click(screen.getByTestId('agent-conv-rename'))
    const input = screen.getByPlaceholderText(/mission name/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Deploy checklist' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(renameConversation).toHaveBeenCalledWith('conv-1', 'Deploy checklist'))
  })

  it('Escape in the rename input cancels without renaming', () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    fireEvent.click(screen.getByTestId('agent-conv-rename'))
    const input = screen.getByPlaceholderText(/mission name/i)
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(renameConversation).not.toHaveBeenCalled()
  })

  it('Copy Conversation ID writes the id to the clipboard', async () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    fireEvent.click(screen.getByTestId('agent-conv-copy-id'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('conv-1'))
  })

  it('Copy project path writes the absolute path', async () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    fireEvent.click(screen.getByTestId('agent-conv-copy-path'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/Users/javi/repos/outrun'))
  })

  it('Add to favorites toggles the active mission favorite state', () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    fireEvent.click(screen.getByTestId('agent-conv-favorite'))
    expect(toggleFavoriteConversation).toHaveBeenCalledWith('conv-1')
  })

  it('shows Remove from favorites when the active mission is already favorited', () => {
    favoriteConversationIds = new Set(['conv-1'])
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    expect(screen.getByTestId('agent-conv-favorite')).toHaveTextContent('Remove from favorites')
    fireEvent.click(screen.getByTestId('agent-conv-favorite'))
    expect(toggleFavoriteConversation).toHaveBeenCalledWith('conv-1')
  })
})

describe('AgentConversationHeader — delete mission', () => {
  it('shows Delete mission below Rename, confirms inline, deletes + returns to New Mission', async () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    const del = screen.getByTestId('agent-conv-delete')
    expect(del).toBeInTheDocument()
    // Clicking Delete does NOT delete immediately — it asks for confirmation.
    fireEvent.click(del)
    expect(deleteConversation).not.toHaveBeenCalled()
    expect(screen.getByTestId('agent-conv-delete-confirm')).toBeInTheDocument()
    // Confirm → delete + jump back to the "+ New Mission" screen (pinned project).
    fireEvent.click(screen.getByTestId('agent-conv-delete-confirm-btn'))
    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('conv-1'))
    expect(startNewConversation).toHaveBeenCalledWith('p1')
  })

  it('Cancel drops back to the menu without deleting', () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    fireEvent.click(screen.getByTestId('agent-conv-delete'))
    fireEvent.click(screen.getByRole('button', { name: /cancel|cancelar/i }))
    expect(screen.queryByTestId('agent-conv-delete-confirm')).toBeNull()
    expect(screen.getByTestId('agent-conv-rename')).toBeInTheDocument() // back to the menu
    expect(deleteConversation).not.toHaveBeenCalled()
  })
})
