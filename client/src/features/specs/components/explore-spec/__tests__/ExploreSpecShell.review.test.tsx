import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { ExploreSpecShell } from '../ExploreSpecShell'
import { SharedWebSocketContext } from '../../../../../hooks/useSharedWebSocket'

const mockStartWithMessage = vi.fn().mockResolvedValue('conv-review')
const mockSendMessage = vi.fn().mockResolvedValue(undefined)
const conversationsRef: {
  value: Array<{
    id: string; title: string | null; model: string;
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
    isStreaming: boolean; streamingText: string; commandProposals: string[]
  }>
} = { value: [] }

vi.mock('../../../../chat/hooks/useChat', () => ({
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

vi.mock('../../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ activeProjectId: 'proj-1', projects: [] }),
}))

vi.mock('../../../../../lib/api', () => ({
  getApiBase: () => '/api/projects/proj-1',
}))

vi.mock('../../../../chat/components/RichAttachmentEditor', () => ({
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

// Mock the spec-draft stream so we can inject a non-empty title and trigger
// the Review button visibility.
const draftStateRef: {
  value: {
    draft: {
      title: string
      description: string
      labels: string[]
      priority: 'low' | 'medium' | 'high' | 'critical' | null
      acceptanceCriteria: string[]
    }
    ready: boolean
    chips: string[]
    lastChangedFields: string[]
    setField: (k: string, v: unknown) => void
    clearManualOverrides: () => void
    resetForConversation: (id: string | null) => void
  }
} = {
  value: {
    draft: { title: '', description: '', labels: [], priority: null, acceptanceCriteria: [] },
    ready: false,
    chips: [],
    lastChangedFields: [],
    setField: vi.fn(),
    clearManualOverrides: vi.fn(),
    resetForConversation: vi.fn(),
  },
}

vi.mock('../../../hooks/useSpecDraftStream', () => ({
  useSpecDraftStream: () => draftStateRef.value,
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

function setDraftTitle(title: string) {
  draftStateRef.value = {
    ...draftStateRef.value,
    draft: { ...draftStateRef.value.draft, title },
  }
}

describe('ExploreSpecShell — Review overlay wiring', () => {
  let onClose: ReturnType<typeof vi.fn>
  let onTicketCreated: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onClose = vi.fn()
    onTicketCreated = vi.fn()
    conversationsRef.value = []
    mockStartWithMessage.mockClear()
    mockStartWithMessage.mockResolvedValue('conv-review')
    mockSendMessage.mockClear()
    setDraftTitle('')
  })

  afterEach(() => {
    setDraftTitle('')
  })

  it('hides the Review button when the draft title is empty', async () => {
    const ws = makeFakeWs()
    render(
      <ExploreSpecShell
        initialIdea="dark mode"
        pendingSpecId="pending-r1"
        initialAttachmentIds={[]}
        onClose={onClose}
        onTicketCreated={onTicketCreated}
      />,
      { wrapper: wrap(ws) },
    )
    await waitFor(() => {
      expect(mockStartWithMessage).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('explore-spec-review')).toBeNull()
  })

  it('shows the Review button when the draft title is non-empty', async () => {
    setDraftTitle('Add dark mode toggle')
    const ws = makeFakeWs()
    render(
      <ExploreSpecShell
        initialIdea="dark mode"
        pendingSpecId="pending-r2"
        initialAttachmentIds={[]}
        onClose={onClose}
        onTicketCreated={onTicketCreated}
      />,
      { wrapper: wrap(ws) },
    )
    await waitFor(() => {
      expect(screen.getByTestId('explore-spec-review')).toBeInTheDocument()
    })
  })

  it('opens the Review overlay when clicked and closes via Back-to-edit', async () => {
    setDraftTitle('Add dark mode toggle')
    const ws = makeFakeWs()
    render(
      <ExploreSpecShell
        initialIdea="dark mode"
        pendingSpecId="pending-r3"
        initialAttachmentIds={[]}
        onClose={onClose}
        onTicketCreated={onTicketCreated}
      />,
      { wrapper: wrap(ws) },
    )
    const reviewBtn = await screen.findByTestId('explore-spec-review')
    fireEvent.click(reviewBtn)
    expect(screen.getByTestId('explore-review-overlay')).toBeInTheDocument()
    // shell stays mounted underneath
    expect(screen.getByTestId('explore-spec-create')).toBeInTheDocument()
    // back closes the overlay without unmounting the shell
    fireEvent.click(screen.getByTestId('review-back'))
    expect(screen.queryByTestId('explore-review-overlay')).toBeNull()
    expect(screen.getByTestId('explore-spec-create')).toBeInTheDocument()
  })

  it('edit mode: opens Review with editTicket baseline and Update Spec label', async () => {
    setDraftTitle('Refined title')
    const ws = makeFakeWs()
    render(
      <ExploreSpecShell
        initialIdea="dark mode"
        pendingSpecId="pending-edit-1"
        initialAttachmentIds={[]}
        onClose={onClose}
        onTicketCreated={onTicketCreated}
        editTicket={{
          id: 7,
          title: 'Original title',
          description: 'Original body',
          labels: ['ui'],
          priority: 'medium',
          acceptanceCriteria: ['A'],
        }}
      />,
      { wrapper: wrap(ws) },
    )
    const reviewBtn = await screen.findByTestId('explore-spec-review')
    fireEvent.click(reviewBtn)
    expect(screen.getByTestId('explore-review-overlay')).toBeInTheDocument()
    expect(screen.getByTestId('review-commit')).toHaveTextContent('Update Spec')
  })

  it('edit mode: commit hits PATCH /tickets/:id instead of from-draft', async () => {
    setDraftTitle('Refined title')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: { id: 7, title: 'Refined title' } }),
    })
    const originalFetch = global.fetch
    global.fetch = fetchMock as unknown as typeof fetch

    const ws = makeFakeWs()
    render(
      <ExploreSpecShell
        initialIdea=""
        pendingSpecId="pending-edit-2"
        initialAttachmentIds={[]}
        onClose={onClose}
        onTicketCreated={onTicketCreated}
        editTicket={{
          id: 7,
          title: 'Original title',
          description: 'Original body',
          labels: ['ui'],
          priority: 'medium',
          acceptanceCriteria: ['A'],
        }}
      />,
      { wrapper: wrap(ws) },
    )
    const reviewBtn = await screen.findByTestId('explore-spec-review')
    fireEvent.click(reviewBtn)
    fireEvent.click(screen.getByTestId('review-commit'))
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([url, opts]) =>
        String(url).includes('/tickets/7') && (opts as RequestInit | undefined)?.method === 'PATCH',
      )
      expect(patchCall).toBeDefined()
      const fromDraftCall = fetchMock.mock.calls.find(([url, opts]) =>
        String(url).endsWith('/tickets/from-draft') && (opts as RequestInit | undefined)?.method === 'POST',
      )
      expect(fromDraftCall).toBeUndefined()
    })

    global.fetch = originalFetch
  })

  it('commits via Create Spec from inside the overlay', async () => {
    setDraftTitle('Add dark mode toggle')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: { id: 99, title: 'Add dark mode toggle' } }),
    })
    const originalFetch = global.fetch
    global.fetch = fetchMock as unknown as typeof fetch

    const ws = makeFakeWs()
    render(
      <ExploreSpecShell
        initialIdea="dark mode"
        pendingSpecId="pending-r4"
        initialAttachmentIds={[]}
        onClose={onClose}
        onTicketCreated={onTicketCreated}
      />,
      { wrapper: wrap(ws) },
    )
    const reviewBtn = await screen.findByTestId('explore-spec-review')
    fireEvent.click(reviewBtn)
    fireEvent.click(screen.getByTestId('review-commit'))

    await waitFor(() => {
      const calls = fetchMock.mock.calls
      const fromDraft = calls.find(([url, opts]) =>
        String(url).endsWith('/tickets/from-draft') && (opts as RequestInit | undefined)?.method === 'POST',
      )
      expect(fromDraft).toBeDefined()
    })

    global.fetch = originalFetch
  })
})
