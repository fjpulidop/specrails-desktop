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
})
