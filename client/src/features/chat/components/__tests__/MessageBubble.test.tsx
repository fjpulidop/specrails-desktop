import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '../../../../test-utils'
import { MessageBubble } from '../MessageBubble'
import type { ChatMessage } from '../../../../types'

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <span>{children}</span>,
}))
vi.mock('remark-gfm', () => ({ default: () => {} }))

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 1,
    conversation_id: 'conv-1',
    role: 'assistant',
    content: 'Hello world',
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

const noOp = vi.fn()

describe('MessageBubble', () => {
  describe('user messages', () => {
    it('renders user message content', () => {
      render(
        <MessageBubble
          message={makeMessage({ role: 'user', content: 'User query here' })}
          onConfirmCommand={noOp}
          onDismissCommand={noOp}
        />
      )
      expect(screen.getByText('User query here')).toBeInTheDocument()
    })

    it('does not render Suggested command for user messages', () => {
      render(
        <MessageBubble
          message={makeMessage({ role: 'user', content: 'Some user text' })}
          onConfirmCommand={noOp}
          onDismissCommand={noOp}
        />
      )
      expect(screen.queryByText('Suggested command')).not.toBeInTheDocument()
    })
  })

  describe('assistant messages', () => {
    it('renders plain assistant message content', () => {
      render(
        <MessageBubble
          message={makeMessage({ role: 'assistant', content: 'Plain text response' })}
          onConfirmCommand={noOp}
          onDismissCommand={noOp}
        />
      )
      expect(screen.getByText('Plain text response')).toBeInTheDocument()
    })

    it('renders assistant message with :::command block', () => {
      const content = 'Here is a suggestion:\n:::command\n/specrails:implement --spec SPEA-001\n:::\nGood luck!'
      render(
        <MessageBubble
          message={makeMessage({ role: 'assistant', content })}
          onConfirmCommand={noOp}
          onDismissCommand={noOp}
        />
      )
      // CommandProposal renders "Suggested command"
      expect(screen.getByText('Suggested command')).toBeInTheDocument()
      expect(screen.getByText('/specrails:implement --spec SPEA-001')).toBeInTheDocument()
    })

    it('renders text segments around command block', () => {
      const content = 'Intro text\n:::command\n/specrails:implement\n:::\nTrailing text'
      render(
        <MessageBubble
          message={makeMessage({ role: 'assistant', content })}
          onConfirmCommand={noOp}
          onDismissCommand={noOp}
        />
      )
      expect(screen.getByText('Intro text')).toBeInTheDocument()
      expect(screen.getByText('Trailing text')).toBeInTheDocument()
    })

    it('renders multiple command blocks', () => {
      const content = ':::command\n/specrails:implement\n:::\n:::command\n/specrails:propose-spec\n:::'
      render(
        <MessageBubble
          message={makeMessage({ role: 'assistant', content })}
          onConfirmCommand={noOp}
          onDismissCommand={noOp}
        />
      )
      const suggestions = screen.getAllByText('Suggested command')
      expect(suggestions).toHaveLength(2)
    })

    it('calls onConfirmCommand with command when Run is clicked', () => {
      const onConfirm = vi.fn()
      const content = ':::command\n/specrails:implement --spec SPEA-001\n:::'
      render(
        <MessageBubble
          message={makeMessage({ role: 'assistant', content })}
          onConfirmCommand={onConfirm}
          onDismissCommand={noOp}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /run/i }))
      expect(onConfirm).toHaveBeenCalledWith('/specrails:implement --spec SPEA-001')
    })

    it('calls onDismissCommand with command when Dismiss is clicked', () => {
      const onDismiss = vi.fn()
      const content = ':::command\n/specrails:health-check\n:::'
      render(
        <MessageBubble
          message={makeMessage({ role: 'assistant', content })}
          onConfirmCommand={noOp}
          onDismissCommand={onDismiss}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
      expect(onDismiss).toHaveBeenCalledWith('/specrails:health-check')
    })

    it('renders message with only whitespace segment as null (no empty span)', () => {
      // A content that has only whitespace between blocks should skip the empty segment
      const content = ':::command\n/specrails:implement\n:::\n   '
      render(
        <MessageBubble
          message={makeMessage({ role: 'assistant', content })}
          onConfirmCommand={noOp}
          onDismissCommand={noOp}
        />
      )
      // Just check no error and command still renders
      expect(screen.getByText('Suggested command')).toBeInTheDocument()
    })

    it('renders pure text assistant message via ReactMarkdown', () => {
      render(
        <MessageBubble
          message={makeMessage({ role: 'assistant', content: '## Header' })}
          onConfirmCommand={noOp}
          onDismissCommand={noOp}
        />
      )
      // Mock ReactMarkdown just passes children through as a span
      expect(screen.getByText('## Header')).toBeInTheDocument()
    })
  })
})
