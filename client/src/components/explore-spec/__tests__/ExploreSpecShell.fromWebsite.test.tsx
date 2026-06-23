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

// Editor mock that renders footerExtra (the Globe button lives there) and lets a
// test drive plain text. getAttachmentIds returns [] so any ids sent come purely
// from the "From a website" captures.
vi.mock('../../RichAttachmentEditor', () => ({
  RichAttachmentEditor: React.forwardRef(function MockEditor(
    props: { placeholder?: string; ariaLabel?: string; onChange?: () => void; onSubmit?: () => void; footerExtra?: React.ReactNode },
    ref: React.Ref<unknown>,
  ) {
    const inputRef = React.useRef<HTMLTextAreaElement>(null)
    React.useImperativeHandle(ref, () => ({
      getPlainText: () => inputRef.current?.value ?? '',
      getAttachmentIds: () => [],
      insertPill: () => {},
      focus: () => {},
      resetHeight: () => {},
      clear: () => { if (inputRef.current) inputRef.current.value = '' },
      setPlainText: () => {},
    }))
    return (
      <div>
        <textarea
          ref={inputRef}
          aria-label={props.ariaLabel}
          placeholder={props.placeholder}
          onChange={() => props.onChange?.()}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) props.onSubmit?.() }}
        />
        {props.footerExtra}
      </div>
    )
  }),
}))

// Mock the heavy headless-Chromium modal: expose a button that fires onCaptured
// with a deterministic capture (screenshot + DOM attachments).
vi.mock('../../browser-capture/BrowserCaptureModal', () => ({
  BrowserCaptureModal: ({ onCaptured, onClose }: { onCaptured: (r: unknown) => void; onClose: () => void }) => (
    <div data-testid="mock-capture-modal">
      <button
        data-testid="mock-do-capture"
        onClick={() => onCaptured({
          screenshot: { id: 'shot-1', filename: 'screen-capture.png', storedName: 's', mimeType: 'image/png', size: 10, addedAt: '' },
          domAttachment: { id: 'dom-1', filename: 'dom.json', storedName: 'd', mimeType: 'application/json', size: 5, addedAt: '' },
          dom: { url: 'https://example.com', title: 'Example', viewport: { width: 1280, height: 800 }, rect: { x: 0, y: 0, width: 100, height: 100 }, html: '<div></div>', htmlTruncated: false, css: '', cssTruncated: false, nodes: [], capturedAt: '' },
          screenshotDataUrl: 'data:image/png;base64,AAAA',
        })}
      >
        capture
      </button>
      <button data-testid="mock-close-capture" onClick={onClose}>close</button>
    </div>
  ),
}))

vi.mock('../../browser-capture/CapturedDomPanel', () => ({
  CapturedDomPanel: ({ onRemove }: { onRemove?: () => void }) => (
    <button data-testid="mock-remove-capture" onClick={onRemove}>remove</button>
  ),
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

function readyConversation() {
  conversationsRef.value = [{
    id: 'conv-1', title: null, model: 'sonnet',
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }],
    isStreaming: false, streamingText: '', commandProposals: [],
  }]
}

function streamingConversation() {
  conversationsRef.value = [{
    id: 'conv-1', title: null, model: 'sonnet',
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }],
    isStreaming: true, streamingText: '…', commandProposals: [],
  }]
}

