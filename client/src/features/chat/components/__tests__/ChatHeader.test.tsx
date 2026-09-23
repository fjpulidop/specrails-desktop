import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { render } from '../../../../test-utils'
import { ChatHeader } from '../ChatHeader'

function makeProps(overrides: Partial<Parameters<typeof ChatHeader>[0]> = {}) {
  return {
    title: 'Test Chat',
    canCreateNew: true,
    onToggle: vi.fn(),
    onNewConversation: vi.fn(),
    onDeleteConversation: vi.fn(),
    hasActiveConversation: false,
    ...overrides,
  }
}

describe('ChatHeader', () => {
  it('renders title when provided', () => {
    render(<ChatHeader {...makeProps({ title: 'My Conversation' })} />)
    expect(screen.getByText('My Conversation')).toBeInTheDocument()
  })

  it('renders "Chat" as fallback when title is null', () => {
    render(<ChatHeader {...makeProps({ title: null })} />)
    expect(screen.getByText('Chat')).toBeInTheDocument()
  })

  it('renders a "New conversation" button', () => {
    render(<ChatHeader {...makeProps()} />)
    expect(screen.getByTitle('New conversation')).toBeInTheDocument()
  })

  it('disables New conversation button when canCreateNew=false', () => {
    render(<ChatHeader {...makeProps({ canCreateNew: false })} />)
    const btn = screen.getByTitle('New conversation')
    expect(btn).toBeDisabled()
  })

  it('enables New conversation button when canCreateNew=true', () => {
    render(<ChatHeader {...makeProps({ canCreateNew: true })} />)
    const btn = screen.getByTitle('New conversation')
    expect(btn).not.toBeDisabled()
  })

  it('calls onNewConversation when New button clicked', () => {
    const onNewConversation = vi.fn()
    render(<ChatHeader {...makeProps({ onNewConversation })} />)
    fireEvent.click(screen.getByTitle('New conversation'))
    expect(onNewConversation).toHaveBeenCalledTimes(1)
  })

  it('does NOT render delete button when hasActiveConversation=false', () => {
    render(<ChatHeader {...makeProps({ hasActiveConversation: false })} />)
    expect(screen.queryByTitle('Delete conversation')).toBeNull()
  })

  it('renders delete button when hasActiveConversation=true', () => {
    render(<ChatHeader {...makeProps({ hasActiveConversation: true })} />)
    expect(screen.getByTitle('Delete conversation')).toBeInTheDocument()
  })

  it('calls onDeleteConversation when delete button clicked', () => {
    const onDeleteConversation = vi.fn()
    render(<ChatHeader {...makeProps({ hasActiveConversation: true, onDeleteConversation })} />)
    fireEvent.click(screen.getByTitle('Delete conversation'))
    expect(onDeleteConversation).toHaveBeenCalledTimes(1)
  })

  it('renders Close chat button', () => {
    render(<ChatHeader {...makeProps()} />)
    expect(screen.getByTitle('Close chat')).toBeInTheDocument()
  })

  it('calls onToggle when Close chat button clicked', () => {
    const onToggle = vi.fn()
    render(<ChatHeader {...makeProps({ onToggle })} />)
    fireEvent.click(screen.getByTitle('Close chat'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
