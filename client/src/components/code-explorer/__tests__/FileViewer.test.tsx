import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FileViewer, type SummaryAction } from '../FileViewer'
import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'

const desktopState = vi.hoisted(() => ({ provider: 'claude' }))

vi.mock('../CodeViewerMonaco', () => ({
  CodeViewerMonaco: ({ content }: { content: string }) => <div data-testid="monaco-stub">{content}</div>,
}))

vi.mock('../../../context/TicketDetailModalContext', () => ({
  useTicketDetailModal: () => ({ openTicketDetail: vi.fn() }),
}))

vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    activeProjectId: 'p1',
    projects: [{ id: 'p1', provider: desktopState.provider }],
  }),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))

const handlers = new Map<string, (m: unknown) => void>()
const fakeWs = {
  registerHandler: (id: string, fn: (m: unknown) => void) => { handlers.set(id, fn) },
  unregisterHandler: (id: string) => { handlers.delete(id) },
  connectionStatus: 'connected' as const,
}

function wrap(ui: React.ReactNode) {
  return <SharedWebSocketContext.Provider value={fakeWs}>{ui}</SharedWebSocketContext.Provider>
}

function captureSummaryAction() {
  let action: SummaryAction | null = null
  return {
    onChange: (next: SummaryAction | null) => { action = next },
    get: () => action,
  }
}

beforeEach(() => {
  handlers.clear()
  desktopState.provider = 'claude'
})