describe('ExploreSpecShell — From a website', () => {
  let onClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onClose = vi.fn()
    conversationsRef.value = []
    mockStartWithMessage.mockClear()
    mockStartWithMessage.mockResolvedValue('conv-1')
    mockSendMessage.mockClear()
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ attachments: [] }) }) as unknown as typeof fetch
  })

  it('renders the From-a-website (Globe) button on the composer', async () => {
    const ws = makeFakeWs()
    readyConversation()
    render(<ExploreSpecShell initialIdea="hi" pendingSpecId="pending-1" initialAttachmentIds={[]} onClose={onClose} />, { wrapper: wrap(ws) })
    await screen.findByText('ok')
    expect(screen.getByTestId('explore-from-browser-btn')).toBeInTheDocument()
  })

  it('auto-sends a feedback turn with the capture when the conversation is idle', async () => {
    const ws = makeFakeWs()
    readyConversation()
    render(<ExploreSpecShell initialIdea="hi" pendingSpecId="pending-1" initialAttachmentIds={[]} onClose={onClose} />, { wrapper: wrap(ws) })
    await screen.findByText('ok')

    fireEvent.click(screen.getByTestId('explore-from-browser-btn'))
    fireEvent.click(screen.getByTestId('mock-do-capture'))

    // The capture goes straight into the conversation as a feedback turn carrying
    // the screenshot + DOM attachment ids (no manual message needed).
    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(
        'conv-1',
        expect.stringContaining('feedback'),
        expect.objectContaining({ attachments: { ticketKey: 'pending-1', ids: ['shot-1', 'dom-1'] } }),
      )
    })
    // Auto-sent, so no pending chip is left behind.
    expect(screen.queryByTestId('explore-captured-dom-list')).not.toBeInTheDocument()
  })

  it('auto-send uses a real pendingSpecId even when launched with an empty one', async () => {
    const ws = makeFakeWs()
    readyConversation()
    render(<ExploreSpecShell initialIdea="hi" pendingSpecId="" initialAttachmentIds={[]} onClose={onClose} />, { wrapper: wrap(ws) })
    await screen.findByText('ok')

    fireEvent.click(screen.getByTestId('explore-from-browser-btn'))
    fireEvent.click(screen.getByTestId('mock-do-capture'))

    await waitFor(() => expect(mockSendMessage).toHaveBeenCalled())
    const opts = mockSendMessage.mock.calls[0][2] as { attachments?: { ticketKey: string; ids: string[] } }
    expect(opts.attachments?.ticketKey).toBeTruthy()
    expect(opts.attachments?.ticketKey).not.toBe('')
    expect(/^[A-Za-z0-9_-]{1,128}$/.test(opts.attachments!.ticketKey)).toBe(true)
  })

  it('queues the capture as a chip (rides the next turn) while a turn is streaming', async () => {
    const ws = makeFakeWs()
    streamingConversation()
    render(<ExploreSpecShell initialIdea="hi" pendingSpecId="pending-1" initialAttachmentIds={[]} onClose={onClose} />, { wrapper: wrap(ws) })
    await screen.findByText('ok')
    mockSendMessage.mockClear()

    fireEvent.click(screen.getByTestId('explore-from-browser-btn'))
    fireEvent.click(screen.getByTestId('mock-do-capture'))

    // Mid-stream we can't interrupt → the capture is queued as a chip, not auto-sent.
    expect(await screen.findByTestId('explore-captured-dom-list')).toBeInTheDocument()
    expect(screen.getByTestId('mock-remove-capture')).toBeInTheDocument()
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('removing a queued capture drops the chip and DELETEs its attachments', async () => {
    const ws = makeFakeWs()
    streamingConversation()
    render(<ExploreSpecShell initialIdea="hi" pendingSpecId="pending-1" initialAttachmentIds={[]} onClose={onClose} />, { wrapper: wrap(ws) })
    await screen.findByText('ok')

    fireEvent.click(screen.getByTestId('explore-from-browser-btn'))
    fireEvent.click(screen.getByTestId('mock-do-capture'))
    await screen.findByTestId('explore-captured-dom-list')

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockClear()
    fireEvent.click(screen.getByTestId('mock-remove-capture'))

    await waitFor(() => expect(screen.queryByTestId('explore-captured-dom-list')).not.toBeInTheDocument())
    const deletes = fetchMock.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'DELETE')
    expect(deletes.length).toBeGreaterThanOrEqual(2) // screenshot + dom attachments
  })
})
