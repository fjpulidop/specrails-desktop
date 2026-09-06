import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { ExploreSpecShell } from '../ExploreSpecShell'
import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'

// Regression coverage for the Continue-Editing-a-draft flow: a draft opened
// via Continue Editing must be PUBLISHABLE (flip draft → real spec) from the
// primary commit button, while a live spec keeps the in-place PATCH behaviour.

const mockStartWithMessage = vi.fn().mockResolvedValue('conv-pd')
const mockSendMessage = vi.fn().mockResolvedValue(undefined)
const conversationsRef: {
  value: Array<{
    id: string; title: string | null; model: string;
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
    isStreaming: boolean; streamingText: string; commandProposals: string[]
  }>
} = { value: [] }

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

const draftStateRef = {
  value: {
    draft: {
      title: 'A draft title',
      repositoryIds: ['primary-proj-1', 'api'],
      description: 'Problem body',
      labels: ['ui'],
      priority: 'medium' as const,
      acceptanceCriteria: ['Criterion A'],
    },
    ready: true,
    chips: [] as string[],
    lastChangedFields: [] as string[],
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

type EditTicket = {
  id: number
  title: string
  description: string
  labels: string[]
  priority: 'low' | 'medium' | 'high' | 'critical' | null
  acceptanceCriteria: string[]
  status?: 'draft' | 'todo' | 'in_progress' | 'done' | 'cancelled'
}

describe('ExploreSpecShell — publish vs update on Continue Editing', () => {
  let onClose: ReturnType<typeof vi.fn>
  let onTicketCreated: ReturnType<typeof vi.fn>
  let originalFetch: typeof fetch

  beforeEach(() => {
    onClose = vi.fn()
    onTicketCreated = vi.fn()
    conversationsRef.value = [{
      id: 'conv-pd',
      title: null,
      model: 'sonnet',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'reply' },
      ],
      isStreaming: false,
      streamingText: '',
      commandProposals: [],
    }]
    mockStartWithMessage.mockClear()
    mockSendMessage.mockClear()
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  function renderShell(editTicket?: EditTicket) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: { id: editTicket?.id ?? 99, title: 'A draft title' } }),
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const ws = makeFakeWs()
    render(
      <ExploreSpecShell
        initialIdea="x"
        pendingSpecId=""
        initialAttachmentIds={[]}
        onClose={onClose}
        onTicketCreated={onTicketCreated}
        editTicket={editTicket}
        resumeConversationId="conv-pd"
      />,
      { wrapper: wrap(ws) },
    )
    return fetchMock
  }

  it('draft edit: button reads "Update Spec" but commit still flips the draft via from-draft', async () => {
    const fetchMock = renderShell({
      id: 42,
      title: 'Saved draft',
      description: 'Problem body',
      labels: ['ui'],
      priority: 'medium',
      acceptanceCriteria: ['Criterion A'],
      status: 'draft',
    })

    const createBtn = await screen.findByTestId('explore-spec-create')
    // Editing an existing spec (draft included) reads "Update Spec" — the COMMIT
    // BEHAVIOUR (publish via from-draft) is unchanged, only the label.
    expect(createBtn).toHaveTextContent('Update Spec')
    expect(createBtn).not.toHaveTextContent('Create Spec')

    fireEvent.click(createBtn)

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, opts]) =>
        String(url).endsWith('/tickets/from-draft') && (opts as RequestInit | undefined)?.method === 'POST',
      )
      expect(call).toBeDefined()
    })
    const call = fetchMock.mock.calls.find(([url, opts]) =>
      String(url).endsWith('/tickets/from-draft') && (opts as RequestInit | undefined)?.method === 'POST',
    )!
    const body = JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body).toHaveProperty('draftTicketId', 42)
    expect(body.repositoryIds).toEqual(['primary-proj-1', 'api'])
    expect(body).toHaveProperty('title', 'A draft title')

    // Must NOT PATCH the ticket in place — that would leave it a draft.
    const patchCall = fetchMock.mock.calls.find(([url, opts]) =>
      String(url).includes('/tickets/42') && (opts as RequestInit | undefined)?.method === 'PATCH',
    )
    expect(patchCall).toBeUndefined()
    await waitFor(() => expect(onTicketCreated).toHaveBeenCalled())
  })

  it('live spec edit (status=todo): button reads "Update Spec" and commit PATCHes in place', async () => {
    const fetchMock = renderShell({
      id: 7,
      title: 'Live spec',
      description: 'Problem body',
      labels: ['ui'],
      priority: 'medium',
      acceptanceCriteria: ['Criterion A'],
      status: 'todo',
    })

    const createBtn = await screen.findByTestId('explore-spec-create')
    expect(createBtn).toHaveTextContent('Update Spec')

    fireEvent.click(createBtn)

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([url, opts]) =>
        String(url).includes('/tickets/7') && (opts as RequestInit | undefined)?.method === 'PATCH',
      )
      expect(patchCall).toBeDefined()
    })
    const fromDraft = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/tickets/from-draft'))
    expect(fromDraft).toBeUndefined()
  })

  it('draft edit still exposes Save as Draft to keep it a draft', async () => {
    renderShell({
      id: 42,
      title: 'Saved draft',
      description: 'Problem body',
      labels: ['ui'],
      priority: 'medium',
      acceptanceCriteria: ['Criterion A'],
      status: 'draft',
    })
    expect(await screen.findByTestId('explore-spec-save-draft')).toBeInTheDocument()
  })
})
