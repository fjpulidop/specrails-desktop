import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FileViewer, type SummaryAction } from '../FileViewer'
import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'
import { CodeRepositoryContext } from '../CodeRepositoryContext'

const desktopState = vi.hoisted(() => ({ provider: 'claude' }))

vi.mock('../CodeViewerMonaco', () => ({
  CodeViewerMonaco: ({ content, initialLine }: { content: string; initialLine?: number }) => <div data-testid="monaco-stub" data-line={initialLine}>{content}</div>,
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
  it('loads the selected repository and ignores summary events from other repositories and legacy primary events', async () => {
    const base = '/api/projects/p1/repositories/api'
    global.fetch = vi.fn(async (url: RequestInfo | URL) => ({ ok: true, json: async () => String(url).includes('/story') ? { story: [] } : { content: 'API contents', language: 'typescript', provenance: [] } })) as never
    render(wrap(<CodeRepositoryContext.Provider value={{ apiBase: base, repositoryId: 'api', isPrimary: false }}><FileViewer relPath="src/index.ts" /></CodeRepositoryContext.Provider>))
    await screen.findByText('API contents')
    await act(async () => {})
    expect(fetch).toHaveBeenCalledWith(`${base}/code/file?path=src%2Findex.ts`, { signal: expect.any(AbortSignal) })
    vi.mocked(fetch).mockClear()
    act(() => { for (const handler of handlers.values()) {
      handler({ type: 'file.summary_updated', projectId: 'p1', path: 'src/index.ts' })
      handler({ type: 'file.summary_updated', projectId: 'p1', repositoryId: 'primary-p1', path: 'src/index.ts' })
      handler({ type: 'file.summary_updated', projectId: 'other-project', repositoryId: 'api', path: 'src/index.ts' })
    } })
    expect(fetch).not.toHaveBeenCalled()
    act(() => { for (const handler of handlers.values()) handler({ type: 'file.summary_updated', projectId: 'p1', repositoryId: 'api', path: 'src/index.ts' }) })
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`${base}/code/file?path=src%2Findex.ts`, { signal: expect.any(AbortSignal) }))
  })

  it('does not show a late response from the previous repository for the same relative file path', async () => {
    let finishPrimary!: (value: Response) => void
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      if (String(url).includes('/primary-p1/code/file?')) return new Promise<Response>((resolve) => { finishPrimary = resolve })
      return Promise.resolve({ ok: true, json: async () => String(url).includes('/story') ? { story: [] } : { content: 'API contents', language: 'typescript', provenance: [] } } as Response)
    })
    const tree = (id: string) => wrap(<CodeRepositoryContext.Provider value={{ apiBase: `/api/projects/p1/repositories/${id}`, repositoryId: id, isPrimary: id === 'primary-p1' }}><FileViewer relPath="src/index.ts" /></CodeRepositoryContext.Provider>)
    const { rerender } = render(tree('primary-p1'))
    rerender(tree('api'))
    await screen.findByText('API contents')
    await act(async () => finishPrimary({ ok: true, json: async () => ({ content: 'Old frontend contents', language: 'typescript', provenance: [] }) } as Response))
    expect(screen.queryByText('Old frontend contents')).not.toBeInTheDocument()
    expect(screen.getByText('API contents')).toBeInTheDocument()
  })

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

  it('keeps text files read-only and reveals the requested source line', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ content: 'export const x = 1', language: 'typescript', summary: null, story: [] }) })) as never
    const { rerender } = render(wrap(<FileViewer relPath="src/x.ts" initialLine={12} />))
    expect(await screen.findByTestId('monaco-stub')).toHaveAttribute('data-line', '12')
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    rerender(wrap(<FileViewer relPath="src/x.ts" initialLine={21} />))
    expect(screen.getByTestId('monaco-stub')).toHaveAttribute('data-line', '21')
    expect(vi.mocked(fetch).mock.calls.some(([, opts]) => opts?.method === 'PUT')).toBe(false)
  })

  it('aborts an old summary request and immediately clears its source when moving to another file', async () => {
    let finishSummary!: (response: Response) => void
    let finishB!: (response: Response) => void
    let summarySignal: AbortSignal | undefined
    global.fetch = vi.fn((url: RequestInfo | URL, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        summarySignal = opts.signal as AbortSignal
        return new Promise<Response>((resolve) => { finishSummary = resolve })
      }
      if (String(url).includes('/story')) return Promise.resolve({ ok: true, json: async () => ({ story: [] }) } as Response)
      if (String(url).includes('b.ts')) return new Promise<Response>((resolve) => { finishB = resolve })
      return Promise.resolve({ ok: true, json: async () => ({ content: 'source A', language: 'typescript' }) } as Response)
    })
    const summaryAction = captureSummaryAction()
    const { rerender } = render(wrap(<FileViewer relPath="a.ts" onSummaryActionChange={summaryAction.onChange} />))
    await screen.findByText('source A')
    act(() => { void summaryAction.get()?.onClick() })
    expect(finishSummary).toBeTypeOf('function')
    rerender(wrap(<FileViewer relPath="b.ts" onSummaryActionChange={summaryAction.onChange} />))
    expect(screen.queryByText('source A')).not.toBeInTheDocument()
    expect(summarySignal?.aborted).toBe(true)
    await act(async () => finishB({ ok: true, json: async () => ({ content: 'source B', language: 'typescript' }) } as Response))
    await act(async () => finishSummary({ ok: true, json: async () => ({ ok: true }) } as Response))
    expect(screen.getByText('source B')).toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/code/file?path=a.ts'))).toHaveLength(1)
  })

  it('refreshes source on provenance changes and retains the last successful read after refresh failure', async () => {
    let version = 'source before'
    let fails = false
    global.fetch = vi.fn(async (url: RequestInfo | URL) => ({ ok: !fails, json: async () => String(url).includes('/story') ? { story: [] } : { content: version, language: 'typescript' } })) as never
    render(wrap(<FileViewer relPath="a.ts" />))
    await screen.findByText('source before')
    version = 'source after'
    act(() => { for (const handler of handlers.values()) handler({ type: 'file.provenance_updated', projectId: 'p1', path: 'a.ts' }) })
    await screen.findByText('source after')
    fails = true
    fireEvent.click(screen.getByRole('button', { name: 'Refresh source' }))
    await screen.findByRole('alert')
    expect(screen.getByText('source after')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('opens historical patches independently of the current source and resets a changed run immediately', async () => {
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      if (String(url).includes('/code/diff')) return Promise.resolve({ ok: true, json: async () => ({ patch: '@@ -1 +1 @@\n-old\n+' + (String(url).includes('second') ? 'second patch' : 'first patch'), truncated: false }) } as Response)
      if (String(url).includes('/story')) return Promise.resolve({ ok: true, json: async () => ({ story: [] }) } as Response)
      return new Promise<Response>(() => {})
    })
    const { rerender } = render(wrap(<FileViewer relPath="deleted.ts" initialJobId="first" />))
    await screen.findByText('+first patch')
    expect(screen.queryByTestId('monaco-stub')).not.toBeInTheDocument()
    rerender(wrap(<FileViewer relPath="deleted.ts" initialJobId="second" />))
    expect(screen.queryByText('+first patch')).not.toBeInTheDocument()
    await screen.findByText('+second patch')
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
  it('keeps simultaneous source viewers subscribed when one closes', async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => ({ ok: true, json: async () => String(url).includes('/story') ? { story: [] } : { content: 'shared source', language: 'typescript' } })) as never
    const { rerender } = render(wrap(<><FileViewer key="main" relPath="same.ts" /><FileViewer key="mission" relPath="same.ts" /></>))
    await waitFor(() => expect(screen.getAllByText('shared source')).toHaveLength(2))
    const sourceHandlers = () => [...handlers].filter(([key]) => key.startsWith('code-file-'))
    expect(sourceHandlers()).toHaveLength(2)
    rerender(wrap(<FileViewer key="mission" relPath="same.ts" />))
    expect(sourceHandlers()).toHaveLength(1)
    vi.mocked(fetch).mockClear()
    act(() => { for (const [, handler] of sourceHandlers()) handler({ type: 'file.provenance_updated', projectId: 'p1', path: 'same.ts' }) })
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/code/file?'))).toHaveLength(1))
  })

  it('defaults compact history to collapsed independently of wide preferences and remembers explicit toggles', async () => {
    localStorage.removeItem('specrails-desktop:code-history-collapsed:p1:compact')
    localStorage.setItem('specrails-desktop:code-history-collapsed:p1', 'false')
    global.fetch = vi.fn(async (url: RequestInfo | URL) => ({ ok: true, json: async () => String(url).includes('/story') ? { story: [] } : { content: 'compact source', language: 'typescript', provenance: [{ path: 'a.ts', jobId: 'run-1', ticketId: 1, kind: 'modified', at: 1000 }] } })) as never
    const { rerender, unmount } = render(wrap(<FileViewer relPath="a.ts" compact />))
    await screen.findByText('compact source')
    expect(screen.queryByTestId('construction-story')).not.toBeInTheDocument()
    fireEvent.click(within(screen.getByTestId('code-history-resizer')).getByRole('button', { name: 'Show' }))
    await screen.findByTestId('construction-story')
    expect(localStorage.getItem('specrails-desktop:code-history-collapsed:p1:compact')).toBe('false')
    rerender(wrap(<FileViewer relPath="b.ts" compact />))
    await screen.findByTestId('construction-story')
    fireEvent.click(within(screen.getByTestId('code-history-resizer')).getByRole('button', { name: 'Hide' }))
    expect(screen.queryByTestId('construction-story')).not.toBeInTheDocument()
    rerender(wrap(<FileViewer relPath="b.ts" compact={false} />))
    await screen.findByTestId('construction-story')
    expect(localStorage.getItem('specrails-desktop:code-history-collapsed:p1')).toBe('false')
    unmount()
    localStorage.removeItem('specrails-desktop:code-history-collapsed:p1:compact')
    localStorage.removeItem('specrails-desktop:code-history-collapsed:p1')
  })

})
