import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { ExploreSpecShell } from '../ExploreSpecShell'
import { SharedWebSocketContext } from '../../../../../hooks/useSharedWebSocket'

const mockStartWithMessage = vi.fn().mockResolvedValue('conv-sad')
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
    draft: { title: 'A draft title', description: 'desc', labels: ['l'], priority: 'medium', acceptanceCriteria: [] },
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

describe('ExploreSpecShell — Save as Draft body shape', () => {
  let onClose: ReturnType<typeof vi.fn>
  let originalFetch: typeof fetch

  beforeEach(() => {
    onClose = vi.fn()
    conversationsRef.value = [{
      id: 'conv-sad',
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
    mockStartWithMessage.mockResolvedValue('conv-sad')
    mockSendMessage.mockClear()
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  async function clickSaveAsDraftAndCaptureBody(opts: {
    editTicket?: { id: number; title: string; description: string; labels: string[]; priority: 'low' | 'medium' | 'high' | 'critical'; acceptanceCriteria: string[] }
  }): Promise<Record<string, unknown>> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: { id: opts.editTicket?.id ?? 99, title: 'A draft title' } }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const ws = makeFakeWs()
    render(
      <ExploreSpecShell
        initialIdea="x"
        pendingSpecId="pending-sad"
        initialAttachmentIds={[]}
        onClose={onClose}
        editTicket={opts.editTicket}
        resumeConversationId="conv-sad"
      />,
      { wrapper: wrap(ws) },
    )
    const saveBtn = await screen.findByTestId('explore-spec-save-draft')
    await waitFor(() => expect(saveBtn).not.toBeDisabled())
    fireEvent.click(saveBtn)

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/tickets/save-as-draft'))
      expect(call).toBeDefined()
    })
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/tickets/save-as-draft'))!
    const init = call[1] as RequestInit
    return JSON.parse(init.body as string) as Record<string, unknown>
  }

  it('includes editTicketId when the shell is mounted in edit mode', async () => {
    const body = await clickSaveAsDraftAndCaptureBody({
      editTicket: {
        id: 42,
        title: 'Original',
        description: 'Original body',
        labels: ['ui'],
        priority: 'high',
        acceptanceCriteria: ['A'],
      },
    })
    expect(body).toHaveProperty('editTicketId', 42)
    expect(body).toHaveProperty('conversationId', 'conv-sad')
  })

  it('omits editTicketId when the shell is mounted without editTicket', async () => {
    const body = await clickSaveAsDraftAndCaptureBody({})
    expect(body).not.toHaveProperty('editTicketId')
    expect(body).toHaveProperty('conversationId', 'conv-sad')
  })
})
