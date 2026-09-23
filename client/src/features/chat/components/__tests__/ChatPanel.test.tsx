import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { render } from '../../../../test-utils'
import { ChatPanel } from '../ChatPanel'
import type { UseChatReturn } from '../../hooks/useChat'
import type { DesktopProject } from '../../../../hooks/useDesktop'

function makeChat(overrides: Partial<UseChatReturn> = {}): UseChatReturn {
  return {
    conversations: [],
    activeTabIndex: 0,
    isPanelOpen: false,
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
  added_at: '2024-01-01T00:00:00.000Z',
  last_seen_at: '2024-01-01T00:00:00.000Z',
}

describe('ChatPanel', () => {
  describe('when panel is closed (isPanelOpen=false)', () => {
    it('renders collapsed strip with chat icon', () => {
      const chat = makeChat({ isPanelOpen: false })
      render(<ChatPanel chat={chat} />)
      // Collapsed panel has "Open chat" title
      const strip = document.querySelector('[title="Open chat"]')
      expect(strip).toBeTruthy()
    })

    it('calls togglePanel when collapsed strip is clicked', () => {
      const togglePanel = vi.fn()
      const chat = makeChat({ isPanelOpen: false, togglePanel })
      render(<ChatPanel chat={chat} />)
      const strip = document.querySelector('[title="Open chat"]') as HTMLElement
      fireEvent.click(strip)
      expect(togglePanel).toHaveBeenCalledTimes(1)
    })

    it('shows active stream count badge when conversations are streaming', () => {
      const chat = makeChat({
        isPanelOpen: false,
        conversations: [
          {
            id: 'conv-1',
            title: 'Chat 1',
            model: 'claude-opus-4',
            messages: [],
            isStreaming: true,
            streamingText: '',
            commandProposals: [],
          },
        ],
      })
      render(<ChatPanel chat={chat} />)
      // Badge shows count "1"
      expect(screen.getByText('1')).toBeInTheDocument()
    })
  })

  describe('when panel is open (isPanelOpen=true)', () => {
    it('renders expanded panel', () => {
      const chat = makeChat({ isPanelOpen: true })
      render(<ChatPanel chat={chat} project={mockProject} />)
      // Panel is wide (w-80) — check no "Open chat" title
      expect(document.querySelector('[title="Open chat"]')).toBeNull()
    })

    it('renders empty state text when conversations is empty (no project)', () => {
      const chat = makeChat({ isPanelOpen: true })
      render(<ChatPanel chat={chat} />)
      expect(screen.getByText('No conversations yet')).toBeInTheDocument()
    })

    it('renders project name and suggestions when conversations is empty (with project)', () => {
      const chat = makeChat({ isPanelOpen: true })
      render(<ChatPanel chat={chat} project={mockProject} />)
      expect(screen.getAllByText('Test Project').length).toBeGreaterThanOrEqual(1)
      expect(screen.getByText('Start a conversation about this project')).toBeInTheDocument()
    })

    it('renders "New conversation" button when no conversations', () => {
      const chat = makeChat({ isPanelOpen: true })
      render(<ChatPanel chat={chat} project={mockProject} />)
      expect(screen.getByRole('button', { name: /new conversation/i })).toBeInTheDocument()
    })

    it('calls createConversation when "New conversation" button is clicked', () => {
      const createConversation = vi.fn()
      const chat = makeChat({ isPanelOpen: true, createConversation })
      render(<ChatPanel chat={chat} project={mockProject} />)
      fireEvent.click(screen.getByRole('button', { name: /new conversation/i }))
      expect(createConversation).toHaveBeenCalled()
    })

    it('renders tab for each conversation', () => {
      const conversations = [
        {
          id: 'conv-1',
          title: 'Chat Alpha',
          model: 'claude-opus-4',
          messages: [],
          isStreaming: false,
          streamingText: '',
          commandProposals: [],
        },
        {
          id: 'conv-2',
          title: null,
          model: 'claude-opus-4',
          messages: [],
          isStreaming: false,
          streamingText: '',
          commandProposals: [],
        },
      ]
      const chat = makeChat({ isPanelOpen: true, conversations, activeTabIndex: 0 })
      render(<ChatPanel chat={chat} project={mockProject} />)
      // "Chat Alpha" appears in both tab and project view — just check it renders
      expect(screen.getAllByText('Chat Alpha').length).toBeGreaterThanOrEqual(1)
      expect(screen.getByText('Chat 2')).toBeInTheDocument()
    })

    it('calls setActiveTabIndex when a tab is clicked', () => {
      const setActiveTabIndex = vi.fn()
      const conversations = [
        {
          id: 'conv-1',
          title: 'First',
          model: 'claude-opus-4',
          messages: [],
          isStreaming: false,
          streamingText: '',
          commandProposals: [],
        },
        {
          id: 'conv-2',
          title: 'Second',
          model: 'claude-opus-4',
          messages: [],
          isStreaming: false,
          streamingText: '',
          commandProposals: [],
        },
      ]
      const chat = makeChat({ isPanelOpen: true, conversations, activeTabIndex: 0, setActiveTabIndex })
      render(<ChatPanel chat={chat} project={mockProject} />)

      // Click the Second tab
      fireEvent.click(screen.getByText('Second'))
      expect(setActiveTabIndex).toHaveBeenCalledWith(1)
    })

    it('shows streaming indicator dot on tab when isStreaming=true', () => {
      const conversations = [
        {
          id: 'conv-1',
          title: 'Streaming',
          model: 'claude-opus-4',
          messages: [],
          isStreaming: true,
          streamingText: 'Thinking...',
          commandProposals: [],
        },
      ]
      const chat = makeChat({ isPanelOpen: true, conversations, activeTabIndex: 0 })
      render(<ChatPanel chat={chat} project={mockProject} />)
      // The streaming dot is an animate-pulse span
      const pulse = document.querySelector('.animate-pulse')
      expect(pulse).toBeTruthy()
    })
  })
})
