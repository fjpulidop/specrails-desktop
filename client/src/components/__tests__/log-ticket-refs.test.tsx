import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// ── Mocks (same wiring precedent as agent-refs-chips.test) ───────────────────

// Mutable active-project state read lazily by the useDesktop mock.
const desktopState: { activeProjectId: string | null } = { activeProjectId: 'p1' }
vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [],
    activeProjectId: desktopState.activeProjectId,
    setActiveProjectId: vi.fn(),
  }),
}))

const openTicketDetailInProject = vi.fn()
vi.mock('../../context/TicketDetailModalContext', () => ({
  useTicketDetailModal: () => ({
    openTicketDetail: vi.fn(),
    openTicketDetailInProject,
    closeTicketDetail: vi.fn(),
    enterSplit: vi.fn(),
    setComparedTicket: vi.fn(),
    exitSplit: vi.fn(),
    setSplitRatio: vi.fn(),
    state: { leftId: null, rightId: null, originSide: null, splitRatio: 0.5 },
  }),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), success: vi.fn() }),
  Toaster: () => null,
}))

// Controllable markdown detection (real react-markdown renders the md path,
// so the remark plugin's code-block exclusion is actually exercised).
const mockHasMarkdownSyntax = vi.fn((_line: string) => false)
vi.mock('../../lib/markdown-detect', () => ({
  hasMarkdownSyntax: (line: string) => mockHasMarkdownSyntax(line),
}))

import { toast } from 'sonner'
import { LogViewer } from '../LogViewer'
import { LoopStepExplorer } from '../loop-log/LoopStepExplorer'
import { splitLogTicketSegments } from '../log-ticket-refs'
import type { EventRow } from '../../types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeLogEvent(line: string, id: number, source = 'stdout'): EventRow {
  return {
    id,
    job_id: 'job-1',
    seq: id,
    event_type: 'log',
    source,
    payload: JSON.stringify({ line }),
    timestamp: new Date().toISOString(),
  }
}

function makeLoopStepEvent(index: number, id: number): EventRow {
  return {
    id,
    job_id: 'job-1',
    seq: id,
    event_type: 'loop_step',
    source: 'stdout',
    payload: JSON.stringify({
      index,
      kind: 'ai-step',
      title: 'Implement',
      nodeId: 'n1',
      iteration: 1,
    }),
    timestamp: new Date().toISOString(),
  }
}

const okRes = { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }
const notFoundRes = { ok: false, status: 404, text: async () => '{}', json: async () => ({}) }

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  desktopState.activeProjectId = 'p1'
  mockHasMarkdownSyntax.mockImplementation(() => false)
  fetchMock = vi.fn(async () => okRes)
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── LogViewer — plain-line linkify matrix ─────────────────────────────────────

