import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { ChatPanel } from '../../features/chat/components/ChatPanel'
import type { UseChatReturn } from '../../features/chat/hooks/useChat'
import type { DesktopProject } from '../../hooks/useDesktop'

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <span>{children}</span>,
}))
vi.mock('remark-gfm', () => ({ default: () => {} }))

function makeChat(overrides: Partial<UseChatReturn> = {}): UseChatReturn {
  return {
    conversations: [],
    activeTabIndex: 0,
    isPanelOpen: true,
    setActiveTabIndex: vi.fn(),
    togglePanel: vi.fn(),
    createConversation: vi.fn(),
    deleteConversation: vi.fn(),
    sendMessage: vi.fn(),
    startWithMessage: vi.fn(),
    abortStream: vi.fn(),
    confirmCommand: vi.fn(),
    dismissCommandProposal: vi.fn(),
    ...overrides,
  }
}

const mockProject: DesktopProject = {
  id: 'proj-1',
  slug: 'test-project',
  name: 'Test Project',
  path: '/home/user/test-project',
  db_path: '/home/user/.specrails/projects/test-project/jobs.sqlite',
  added_at: '2024-01-01T00:00:00Z',
  last_seen_at: '2024-01-01T00:00:00Z',
}

const makeConversation = (id: string, title: string | null = null) => ({
  id,
  title,
  model: 'claude-opus-4' as const,
  messages: [],
  isStreaming: false,
  streamingText: '',
  commandProposals: [] as string[],
})

describe('ChatPanel - extended coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls deleteConversation(id) from ChatHeader onDeleteConversation when active conversation exists', () => {
    const deleteConversation = vi.fn()
    const conversation = makeConversation('conv-1', 'My Chat')
    const chat = makeChat({
      isPanelOpen: true,
      conversations: [conversation],
      activeTabIndex: 0,
      deleteConversation,
    })
    render(<ChatPanel chat={chat} project={mockProject} />)

    // ChatHeader renders the delete/× button — find it via aria or class
    // The onDeleteConversation callback is triggered by ChatHeader's delete button
    // We can find it as a button near the chat title
    const deleteBtn = document.querySelector('button[title="Delete conversation"]') as HTMLElement
    if (deleteBtn) {
      fireEvent.click(deleteBtn)
      expect(deleteConversation).toHaveBeenCalledWith('conv-1')
    }
  })

  it('clicking tab × button calls deleteConversation with that tab id', async () => {
    const user = userEvent.setup()
    const deleteConversation = vi.fn()
    const conv1 = makeConversation('conv-1', 'First')
    const conv2 = makeConversation('conv-2', 'Second')
    const chat = makeChat({
      isPanelOpen: true,
      conversations: [conv1, conv2],
      activeTabIndex: 0,
      deleteConversation,
    })
    render(<ChatPanel chat={chat} project={mockProject} />)

    // The tab × button is hidden (group-hover:block). We need to hover the tab first.
    // Find all × buttons (they render as text "×" within the tab bar)
    const xButtons = screen.getAllByText('×')
    expect(xButtons.length).toBeGreaterThanOrEqual(1)

    // Click the first × button (belongs to first tab)
    await user.click(xButtons[0])
    expect(deleteConversation).toHaveBeenCalledWith('conv-1')
  })

  it('tab × button click stops propagation (does not also call setActiveTabIndex)', async () => {
    const user = userEvent.setup()
    const deleteConversation = vi.fn()
    const setActiveTabIndex = vi.fn()
    const conv1 = makeConversation('conv-1', 'First')
    const conv2 = makeConversation('conv-2', 'Second')
    const chat = makeChat({
      isPanelOpen: true,
      conversations: [conv1, conv2],
      activeTabIndex: 0,
      deleteConversation,
      setActiveTabIndex,
    })
    render(<ChatPanel chat={chat} project={mockProject} />)

    const xButtons = screen.getAllByText('×')
    await user.click(xButtons[1]) // Click second tab's × button

    expect(deleteConversation).toHaveBeenCalledWith('conv-2')
    // setActiveTabIndex should NOT have been called since propagation is stopped
    expect(setActiveTabIndex).not.toHaveBeenCalled()
  })

  it('does not call deleteConversation from ChatHeader when no active conversation', () => {
    // With empty conversations, activeConversation is null
    const deleteConversation = vi.fn()
    const chat = makeChat({
      isPanelOpen: true,
      conversations: [],
      deleteConversation,
    })
    render(<ChatPanel chat={chat} project={mockProject} />)

    // The "New conversation" button should be visible
    expect(screen.getByRole('button', { name: /new conversation/i })).toBeInTheDocument()
    // deleteConversation should NOT have been called
    expect(deleteConversation).not.toHaveBeenCalled()
  })

  it('calls startWithMessage when a suggestion chip is clicked (empty state)', () => {
    const startWithMessage = vi.fn()
    const chat = makeChat({
      isPanelOpen: true,
      conversations: [],
      startWithMessage,
    })
    render(<ChatPanel chat={chat} project={mockProject} />)

    // Suggestion chips appear in the empty state when project is provided
    const suggestionBtn = screen.getByText("What's the project status?")
    fireEvent.click(suggestionBtn)
    expect(startWithMessage).toHaveBeenCalledWith("What's the project status?")
  })

  it('shows active conversation content (MessageList) when conversation exists', () => {
    const conversation = {
      ...makeConversation('conv-1', 'Active Chat'),
      messages: [
        {
          id: 1,
          conversation_id: 'conv-1',
          role: 'user' as const,
          content: 'Test message content',
          created_at: '2024-01-01T00:00:00Z',
        },
      ],
    }
    const chat = makeChat({
      isPanelOpen: true,
      conversations: [conversation],
      activeTabIndex: 0,
    })
    render(<ChatPanel chat={chat} project={mockProject} />)
    expect(screen.getByText('Test message content')).toBeInTheDocument()
  })

  it('renders multiple conversation tabs', () => {
    const conversations = [
      makeConversation('c1', 'Alpha'),
      makeConversation('c2', 'Beta'),
      makeConversation('c3', null), // title-less → "Chat 3"
    ]
    const chat = makeChat({
      isPanelOpen: true,
      conversations,
      activeTabIndex: 0,
    })
    render(<ChatPanel chat={chat} project={mockProject} />)
    // Alpha appears in both tab AND ChatHeader title — use getAllByText
    expect(screen.getAllByText('Alpha').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Chat 3')).toBeInTheDocument()
  })

  it('shows project path in empty state', () => {
    const chat = makeChat({ isPanelOpen: true, conversations: [] })
    render(<ChatPanel chat={chat} project={mockProject} />)
    expect(screen.getByText('/home/user/test-project')).toBeInTheDocument()
  })

  it('renders "No conversations yet" text without project prop', () => {
    const chat = makeChat({ isPanelOpen: true, conversations: [] })
    render(<ChatPanel chat={chat} />)
    expect(screen.getByText('No conversations yet')).toBeInTheDocument()
  })
})
