import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const renameConversation = vi.fn(async () => {})
let active: { id: string; title: string | null; pinned_project_id: string | null } | null = {
  id: 'conv-1', title: 'Greeting And Friendly Introduction', pinned_project_id: 'p1',
}
vi.mock('../../../context/AgentChatContext', () => ({
  useAgentChat: () => ({ active, renameConversation }),
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
    expect(screen.getByTestId('agent-conv-copy-name')).toBeInTheDocument()
    expect(screen.getByTestId('agent-conv-copy-id')).toBeInTheDocument()
    expect(screen.getByTestId('agent-conv-copy-project')).toBeInTheDocument()
    expect(screen.getByTestId('agent-conv-copy-path')).toBeInTheDocument()
  })

  it('Rename → inline input → Enter commits via renameConversation', async () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    fireEvent.click(screen.getByTestId('agent-conv-rename'))
    const input = screen.getByPlaceholderText(/conversation name/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Deploy checklist' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(renameConversation).toHaveBeenCalledWith('conv-1', 'Deploy checklist'))
  })

  it('Escape in the rename input cancels without renaming', () => {
    render(<AgentConversationHeader />)
    fireEvent.click(screen.getByTestId('agent-conv-menu-trigger'))
    fireEvent.click(screen.getByTestId('agent-conv-rename'))
    const input = screen.getByPlaceholderText(/conversation name/i)
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
})
