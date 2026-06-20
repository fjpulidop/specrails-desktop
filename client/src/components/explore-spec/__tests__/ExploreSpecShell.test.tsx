import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { ExploreSpecShell } from '../ExploreSpecShell'
import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'

const mockStartWithMessage = vi.fn().mockResolvedValue('conv-1')
const mockSendMessage = vi.fn().mockResolvedValue(undefined)
const conversationsRef: { value: Array<{
  id: string; title: string | null; model: string; provider?: string | null;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  isStreaming: boolean; streamingText: string; commandProposals: string[]
}> } = { value: [] }

vi.mock('../../../hooks/useChat', () => ({
  useChatContext: () => ({
    conversations: conversationsRef.value,
    activeTabIndex: 0,
    startWithMessage: mockStartWithMessage,
    sendMessage: mockSendMessage,
    abortStream: vi.fn(),
    confirmCommand: vi.fn(),
    dismissCommandProposal: vi.fn(),
    changeConversationModel: vi.fn(),
    createConversation: vi.fn(),
    deleteConversation: vi.fn(),
    isPanelOpen: false,
    togglePanel: vi.fn(),
    setActiveTabIndex: vi.fn(),
  }),
}))

vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ activeProjectId: 'proj-1', projects: [] }),
}))

vi.mock('../../../lib/api', () => ({
  getApiBase: () => '/api/projects/proj-1',
}))

// Mock RichAttachmentEditor as a plain textarea so tests stay focused on
// the shell's wiring, not on the editor's drop / upload internals.
vi.mock('../../RichAttachmentEditor', () => ({
  RichAttachmentEditor: React.forwardRef(function MockEditor(
    props: { placeholder?: string; ariaLabel?: string; onChange?: () => void; onSubmit?: () => void },
    ref: React.Ref<{ getPlainText: () => string; getAttachmentIds: () => string[]; insertPill: () => void; focus: () => void; resetHeight: () => void; clear: () => void }>,
  ) {
    const inputRef = React.useRef<HTMLTextAreaElement>(null)
    React.useImperativeHandle(ref, () => ({
      getPlainText: () => inputRef.current?.value ?? '',
      getAttachmentIds: () => [],
      insertPill: () => {},
      focus: () => inputRef.current?.focus(),
      resetHeight: () => {},
      clear: () => { if (inputRef.current) inputRef.current.value = '' },
    }))
    return (
      <textarea
        ref={inputRef}
        aria-label={props.ariaLabel}
        placeholder={props.placeholder}
        onChange={() => props.onChange?.()}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) props.onSubmit?.() }}
      />
    )
  }),
}))

function makeFakeWs() {
  const handlers = new Map<string, (m: unknown) => void>()
  return {
    registerHandler: (id: string, fn: (m: unknown) => void) => handlers.set(id, fn),
    unregisterHandler: (id: string) => handlers.delete(id),
    connectionStatus: 'connected' as const,
    handlerCount: () => handlers.size,
    emit: (msg: unknown) => handlers.forEach((h) => h(msg)),
  }
}

function wrap(ws: ReturnType<typeof makeFakeWs>) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(SharedWebSocketContext.Provider, { value: ws }, children)
}

