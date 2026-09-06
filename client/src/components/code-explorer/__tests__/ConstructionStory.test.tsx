import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConstructionStory, type StoryEntry } from '../ConstructionStory'
import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'

const desktopState = vi.hoisted(() => ({ provider: 'claude' }))

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

function entry(overrides: Partial<StoryEntry> = {}): StoryEntry {
  return {
    provenanceId: 1,
    jobId: 'run-abcdef123456',
    ticketId: 7,
    kind: 'created',
    at: 1719900000000,
    addedLines: 12,
    removedLines: 3,
    hasPatch: true,
    summary: null,
    summaryModel: null,
    summaryGeneratedAt: null,
    ticket: { id: 7, title: 'Login screen', status: 'done' },
    ...overrides,
  }
}

function mockStoryFetch(story: StoryEntry[]) {
  return vi.fn((url: RequestInfo | URL) => {
    if (String(url).includes('/code/file/story')) {
      return Promise.resolve({ ok: true, json: async () => ({ story }) })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

beforeEach(() => {
  handlers.clear()
  desktopState.provider = 'claude'
})

describe('ConstructionStory', () => {
  it('renders the empty state when no interventions exist', async () => {
    global.fetch = mockStoryFetch([]) as never
    render(wrap(<ConstructionStory relPath="src/a.ts" height={200} onOpenTicket={vi.fn()} />))
    await waitFor(() => expect(screen.getByTestId('story-empty')).toBeInTheDocument())
  })

  it('renders a load-failed state on fetch error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as never
    render(wrap(<ConstructionStory relPath="src/a.ts" height={200} onOpenTicket={vi.fn()} />))
    await waitFor(() => expect(screen.getByTestId('story-failed')).toBeInTheDocument())
  })

  it('renders a card with spec chip, status pill, line stats, and the AI contribution', async () => {
    global.fetch = mockStoryFetch([
      entry({ summary: 'This change created the login form.', summaryModel: 'claude-haiku-4-5' }),
    ]) as never
    const onOpenTicket = vi.fn()
    render(wrap(<ConstructionStory relPath="src/a.ts" height={200} onOpenTicket={onOpenTicket} />))

    await waitFor(() => expect(screen.getByTestId('story-card')).toBeInTheDocument())
    expect(screen.getByTestId('story-contribution')).toHaveTextContent('This change created the login form.')
    expect(screen.getByText('Explained by claude-haiku-4-5')).toBeInTheDocument()
    expect(screen.getByText('+12')).toBeInTheDocument()
    expect(screen.getByText('−3')).toBeInTheDocument()
    expect(screen.getByTestId('story-status-pill')).toHaveTextContent('done')
    // No Explain button once a contribution exists.
    expect(screen.queryByTestId('story-explain')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('#7 · Login screen'))
    expect(onOpenTicket).toHaveBeenCalledWith(7)
  })

  it('renders the honest fallback (kind + spec) when no summary exists', async () => {
    global.fetch = mockStoryFetch([entry({ kind: 'modified' })]) as never
    render(wrap(<ConstructionStory relPath="src/a.ts" height={200} onOpenTicket={vi.fn()} />))
    await waitFor(() => expect(screen.getByTestId('story-fallback')).toBeInTheDocument())
    expect(screen.getByTestId('story-fallback')).toHaveTextContent('This file was modified while implementing this spec.')
    expect(screen.getByTestId('story-explain')).toBeInTheDocument()
  })

  it('keeps the deterministic Kimi story but hides AI Explain with a reason', async () => {
    desktopState.provider = 'kimi'
    const fetchMock = mockStoryFetch([entry({ kind: 'modified' })])
    global.fetch = fetchMock as never

    render(wrap(
      <ConstructionStory
        relPath="src/a.ts"
        height={200}
        onOpenTicket={vi.fn()}
      />,
    ))

    await waitFor(() => expect(screen.getByTestId('story-fallback')).toBeInTheDocument())
    expect(screen.queryByTestId('story-explain')).not.toBeInTheDocument()
    expect(screen.getByTestId('story-explain-unavailable')).toHaveTextContent(
      'AI explanation is unavailable because the selected provider cannot enforce safe pure-output mode.',
    )
    expect(fetchMock.mock.calls.filter(([, options]) =>
      (options as { method?: string } | undefined)?.method === 'POST',
    )).toHaveLength(0)
  })

  it('renders the spec-less fallback for interventions without a ticket', async () => {
    global.fetch = mockStoryFetch([entry({ ticketId: null, ticket: null, kind: 'deleted' })]) as never
    render(wrap(<ConstructionStory relPath="src/a.ts" height={200} onOpenTicket={vi.fn()} />))
    await waitFor(() => expect(screen.getByTestId('story-fallback')).toBeInTheDocument())
    expect(screen.getByTestId('story-fallback')).toHaveTextContent('This file was deleted by an AI job.')
    expect(screen.getByText('AI change without a spec')).toBeInTheDocument()
  })

  it('explain flow: POSTs, then refetches and shows the generated paragraph', async () => {
    let explained = false
    global.fetch = vi.fn((url: RequestInfo | URL, opts?: { method?: string; body?: string }) => {
      const u = String(url)
      if (u.includes('/story/explain')) {
        explained = true
        expect(JSON.parse(opts!.body!)).toEqual({ provenanceId: 1, overrideBudget: false })
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
      }
      if (u.includes('/code/file/story')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ story: [entry(explained ? { summary: 'Now explained.' } : {})] }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    }) as never

    render(wrap(<ConstructionStory relPath="src/a.ts" height={200} onOpenTicket={vi.fn()} />))
    await waitFor(() => expect(screen.getByTestId('story-explain')).toBeInTheDocument())
    await act(async () => { fireEvent.click(screen.getByTestId('story-explain')) })
    await waitFor(() => expect(screen.getByTestId('story-contribution')).toHaveTextContent('Now explained.'))
  })

  it('budget skip surfaces the inline override, which resends with overrideBudget', async () => {
    const bodies: string[] = []
    global.fetch = vi.fn((url: RequestInfo | URL, opts?: { method?: string; body?: string }) => {
      const u = String(url)
      if (u.includes('/story/explain')) {
        bodies.push(opts!.body!)
        const first = bodies.length === 1
        return Promise.resolve({
          ok: true,
          json: async () => (first ? { skipped: 'budget' } : { ok: true }),
        })
      }
      if (u.includes('/code/file/story')) {
        return Promise.resolve({ ok: true, json: async () => ({ story: [entry()] }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    }) as never

    render(wrap(<ConstructionStory relPath="src/a.ts" height={200} onOpenTicket={vi.fn()} />))
    await waitFor(() => expect(screen.getByTestId('story-explain')).toBeInTheDocument())
    await act(async () => { fireEvent.click(screen.getByTestId('story-explain')) })
    await waitFor(() => expect(screen.getByText('Generate anyway')).toBeInTheDocument())
    await act(async () => { fireEvent.click(screen.getByText('Generate anyway')) })
    expect(JSON.parse(bodies[0]).overrideBudget).toBe(false)
    expect(JSON.parse(bodies[1]).overrideBudget).toBe(true)
  })

  it('refetches on file.story_updated for this file and ignores other projects/paths', async () => {
    global.fetch = mockStoryFetch([entry()]) as never
    render(wrap(<ConstructionStory relPath="src/a.ts" height={200} onOpenTicket={vi.fn()} />))
    await waitFor(() => expect(screen.getByTestId('story-card')).toBeInTheDocument())

    const handler = Array.from(handlers.values())[0]
    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>
    fetchSpy.mockClear()

    act(() => { handler?.({ type: 'file.story_updated', projectId: 'other', path: 'src/a.ts' }) })
    act(() => { handler?.({ type: 'file.story_updated', projectId: 'p1', path: 'other.ts' }) })
    expect(fetchSpy).not.toHaveBeenCalled()

    act(() => { handler?.({ type: 'file.story_updated', projectId: 'p1', path: 'src/a.ts' }) })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
  })

  it('filters by job via the run id footer when onFilterJob is provided', async () => {
    global.fetch = mockStoryFetch([entry()]) as never
    const onFilterJob = vi.fn()
    render(wrap(<ConstructionStory relPath="src/a.ts" height={200} onOpenTicket={vi.fn()} onFilterJob={onFilterJob} />))
    await waitFor(() => expect(screen.getByText('run-abcdef12')).toBeInTheDocument())
    fireEvent.click(screen.getByText('run-abcdef12'))
    expect(onFilterJob).toHaveBeenCalledWith('run-abcdef123456')
  })
  it('never explains absent evidence, including an older cached paragraph', async () => {
    global.fetch = mockStoryFetch([entry({ hasPatch: false, summary: 'Legacy explanation', summaryStale: true, evidence: { kind: 'missing', truncated: false } })]) as never
    render(wrap(<ConstructionStory relPath="src/a.ts" height={200} onOpenTicket={vi.fn()} />))
    await screen.findByText('Legacy explanation')
    expect(screen.getByText('No patch evidence was stored for this change.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Refresh explanation' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('story-explain')).not.toBeInTheDocument()
  })

  it('preserves explanation evidence metadata and supports explicit stale refresh with a budget override', async () => {
    const bodies: unknown[] = []
    const onViewDiff = vi.fn()
    global.fetch = vi.fn(async (_url: RequestInfo | URL, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        bodies.push(JSON.parse(String(opts.body)))
        return { ok: true, json: async () => bodies.length === 1 ? { skipped: 'budget' } : { ok: true } } as Response
      }
      return { ok: true, json: async () => ({ story: [entry({ summary: 'Old explanation', summaryStale: true, summaryGeneratedAt: '2026-01-01T12:00:00.000Z', summaryModel: 'small-model', evidence: { kind: 'diff', truncated: false }, summaryEvidence: { kind: 'excerpt', truncated: true } })] }) } as Response
    })
    render(wrap(<ConstructionStory relPath="src/a.ts" height={200} onOpenTicket={vi.fn()} onViewDiff={onViewDiff} />))
    await screen.findByText('Old explanation')
    expect(screen.getByText('This explanation uses incomplete patch evidence.')).toBeInTheDocument()
    expect(screen.getByText('Explained by small-model')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View recorded change' }))
    expect(onViewDiff).toHaveBeenCalledWith('run-abcdef123456')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh explanation' }))
    await screen.findByRole('button', { name: 'Generate anyway' })
    fireEvent.click(screen.getByRole('button', { name: 'Generate anyway' }))
    await waitFor(() => expect(bodies).toEqual([
      { provenanceId: 1, overrideBudget: false, force: true },
      { provenanceId: 1, overrideBudget: true, force: true },
    ]))
  })

  it('aborts old explain work and never refetches its file after a path switch', async () => {
    let finish!: (response: Response) => void
    let signal: AbortSignal | undefined
    global.fetch = vi.fn((url: RequestInfo | URL, opts?: RequestInit) => {
      if (opts?.method === 'POST') { signal = opts.signal as AbortSignal; return new Promise<Response>((resolve) => { finish = resolve }) }
      const isB = String(url).includes('b.ts')
      return Promise.resolve({ ok: true, json: async () => ({ story: [entry(isB ? { summary: 'File B explanation' } : {})] }) } as Response)
    })
    const { rerender } = render(wrap(<ConstructionStory relPath="a.ts" height={200} onOpenTicket={vi.fn()} />))
    fireEvent.click(await screen.findByTestId('story-explain'))
    rerender(wrap(<ConstructionStory relPath="b.ts" height={200} onOpenTicket={vi.fn()} />))
    expect(signal?.aborted).toBe(true)
    await screen.findByText('File B explanation')
    await act(async () => finish({ ok: true, json: async () => ({ ok: true }) } as Response))
    expect(screen.getByText('File B explanation')).toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/story?path=a.ts'))).toHaveLength(1)
  })

  it('keeps simultaneous main and mission stories subscribed independently', async () => {
    global.fetch = mockStoryFetch([entry()]) as never
    const { rerender } = render(wrap(<><ConstructionStory key="main" relPath="src/a.ts" height={200} onOpenTicket={vi.fn()} /><ConstructionStory key="mission" relPath="src/a.ts" height={200} onOpenTicket={vi.fn()} /></>))
    await waitFor(() => expect(screen.getAllByTestId('story-card')).toHaveLength(2))
    expect(handlers.size).toBe(2)
    rerender(wrap(<ConstructionStory key="mission" relPath="src/a.ts" height={200} onOpenTicket={vi.fn()} />))
    expect(handlers.size).toBe(1)
    vi.mocked(fetch).mockClear()
    act(() => { for (const handler of handlers.values()) handler({ type: 'file.provenance_updated', projectId: 'p1', path: 'src/a.ts' }) })
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  })

})
