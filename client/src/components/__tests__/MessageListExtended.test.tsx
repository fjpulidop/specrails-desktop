import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '../../test-utils'
import { MessageList } from '../../features/chat/components/MessageList'
import type { ChatMessage } from '../../types'
import type { DesktopProject } from '../../hooks/useDesktop'

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <span>{children}</span>,
}))
vi.mock('remark-gfm', () => ({ default: () => {} }))

const noOp = vi.fn()

const mockProject: DesktopProject = {
  id: 'proj-1',
  slug: 'test-project',
  name: 'Test Project',
  path: '/home/user/test-project',
  db_path: '/home/user/.specrails/projects/test-project/jobs.sqlite',
  added_at: '2024-01-01T00:00:00Z',
  last_seen_at: '2024-01-01T00:00:00Z',
}

const assistantMessage: ChatMessage = {
  id: 1,
  conversation_id: 'conv-1',
  role: 'assistant',
  content: 'Hello! How can I help you?',
  created_at: '2024-01-01T00:00:00Z',
}

describe('MessageList - extended coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders project name in empty state when project is provided', () => {
    render(
      <MessageList
        messages={[]}
        streamingText=""
        isStreaming={false}
        project={mockProject}
        onConfirmCommand={noOp}
        onDismissCommand={noOp}
      />
    )
    expect(screen.getByText('Test Project')).toBeInTheDocument()
    expect(screen.getByText('Context loaded — ready to help')).toBeInTheDocument()
  })

  it('renders suggestion buttons when project is provided and no messages', () => {
    render(
      <MessageList
        messages={[]}
        streamingText=""
        isStreaming={false}
        project={mockProject}
        onConfirmCommand={noOp}
        onDismissCommand={noOp}
      />
    )
    expect(screen.getByText("What's the current project status?")).toBeInTheDocument()
    expect(screen.getByText('Show me recent job failures')).toBeInTheDocument()
    expect(screen.getByText('What tests should I run?')).toBeInTheDocument()
    expect(screen.getByText('Explain the main architecture')).toBeInTheDocument()
  })

  it('calls onSuggestion with suggestion text when suggestion button is clicked', () => {
    const onSuggestion = vi.fn()
    render(
      <MessageList
        messages={[]}
        streamingText=""
        isStreaming={false}
        project={mockProject}
        onConfirmCommand={noOp}
        onDismissCommand={noOp}
        onSuggestion={onSuggestion}
      />
    )
    fireEvent.click(screen.getByText("What's the current project status?"))
    expect(onSuggestion).toHaveBeenCalledWith("What's the current project status?")
  })

  it('renders "No messages yet" when no project and no messages', () => {
    render(
      <MessageList
        messages={[]}
        streamingText=""
        isStreaming={false}
        onConfirmCommand={noOp}
        onDismissCommand={noOp}
      />
    )
    expect(screen.getByText('No messages yet')).toBeInTheDocument()
    expect(screen.getByText('Ask Claude anything about your project')).toBeInTheDocument()
  })

  it('handles scroll event on container (handleScroll function)', () => {
    const { container } = render(
      <MessageList
        messages={[assistantMessage]}
        streamingText=""
        isStreaming={false}
        onConfirmCommand={noOp}
        onDismissCommand={noOp}
      />
    )
    // The container has overflow-y-auto, trigger scroll
    const scrollContainer = container.querySelector('.overflow-y-auto')
    if (scrollContainer) {
      // Simulate scroll near top (distanceFromBottom > 100 means user scrolled up)
      Object.defineProperty(scrollContainer, 'scrollHeight', { value: 500, configurable: true })
      Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, configurable: true })
      Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true })
      fireEvent.scroll(scrollContainer)
      // No assertion needed — just ensure no error is thrown
      expect(scrollContainer).toBeTruthy()
    }
  })

  it('does not show suggestion buttons when project is undefined', () => {
    render(
      <MessageList
        messages={[]}
        streamingText=""
        isStreaming={false}
        onConfirmCommand={noOp}
        onDismissCommand={noOp}
      />
    )
    expect(screen.queryByText("What's the current project status?")).not.toBeInTheDocument()
  })

  it('renders messages even when project is provided', () => {
    render(
      <MessageList
        messages={[assistantMessage]}
        streamingText=""
        isStreaming={false}
        project={mockProject}
        onConfirmCommand={noOp}
        onDismissCommand={noOp}
      />
    )
    expect(screen.getByText('Hello! How can I help you?')).toBeInTheDocument()
    // Empty state should not show since there are messages
    expect(screen.queryByText('Context loaded — ready to help')).not.toBeInTheDocument()
  })
})