describe('LogViewer ticket refs (plain log lines)', () => {
  it('linkifies #N in a prose line as a quiet underline affordance', () => {
    render(<LogViewer events={[makeLogEvent('Implementing #3 — Add dark mode now', 1)]} />)
    const ref = screen.getByTestId('log-ticket-ref')
    expect(ref.textContent).toBe('#3 — Add dark mode now')
    expect(ref).toHaveAttribute('aria-label', expect.stringContaining('#3'))
  })

  it('keeps 🧑 user-echo lines linkified (they are prose)', () => {
    render(<LogViewer events={[makeLogEvent('🧑 please fix #9 quickly', 1)]} />)
    expect(screen.getByTestId('log-ticket-ref').textContent).toContain('#9')
  })

  it('board mode: click verifies against the ACTIVE project then opens the ticket modal', async () => {
    render(<LogViewer events={[makeLogEvent('done with #3', 1)]} />)
    fireEvent.click(screen.getByTestId('log-ticket-ref'))
    await waitFor(() => expect(openTicketDetailInProject).toHaveBeenCalledWith('p1', 3))
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/tickets/3')
  })

  it('mission mode: an explicit projectId wins over the active project', async () => {
    render(<LogViewer events={[makeLogEvent('done with #3', 1)]} projectId="p7" />)
    fireEvent.click(screen.getByTestId('log-ticket-ref'))
    await waitFor(() => expect(openTicketDetailInProject).toHaveBeenCalledWith('p7', 3))
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p7/tickets/3')
  })

  it('a deleted ticket surfaces the subtle not-found toast instead of a modal', async () => {
    fetchMock.mockImplementation(async () => notFoundRes)
    render(<LogViewer events={[makeLogEvent('done with #3', 1)]} />)
    fireEvent.click(screen.getByTestId('log-ticket-ref'))
    await waitFor(() => expect(toast.info).toHaveBeenCalled())
    expect(openTicketDetailInProject).not.toHaveBeenCalled()
  })

  it('renders refs as plain text when no project is resolvable', () => {
    desktopState.activeProjectId = null
    render(<LogViewer events={[makeLogEvent('done with #3', 1)]} />)
    expect(screen.queryByTestId('log-ticket-ref')).toBeNull()
    expect(screen.getByText(/done with #3/)).toBeInTheDocument()
  })

  it('never linkifies diff-styled lines (mirrors the code-exclusion philosophy)', () => {
    const events = [
      makeLogEvent('--- a/src/file.ts', 1),
      makeLogEvent('+++ b/src/file.ts', 2),
      makeLogEvent('@@ -1,5 +1,6 @@', 3),
      makeLogEvent('+added for #4', 4),
      makeLogEvent('-removed for #5', 5),
    ]
    render(<LogViewer events={events} />)
    expect(screen.queryAllByTestId('log-ticket-ref')).toHaveLength(0)
    expect(screen.getByText('+added for #4')).toBeInTheDocument()
  })

  it('never linkifies stderr lines (stack frames read `#1 0x…`)', () => {
    render(<LogViewer events={[makeLogEvent('#1 0x00007fff9 in main ()', 1, 'stderr')]} />)
    expect(screen.queryAllByTestId('log-ticket-ref')).toHaveLength(0)
  })

  it('scan boundaries: #0, mid-word x#3, and 7-digit ids stay plain', () => {
    render(<LogViewer events={[makeLogEvent('skip #0 and x#3 and #1234567 tokens', 1)]} />)
    expect(screen.queryAllByTestId('log-ticket-ref')).toHaveLength(0)
  })

  it('never linkifies job uuids in logs (empty job-context set — no modal-in-modal)', () => {
    const uuid = '85d6ab14-1111-4222-8333-444455556666'
    render(<LogViewer events={[makeLogEvent(`job ${uuid} finished #6 work`, 1)]} />)
    const refs = screen.getAllByTestId('log-ticket-ref')
    expect(refs).toHaveLength(1)
    expect(refs[0].textContent).toContain('#6')
  })
})

// ── LogViewer — markdown (assistant) lines ────────────────────────────────────

describe('LogViewer ticket refs (markdown assistant lines)', () => {
  beforeEach(() => {
    mockHasMarkdownSyntax.mockImplementation(() => true)
  })

  it('linkifies #N inside rendered markdown', async () => {
    render(<LogViewer events={[makeLogEvent('Shipped **the fix** for #6 today', 1)]} />)
    const ref = await screen.findByTestId('log-ticket-ref')
    expect(ref.textContent).toBe('#6')
    fireEvent.click(ref)
    await waitFor(() => expect(openTicketDetailInProject).toHaveBeenCalledWith('p1', 6))
  })

  it('excludes fenced code blocks and inline code', () => {
    const events = [
      makeLogEvent('```', 1),
      makeLogEvent('#7', 2),
      makeLogEvent('```', 3),
      makeLogEvent('Use `#8` inline', 4),
    ]
    render(<LogViewer events={events} />)
    expect(screen.queryAllByTestId('log-ticket-ref')).toHaveLength(0)
  })

  it('leaves normal markdown links as anchors alongside a ref', () => {
    render(<LogViewer events={[makeLogEvent('see [docs](https://example.com) and #6', 1)]} />)
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute(
      'href',
      'https://example.com',
    )
    expect(screen.getByTestId('log-ticket-ref').textContent).toBe('#6')
  })

  it('keeps markdown refs plain when no project is resolvable', () => {
    desktopState.activeProjectId = null
    render(<LogViewer events={[makeLogEvent('Shipped **the fix** for #6 today', 1)]} />)
    expect(screen.queryAllByTestId('log-ticket-ref')).toHaveLength(0)
  })
})

// ── Loop step explorer — step-box lines ───────────────────────────────────────

describe('LoopStepExplorer ticket refs (step-box lines)', () => {
  it('linkifies refs inside the expanded step box and opens with the DEFAULT (active) project', async () => {
    const events = [
      makeLogEvent('▶ Loop started', 1),
      makeLoopStepEvent(1, 2),
      makeLogEvent('working on #11 now', 3),
    ]
    render(<LoopStepExplorer events={events} jobStatus="running" />)
    const ref = screen.getByTestId('log-ticket-ref')
    expect(ref.textContent).toContain('#11')
    fireEvent.click(ref)
    await waitFor(() => expect(openTicketDetailInProject).toHaveBeenCalledWith('p1', 11))
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/tickets/11')
  })

  it('mission mode: threads the explicit projectId into step-box refs', async () => {
    const events = [makeLoopStepEvent(1, 1), makeLogEvent('resolves #12', 2)]
    render(<LoopStepExplorer events={events} jobStatus="running" projectId="p9" />)
    fireEvent.click(screen.getByTestId('log-ticket-ref'))
    await waitFor(() => expect(openTicketDetailInProject).toHaveBeenCalledWith('p9', 12))
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p9/tickets/12')
  })
})

// ── Performance pin ───────────────────────────────────────────────────────────

describe('linkify performance (8k-line fixture)', () => {
  it('the per-line regex scan stays trivially fast at 8k lines', () => {
    const lines: string[] = []
    for (let i = 0; i < 8000; i++) {
      lines.push(
        i % 10 === 0
          ? `progress on #${(i % 40) + 1} at step ${i}`
          : `[10:00:00] compiled module ${i} without issues`,
      )
    }
    const t0 = performance.now()
    let refs = 0
    for (const line of lines) {
      const segments = splitLogTicketSegments(line)
      if (segments) refs += segments.filter((s) => s.kind === 'ticket').length
    }
    const elapsed = performance.now() - t0
    expect(refs).toBe(800)
    // Real cost is single-digit ms — 500ms is a 50x+ regression tripwire.
    expect(elapsed).toBeLessThan(500)
  })

  it('renders a large mixed log with the expected refs (memoized per line)', () => {
    const events = Array.from({ length: 1200 }, (_, i) =>
      makeLogEvent(i % 20 === 0 ? `touching #${(i % 9) + 1}` : `line ${i}`, i + 1),
    )
    render(<LogViewer events={events} />)
    expect(screen.getAllByTestId('log-ticket-ref')).toHaveLength(60)
  })
})