describe('FileViewer', () => {
  it('renders binary state and suppresses Monaco', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ binary: true, sizeBytes: 100, mime: 'image/png' }),
    }) as never
    const summaryAction = captureSummaryAction()
    render(wrap(<FileViewer relPath="img/x.png" onSummaryActionChange={summaryAction.onChange} />))
    await waitFor(() => {
      expect(screen.getByTestId('file-binary')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('monaco-stub')).not.toBeInTheDocument()
    expect(screen.getByText('Summary unavailable: binary file.')).toBeInTheDocument()
    await waitFor(() => expect(summaryAction.get()?.disabledReason).toBe('binary file'))
  })

  it('renders too-large state', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tooLarge: true, sizeBytes: 3 * 1024 * 1024 }),
    }) as never
    const summaryAction = captureSummaryAction()
    render(wrap(<FileViewer relPath="big.ts" onSummaryActionChange={summaryAction.onChange} />))
    await waitFor(() => {
      expect(screen.getByTestId('file-too-large')).toBeInTheDocument()
    })
    expect(screen.getByText('Summary unavailable: file too large.')).toBeInTheDocument()
    await waitFor(() => expect(summaryAction.get()?.disabledReason).toBe('file too large'))
  })

  it('renders content via Monaco stub, shows summary, and defaults the bottom panel to the Story view', async () => {
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      if (String(url).includes('/code/file/story')) {
        return Promise.resolve({ ok: true, json: async () => ({ story: [] }) })
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          content: 'export const x = 1',
          language: 'typescript',
          summary: { summary: 'Defines x.' },
          summaryStale: false,
          provenance: [{ path: 'src/x.ts', ticketId: 42, jobId: 'job-abcdef123456', kind: 'modified', at: 1000 }],
        }),
      })
    }) as never
    render(wrap(<FileViewer relPath="src/x.ts" />))
    await waitFor(() => {
      expect(screen.getByTestId('monaco-stub')).toBeInTheDocument()
    })
    expect(screen.getByText('Defines x.')).toBeInTheDocument()
    // Story is the DEFAULT bottom-panel mode (narrative-first).
    await waitFor(() => expect(screen.getByTestId('construction-story')).toBeInTheDocument())
    expect(screen.queryByTestId('file-provenance-timeline')).not.toBeInTheDocument()
    // Switch to the raw Log view → the classic provenance timeline.
    fireEvent.click(screen.getByText('Log'))
    expect(screen.getByTestId('file-provenance-timeline')).toBeInTheDocument()
    expect(screen.getByText('spec #42')).toBeInTheDocument()
    expect(screen.getByText('job-abcdef12')).toBeInTheDocument()
    expect(screen.queryByTestId('construction-story')).not.toBeInTheDocument()
    // Back to Story.
    fireEvent.click(screen.getByText('Story'))
    await waitFor(() => expect(screen.getByTestId('construction-story')).toBeInTheDocument())
  })

  it('edits a text file and saves it via PUT /code/file', async () => {
    const fetchMock = vi.fn((_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PUT') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, bytes: 18 }) })
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ content: 'export const x = 1', language: 'typescript', summary: null, summaryStale: false }),
      })
    })
    global.fetch = fetchMock as never
    render(wrap(<FileViewer relPath="src/x.ts" />))
    await waitFor(() => expect(screen.getByTestId('monaco-stub')).toBeInTheDocument())

    // Enter edit mode → Save/Cancel appear.
    fireEvent.click(screen.getByText('Edit'))
    expect(screen.getByText('Save')).toBeInTheDocument()
    expect(screen.getByText('Cancel')).toBeInTheDocument()

    // Save → PUTs the (unchanged-by-stub) draft to /code/file.
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })
    const putCall = fetchMock.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT')
    expect(putCall).toBeTruthy()
    expect(String(putCall![0])).toContain('/code/file')
    expect(JSON.parse((putCall![1] as { body: string }).body)).toEqual({ path: 'src/x.ts', content: 'export const x = 1' })
  })

  it('does not show the Edit affordance for a binary file', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ binary: true, sizeBytes: 100, mime: 'image/png' }),
    }) as never
    render(wrap(<FileViewer relPath="img/x.png" />))
    await waitFor(() => expect(screen.getByTestId('file-binary')).toBeInTheDocument())
    expect(screen.queryByText('Edit')).not.toBeInTheDocument()
  })

  it('regenerate flow prompts for budget override on skipped=budget', async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ content: '', language: 'plaintext', summary: null }) })
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ skipped: 'budget' }) })
    global.fetch = fetchMock as never
    const summaryAction = captureSummaryAction()
    render(wrap(<FileViewer relPath="src/a.ts" onSummaryActionChange={summaryAction.onChange} />))
    await waitFor(() => expect(summaryAction.get()?.hasSummary).toBe(false))
    await act(async () => { summaryAction.get()?.onClick() })
    await waitFor(() => {
      expect(screen.getByTestId('budget-prompt')).toBeInTheDocument()
    })
  })

  it('disables Kimi summary generation with an explanation and never POSTs', async () => {
    desktopState.provider = 'kimi'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: 'export const x = 1',
        language: 'typescript',
        summary: null,
        story: [],
      }),
    })
    global.fetch = fetchMock as never
    const summaryAction = captureSummaryAction()

    render(wrap(
      <FileViewer relPath="src/a.ts" onSummaryActionChange={summaryAction.onChange} />,
    ))

    await waitFor(() => {
      expect(summaryAction.get()?.disabledReason)
        .toBe('selected AI provider cannot enforce safe pure-output mode')
    })
    expect(screen.getByText(
      'Summary unavailable: selected AI provider cannot enforce safe pure-output mode.',
    )).toBeInTheDocument()

    await act(async () => { summaryAction.get()?.onClick() })
    expect(fetchMock.mock.calls.filter(([, options]) =>
      (options as { method?: string } | undefined)?.method === 'POST',
    )).toHaveLength(0)
  })

  it('ignores WS messages for other projects', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: 'x', language: 'plaintext', summary: null }),
    }) as never
    render(wrap(<FileViewer relPath="src/a.ts" />))
    await waitFor(() => screen.getByText('No summary for this file yet.'))
    const handler = Array.from(handlers.values())[0]
    expect(handler).toBeDefined()
    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>
    fetchSpy.mockClear()
    act(() => {
      handler?.({ type: 'file.summary_updated', projectId: 'other-project', path: 'src/a.ts' })
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('clears generating state when summary_updated arrives', async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ content: '', language: 'plaintext', summary: null }) })
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ enqueued: true }) })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: '',
        language: 'plaintext',
        summary: { summary: 'Fresh summary.' },
        summaryStale: false,
      }),
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: '',
        language: 'plaintext',
        summary: { summary: 'Fresh summary.' },
        summaryStale: false,
      }),
    })
    global.fetch = fetchMock as never
    const summaryAction = captureSummaryAction()
    render(wrap(<FileViewer relPath="src/a.ts" onSummaryActionChange={summaryAction.onChange} />))
    await waitFor(() => expect(summaryAction.get()?.hasSummary).toBe(false))
    await act(async () => { summaryAction.get()?.onClick() })
    const handler = Array.from(handlers.values())[0]
    act(() => {
      handler?.({ type: 'file.summary_updated', projectId: 'p1', path: 'src/a.ts' })
    })
    await waitFor(() => {
      expect(screen.getByText('Fresh summary.')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(summaryAction.get()?.hasSummary).toBe(true)
      expect(summaryAction.get()?.regenerating).toBe(false)
    })
  })
})