describe('ExploreSpecShell', () => {
  let onClose: ReturnType<typeof vi.fn>
  let onTicketCreated: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onClose = vi.fn()
    onTicketCreated = vi.fn()
    conversationsRef.value = []
    mockStartWithMessage.mockClear()
    mockStartWithMessage.mockResolvedValue('conv-1')
    mockSendMessage.mockClear()
  })

  it('starts the conversation with the slash-command prefix on mount', async () => {
    const ws = makeFakeWs()
    render(<ExploreSpecShell initialIdea="dark mode" pendingSpecId="pending-1" initialAttachmentIds={[]} onClose={onClose} onTicketCreated={onTicketCreated} />, { wrapper: wrap(ws) })
    await waitFor(() => {
      expect(mockStartWithMessage).toHaveBeenCalled()
    })
    const arg = mockStartWithMessage.mock.calls[0][0] as string
    expect(arg).toContain('/specrails:explore-spec')
    expect(arg).toContain('dark mode')
  })

  it('passes initialAttachmentIds + pendingSpecId to startWithMessage when present', async () => {
    const ws = makeFakeWs()
    render(<ExploreSpecShell initialIdea="dark" pendingSpecId="pending-XYZ" initialAttachmentIds={['a-1', 'a-2']} onClose={onClose} />, { wrapper: wrap(ws) })
    await waitFor(() => {
      expect(mockStartWithMessage).toHaveBeenCalled()
    })
    const opts = mockStartWithMessage.mock.calls[0][1] as { attachments?: { ticketKey: string; ids: string[] } }
    expect(opts.attachments).toEqual({ ticketKey: 'pending-XYZ', ids: ['a-1', 'a-2'] })
  })

  it('omits attachments option when no initial attachments are supplied', async () => {
    const ws = makeFakeWs()
    render(<ExploreSpecShell initialIdea="dark" pendingSpecId="p" initialAttachmentIds={[]} onClose={onClose} />, { wrapper: wrap(ws) })
    await waitFor(() => {
      expect(mockStartWithMessage).toHaveBeenCalled()
    })
    const opts = mockStartWithMessage.mock.calls[0][1] as { attachments?: unknown }
    expect(opts.attachments).toBeUndefined()
  })

  it('renders eyebrow and dialog role for accessibility', async () => {
    const ws = makeFakeWs()
    render(<ExploreSpecShell initialIdea="hi" pendingSpecId="pending-1" initialAttachmentIds={[]} onClose={onClose} />, { wrapper: wrap(ws) })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/EXPLORE SPEC/i)).toBeInTheDocument()
  })

  it('shows the loading state until the conversation is bootstrapped', () => {
    const ws = makeFakeWs()
    render(<ExploreSpecShell initialIdea="hi" pendingSpecId="pending-1" initialAttachmentIds={[]} onClose={onClose} />, { wrapper: wrap(ws) })
    expect(screen.getByText(/Starting conversation/i)).toBeInTheDocument()
  })

  it('Esc on bare-initial overlay closes without confirm', async () => {
    const ws = makeFakeWs()
    render(<ExploreSpecShell initialIdea="hi" pendingSpecId="pending-1" initialAttachmentIds={[]} onClose={onClose} />, { wrapper: wrap(ws) })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('Esc with conversation in progress does NOT close immediately (confirm-discard guard)', async () => {
    const ws = makeFakeWs()
    conversationsRef.value = [{
      id: 'conv-1', title: null, model: 'sonnet',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'response' },
      ],
      isStreaming: false, streamingText: '', commandProposals: [],
    }]
    render(<ExploreSpecShell initialIdea="hi" pendingSpecId="pending-1" initialAttachmentIds={[]} onClose={onClose} />, { wrapper: wrap(ws) })
    // Wait for the conversation to actually be looked up (assistant message in DOM)
    await screen.findByText('response')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('labels the assistant bubble with the conversation provider (Gemini, not Claude)', async () => {
    const ws = makeFakeWs()
    conversationsRef.value = [{
      id: 'conv-1', title: null, model: 'gemini-2.5-pro', provider: 'gemini',
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'gemini reply' }],
      isStreaming: false, streamingText: '', commandProposals: [],
    }]
    render(<ExploreSpecShell initialIdea="hi" pendingSpecId="pending-1" initialAttachmentIds={[]} onClose={onClose} />, { wrapper: wrap(ws) })
    await screen.findByText('gemini reply')
    expect(screen.getByText('Gemini')).toBeInTheDocument()
    expect(screen.queryByText('Claude')).not.toBeInTheDocument()
  })

  it('labels codex conversations Codex', async () => {
    const ws = makeFakeWs()
    conversationsRef.value = [{
      id: 'conv-1', title: null, model: 'gpt-5.5', provider: 'codex',
      messages: [{ role: 'assistant', content: 'codex reply' }],
      isStreaming: false, streamingText: '', commandProposals: [],
    }]
    render(<ExploreSpecShell initialIdea="hi" pendingSpecId="pending-1" initialAttachmentIds={[]} onClose={onClose} />, { wrapper: wrap(ws) })
    await screen.findByText('codex reply')
    expect(screen.getByText('Codex')).toBeInTheDocument()
  })

  it('falls back to Claude when provider is null (single-provider legacy)', async () => {
    const ws = makeFakeWs()
    conversationsRef.value = [{
      id: 'conv-1', title: null, model: 'sonnet', provider: null,
      messages: [{ role: 'assistant', content: 'claude reply' }],
      isStreaming: false, streamingText: '', commandProposals: [],
    }]
    render(<ExploreSpecShell initialIdea="hi" pendingSpecId="pending-1" initialAttachmentIds={[]} onClose={onClose} />, { wrapper: wrap(ws) })
    await screen.findByText('claude reply')
    expect(screen.getByText('Claude')).toBeInTheDocument()
  })

  it('clicking a chip sends it as the next user message', async () => {
    const ws = makeFakeWs()
    conversationsRef.value = [{
      id: 'conv-1', title: null, model: 'sonnet',
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }],
      isStreaming: false, streamingText: '', commandProposals: [],
    }]
    render(<ExploreSpecShell initialIdea="hi" pendingSpecId="pending-1" initialAttachmentIds={[]} onClose={onClose} />, { wrapper: wrap(ws) })
    await screen.findByText('ok')
    await waitFor(() => expect(ws.handlerCount()).toBeGreaterThan(0))

    // Inject a draft update with chips via the WS
    ws.emit({
      type: 'spec_draft.update',
      conversationId: 'conv-1',
      draft: { title: 'X' },
      ready: false,
      chips: ['Looks good', 'Smaller scope'],
      changedFields: [],
      timestamp: '',
    })

    const chipBtn = await screen.findByRole('button', { name: 'Looks good' })
    fireEvent.click(chipBtn)
    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith('conv-1', 'Looks good', expect.any(Object))
    })
  })

  it('disables Send button while assistant is streaming', async () => {
    const ws = makeFakeWs()
    conversationsRef.value = [{
      id: 'conv-1', title: null, model: 'sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      isStreaming: true, streamingText: 'thinking...', commandProposals: [],
    }]
    render(<ExploreSpecShell initialIdea="hi" pendingSpecId="pending-1" initialAttachmentIds={[]} onClose={onClose} />, { wrapper: wrap(ws) })
    await waitFor(() => expect(mockStartWithMessage).toHaveBeenCalled())
    const sendBtn = screen.getByRole('button', { name: /streaming|send/i })
    expect(sendBtn).toBeDisabled()
  })

  it('calls onTicketCreated and onClose after a successful Create Spec POST', async () => {
    const ws = makeFakeWs()
    conversationsRef.value = [{
      id: 'conv-1', title: null, model: 'sonnet',
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }],
      isStreaming: false, streamingText: '', commandProposals: [],
    }]
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: { id: 99, title: 'Z' } }),
    })
    ;(global as unknown as { fetch: typeof fetch }).fetch = fakeFetch as unknown as typeof fetch

    render(<ExploreSpecShell initialIdea="hi" pendingSpecId="pending-1" initialAttachmentIds={[]} onClose={onClose} onTicketCreated={onTicketCreated} />, { wrapper: wrap(ws) })
    await screen.findByText('ok')
    await waitFor(() => expect(ws.handlerCount()).toBeGreaterThan(0))

    ws.emit({
      type: 'spec_draft.update',
      conversationId: 'conv-1',
      draft: { title: 'My title' },
      ready: true,
      chips: [],
      changedFields: ['title'],
      timestamp: '',
    })

    const createBtn = await screen.findByRole('button', { name: /create spec from current draft/i })
    // Wait for the spec_draft.update to propagate through useSpecDraftStream
    // and unset disabled — otherwise on slower CI runners the click fires
    // while `!draft.title.trim()` still holds and the click is a no-op.
    await waitFor(() => expect(createBtn).not.toBeDisabled())
    fireEvent.click(createBtn)
    await waitFor(() => {
      expect(fakeFetch).toHaveBeenCalledWith(
        expect.stringContaining('/tickets/from-draft'),
        expect.objectContaining({ method: 'POST' }),
      )
      expect(onTicketCreated).toHaveBeenCalledWith({ id: 99, title: 'Z' })
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('renders a minimize button only when onMinimize is provided', () => {
    const ws = makeFakeWs()
    const { rerender } = render(
      <ExploreSpecShell
        initialIdea="dark mode"
        pendingSpecId="pending-1"
        initialAttachmentIds={[]}
        onClose={onClose}
      />,
      { wrapper: wrap(ws) },
    )
    expect(screen.queryByTestId('explore-spec-minimize')).toBeNull()

    rerender(
      <ExploreSpecShell
        initialIdea="dark mode"
        pendingSpecId="pending-1"
        initialAttachmentIds={[]}
        onClose={onClose}
        onMinimize={vi.fn()}
      />,
    )
    expect(screen.getByTestId('explore-spec-minimize')).toBeTruthy()
  })

  it('clicking minimize fires onMinimize with the conversation id and never confirms', async () => {
    const ws = makeFakeWs()
    const onMinimize = vi.fn()
    render(
      <ExploreSpecShell
        initialIdea="dark mode"
        pendingSpecId="pending-1"
        initialAttachmentIds={[]}
        onClose={onClose}
        onMinimize={onMinimize}
      />,
      { wrapper: wrap(ws) },
    )
    await waitFor(() => expect(mockStartWithMessage).toHaveBeenCalled())

    // Even with multiple turns (would normally trigger discard-confirm on close),
    // minimize never confirms.
    conversationsRef.value = [
      {
        id: 'conv-1',
        title: 'foo',
        model: 'm',
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
        isStreaming: false,
        streamingText: '',
        commandProposals: [],
      },
    ]

    // Wait for the startWithMessage promise to resolve and propagate the
    // conversation id into component state before clicking minimize. Without
    // this the click can race the promise resolution under CI scheduling
    // and onMinimize fires with a null id.
    await waitFor(() => {
      fireEvent.click(screen.getByTestId('explore-spec-minimize'))
      expect(onMinimize).toHaveBeenCalledWith('conv-1', expect.any(String))
    })
    expect(screen.queryByText(/Discard conversation/i)).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('skips bootstrap when resumeConversationId is provided', async () => {
    const ws = makeFakeWs()
    render(
      <ExploreSpecShell
        initialIdea="resumed idea"
        pendingSpecId="pending-1"
        initialAttachmentIds={[]}
        resumeConversationId="conv-existing"
        onClose={onClose}
      />,
      { wrapper: wrap(ws) },
    )
    // No bootstrap turn fired
    await new Promise((r) => setTimeout(r, 20))
    expect(mockStartWithMessage).not.toHaveBeenCalled()
  })

  it('renders seedDraftTitle in the header when draft is empty (post-restore)', () => {
    const ws = makeFakeWs()
    render(
      <ExploreSpecShell
        initialIdea="dark mode"
        pendingSpecId="pending-1"
        initialAttachmentIds={[]}
        resumeConversationId="conv-prev"
        seedDraftTitle="Carry-over title"
        onClose={onClose}
      />,
      { wrapper: wrap(ws) },
    )
    expect(screen.getByText('Carry-over title')).toBeTruthy()
  })

  it('renders the Create Spec button in the header, disabled until a title exists', () => {
    const ws = makeFakeWs()
    render(
      <ExploreSpecShell
        initialIdea="dark mode"
        pendingSpecId="pending-1"
        initialAttachmentIds={[]}
        onClose={onClose}
      />,
      { wrapper: wrap(ws) },
    )
    const btn = screen.getByTestId('explore-spec-create')
    expect(btn).toBeTruthy()
    expect(btn).toBeDisabled()
  })

  it('minimize sends seedDraftTitle when draft.title is empty', () => {
    const ws = makeFakeWs()
    const onMinimize = vi.fn()
    render(
      <ExploreSpecShell
        initialIdea="dark mode"
        pendingSpecId="pending-1"
        initialAttachmentIds={[]}
        resumeConversationId="conv-prev"
        seedDraftTitle="Carry-over title"
        onClose={onClose}
        onMinimize={onMinimize}
      />,
      { wrapper: wrap(ws) },
    )
    fireEvent.click(screen.getByTestId('explore-spec-minimize'))
    expect(onMinimize).toHaveBeenCalledWith('conv-prev', 'Carry-over title')
  })
})
