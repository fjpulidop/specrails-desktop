import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { ChatInput } from '../ChatInput'

const defaultProps = {
  conversationId: 'conv-1',
  model: 'sonnet',
  hasMessages: false,
  isStreaming: false,
  onSend: vi.fn(),
  onAbort: vi.fn(),
  onModelChange: vi.fn(),
}

describe('ChatInput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders textarea and send button', () => {
    render(<ChatInput {...defaultProps} />)
    expect(screen.getByPlaceholderText('Message...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Send/i })).toBeInTheDocument()
  })

  it('send button is disabled when textarea is empty', () => {
    render(<ChatInput {...defaultProps} />)
    expect(screen.getByRole('button', { name: /Send/i })).toBeDisabled()
  })

  it('send button enables when text is entered', async () => {
    const user = userEvent.setup()
    render(<ChatInput {...defaultProps} />)
    const textarea = screen.getByPlaceholderText('Message...')
    await user.type(textarea, 'Hello')
    expect(screen.getByRole('button', { name: /Send/i })).not.toBeDisabled()
  })

  it('Enter key sends message and calls onSend', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<ChatInput {...defaultProps} onSend={onSend} />)
    const textarea = screen.getByPlaceholderText('Message...')
    await user.type(textarea, 'Hello{Enter}')
    expect(onSend).toHaveBeenCalledWith('conv-1', 'Hello')
  })

  it('Shift+Enter adds newline instead of sending', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<ChatInput {...defaultProps} onSend={onSend} />)
    const textarea = screen.getByPlaceholderText('Message...')
    await user.type(textarea, 'Hello{Shift>}{Enter}{/Shift}World')
    expect(onSend).not.toHaveBeenCalled()
    expect((textarea as HTMLTextAreaElement).value).toContain('Hello')
    expect((textarea as HTMLTextAreaElement).value).toContain('World')
  })

  it('clicking Send button calls onSend with trimmed text', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<ChatInput {...defaultProps} onSend={onSend} />)
    const textarea = screen.getByPlaceholderText('Message...')
    await user.type(textarea, '  Hello  ')
    const sendBtn = screen.getByRole('button', { name: /Send/i })
    await user.click(sendBtn)
    expect(onSend).toHaveBeenCalledWith('conv-1', 'Hello')
  })

  it('textarea is cleared after sending', async () => {
    const user = userEvent.setup()
    render(<ChatInput {...defaultProps} />)
    const textarea = screen.getByPlaceholderText('Message...') as HTMLTextAreaElement
    await user.type(textarea, 'Hello{Enter}')
    expect(textarea.value).toBe('')
  })

  it('textarea is disabled while streaming', () => {
    render(<ChatInput {...defaultProps} isStreaming={true} />)
    const textarea = screen.getByPlaceholderText('Message...')
    expect(textarea).toBeDisabled()
  })

  it('send button is disabled while streaming', () => {
    render(<ChatInput {...defaultProps} isStreaming={true} />)
    expect(screen.getByRole('button', { name: /Send/i })).toBeDisabled()
  })

  it('shows Stop button when streaming', () => {
    render(<ChatInput {...defaultProps} isStreaming={true} />)
    expect(screen.getByRole('button', { name: /Stop/i })).toBeInTheDocument()
  })

  it('Stop button calls onAbort with conversationId', async () => {
    const user = userEvent.setup()
    const onAbort = vi.fn()
    render(<ChatInput {...defaultProps} isStreaming={true} onAbort={onAbort} />)
    const stopBtn = screen.getByRole('button', { name: /Stop/i })
    await user.click(stopBtn)
    expect(onAbort).toHaveBeenCalledWith('conv-1')
  })

  it('Stop button is not shown when not streaming', () => {
    render(<ChatInput {...defaultProps} isStreaming={false} />)
    expect(screen.queryByRole('button', { name: /Stop/i })).not.toBeInTheDocument()
  })

  it('model selector is rendered', () => {
    render(<ChatInput {...defaultProps} />)
    const select = screen.getByRole('combobox')
    expect(select).toBeInTheDocument()
  })

  it('model selector shows current model', () => {
    render(<ChatInput {...defaultProps} model="sonnet" />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('sonnet')
  })

  it('model selector is disabled when hasMessages is true', () => {
    render(<ChatInput {...defaultProps} hasMessages={true} />)
    const select = screen.getByRole('combobox')
    expect(select).toBeDisabled()
  })

  it('model selector is enabled when hasMessages is false', () => {
    render(<ChatInput {...defaultProps} hasMessages={false} />)
    const select = screen.getByRole('combobox')
    expect(select).not.toBeDisabled()
  })

  it('model selector calls onModelChange when changed', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()
    render(<ChatInput {...defaultProps} onModelChange={onModelChange} />)
    const select = screen.getByRole('combobox')
    await user.selectOptions(select, 'opus')
    expect(onModelChange).toHaveBeenCalledWith('opus')
  })

  it('when provider=codex, dropdown lists gpt-5.5 as the first option', () => {
    render(
      <ChatInput
        {...defaultProps}
        provider="codex"
        model="gpt-5.5"
      />
    )
    const select = screen.getByRole('combobox') as HTMLSelectElement
    const options = Array.from(select.options).map((o) => o.value)
    expect(options[0]).toBe('gpt-5.5')
    expect(options).toContain('gpt-5.4')
    expect(options).toContain('gpt-5.3-codex')
  })

  it('when provider=codex, model selector value is gpt-5.4-mini when set', () => {
    render(
      <ChatInput
        {...defaultProps}
        provider="codex"
        model="gpt-5.4-mini"
      />
    )
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('gpt-5.4-mini')
  })

  it('preserves and commits a safe custom Kimi alias exactly', () => {
    const onModelChange = vi.fn()
    render(
      <ChatInput
        {...defaultProps}
        provider="kimi"
        model="moonshot-team/private-coder:v1"
        onModelChange={onModelChange}
      />,
    )

    const input = screen.getByTestId('chat-model-alias-input')
    expect(input).toHaveValue('moonshot-team/private-coder:v1')
    fireEvent.change(input, { target: { value: 'Moonshot-Team/Private_Coder:v2' } })
    fireEvent.blur(input)
    expect(onModelChange).toHaveBeenCalledWith('Moonshot-Team/Private_Coder:v2')
  })

  it('does not commit an unsafe Kimi alias or unlock the picker after messages exist', () => {
    const onModelChange = vi.fn()
    const { rerender } = render(
      <ChatInput
        {...defaultProps}
        provider="kimi"
        model="k3"
        onModelChange={onModelChange}
      />,
    )
    const input = screen.getByTestId('chat-model-alias-input')
    fireEvent.change(input, { target: { value: '--yolo' } })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    fireEvent.blur(input)
    expect(onModelChange).not.toHaveBeenCalled()
    expect(input).toHaveValue('k3')

    rerender(
      <ChatInput
        {...defaultProps}
        provider="kimi"
        model="k3"
        hasMessages
        onModelChange={onModelChange}
      />,
    )
    expect(screen.getByTestId('chat-model-alias-input')).toBeDisabled()
  })
})
