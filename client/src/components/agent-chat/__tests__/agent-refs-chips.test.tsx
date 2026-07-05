import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, renderHook, act } from '@testing-library/react'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../../context/WebViewModalContext', () => ({
  useWebViewModal: () => ({ openWebView: vi.fn(), canOpenWebView: false }),
}))

const projects = [
  { id: 'p1', name: 'acme-api', slug: 'acme-api', path: '/acme', provider: 'claude' },
]
vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects, activeProjectId: 'p1', setActiveProjectId: vi.fn() }),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), success: vi.fn() }),
  Toaster: () => null,
}))

// The ticket path goes through the app-root ticket modal provider — spy on it.
const openTicketDetailInProject = vi.fn()
vi.mock('../../../context/TicketDetailModalContext', () => ({
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

import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { toast } from 'sonner'
import { AgentMessage } from '../AgentMessage'
import { AgentPrDecisionCard } from '../AgentPrDecisionCard'
import type { AgentPrDecisionEnvelope } from '../../../lib/agent-api'
import type { AgentRefTarget } from '../../../lib/agent-refs'
import { useAgentRefActions } from '../../../hooks/useAgentRefActions'
import { LoopPreviewModal } from '../../loops/LoopPreviewModal'

const UUID = '85d6ab14-1111-4222-8333-444455556666'

const okRes = { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }
const notFoundRes = { ok: false, status: 404, text: async () => '{}', json: async () => ({}) }

beforeEach(() => {
  vi.clearAllMocks()
})

// ── AgentMessage ref chips ────────────────────────────────────────────────────

describe('AgentMessage ref chips (settled, pinned project)', () => {
  const onOpenRef = vi.fn()
  const renderMsg = (content: string, over: Partial<Parameters<typeof AgentMessage>[0]> = {}) =>
    render(
      <AgentMessage
        role="assistant"
        content={content}
        refsProjectId="p1"
        onOpenRef={onOpenRef}
        {...over}
      />,
    )

  it('renders a ticket ref as a clickable chip and reports the right target', () => {
    renderMsg('Moved #3 — Add dark mode to done')
    const chip = screen.getByTestId('agent-ref-chip')
    expect(chip).toHaveAttribute('data-ref-kind', 'ticket')
    expect(chip.textContent).toContain('#3 — Add dark mode')
    fireEvent.click(chip)
    expect(onOpenRef).toHaveBeenCalledWith({ kind: 'ticket', ticketId: 3 })
  })

  it('renders a context-gated job uuid as a job chip', () => {
    renderMsg(`Job lanzado: ${UUID}`)
    const chip = screen.getByTestId('agent-ref-chip')
    expect(chip).toHaveAttribute('data-ref-kind', 'job')
    expect(chip.textContent).toContain('85d6ab14…')
    fireEvent.click(chip)
    expect(onOpenRef).toHaveBeenCalledWith({ kind: 'job', jobId: UUID })
  })

  it('does NOT linkify a uuid without job/run/loop context on its line', () => {
    renderMsg(`conversation id: ${UUID}`)
    expect(screen.queryByTestId('agent-ref-chip')).toBeNull()
  })

  it('skips refs inside fenced code blocks and inline code', () => {
    renderMsg('```\n#3\n```\n\nUse `#4` here')
    expect(screen.queryByTestId('agent-ref-chip')).toBeNull()
  })

  it('keeps refs plain when no project is pinned (Home conversations)', () => {
    render(<AgentMessage role="assistant" content="see #3" refsProjectId={null} onOpenRef={onOpenRef} />)
    expect(screen.queryByTestId('agent-ref-chip')).toBeNull()
    expect(screen.getByText(/see #3/)).toBeInTheDocument()
  })

  it('never linkifies the live streaming buffer', () => {
    render(
      <AgentMessage
        role="assistant"
        content={`streaming #3 and run ${UUID}`}
        streaming
        refsProjectId="p1"
        onOpenRef={onOpenRef}
      />,
    )
    expect(screen.queryByTestId('agent-ref-chip')).toBeNull()
  })

  it('leaves normal markdown links as anchors', () => {
    renderMsg('see [docs](https://example.com) and #3')
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute('href', 'https://example.com')
    expect(screen.getByTestId('agent-ref-chip')).toHaveAttribute('data-ref-kind', 'ticket')
  })
})

// ── AgentPrDecisionCard ticket chips ─────────────────────────────────────────

const envelope = (over: Partial<AgentPrDecisionEnvelope> = {}): AgentPrDecisionEnvelope => ({
  kind: 'pr_decision',
  prDeliveryId: 'd1',
  railIndex: 0,
  projectId: 'p1',
  baseBranch: 'main',
  ticketIds: [4, 7],
  decision: 'on_review',
  prUrl: null,
  prState: 'none',
  branch: null,
  runIds: [],
  ...over,
})

describe('AgentPrDecisionCard ticket chips', () => {
  it('renders one clickable #N chip per ticket id', () => {
    render(<AgentPrDecisionCard envelope={envelope()} />)
    const chips = screen.getAllByTestId('agent-ref-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0].textContent).toContain('#4')
    expect(chips[1].textContent).toContain('#7')
  })

  it('shows the chips already on the building card', () => {
    render(<AgentPrDecisionCard envelope={envelope({ decision: 'building' })} />)
    expect(screen.getAllByTestId('agent-ref-chip')).toHaveLength(2)
  })

  it("clicking a chip verifies against the CARD's project then opens the ticket modal", async () => {
    const fetchMock = vi.fn(async () => okRes)
    vi.stubGlobal('fetch', fetchMock)
    render(<AgentPrDecisionCard envelope={envelope({ projectId: 'p2' })} />)
    fireEvent.click(screen.getAllByTestId('agent-ref-chip')[0])
    await waitFor(() => expect(openTicketDetailInProject).toHaveBeenCalledWith('p2', 4))
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p2/tickets/4')
    vi.unstubAllGlobals()
  })

  it('a deleted ticket surfaces the subtle not-found toast instead of a modal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => notFoundRes))
    render(<AgentPrDecisionCard envelope={envelope()} />)
    fireEvent.click(screen.getAllByTestId('agent-ref-chip')[0])
    await waitFor(() => expect(toast.info).toHaveBeenCalled())
    expect(openTicketDetailInProject).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

// ── useAgentRefActions ↔ AgentMessage integration (job modal handoff) ────────

function Harness({ content }: { content: string }) {
  // Inline mini-consumer replicating AgentConversationView's wiring.
  const [jobRef, setJobRef] = useState<{ projectId: string; jobId: string } | null>(null)
  const onOpenRef = (ref: AgentRefTarget) => {
    if (ref.kind === 'job') setJobRef({ projectId: 'p9', jobId: ref.jobId })
  }
  return (
    <div>
      <AgentMessage role="assistant" content={content} refsProjectId="p9" onOpenRef={onOpenRef} />
      {jobRef && <div data-testid="job-modal-mounted">{jobRef.projectId}:{jobRef.jobId}</div>}
    </div>
  )
}

describe('job chip → JobDetailModal handoff carries the pinned project', () => {
  it('threads the pinned projectId, never the active one', () => {
    render(<Harness content={`loop run ${UUID} settled`} />)
    fireEvent.click(screen.getByTestId('agent-ref-chip'))
    expect(screen.getByTestId('job-modal-mounted').textContent).toBe(`p9:${UUID}`)
  })
})

// ── Loop refs (factory ids + uuid fallback) ───────────────────────────────────

describe('loop ref chips + resolution', () => {
  const onOpenRef = vi.fn()

  it('renders factory:implement as a loop chip and reports the loop target', () => {
    render(
      <AgentMessage
        role="assistant"
        content="Lo lanzo con el loop factory:implement en el rail 2"
        refsProjectId="p1"
        onOpenRef={onOpenRef}
      />,
    )
    const chip = screen.getByTestId('agent-ref-chip')
    expect(chip).toHaveAttribute('data-ref-kind', 'loop')
    expect(chip.textContent).toContain('factory:implement')
    fireEvent.click(chip)
    expect(onOpenRef).toHaveBeenCalledWith({ kind: 'loop', loopId: 'factory:implement' })
  })

  const graph = { nodes: [], edges: [], config: { maxIterations: 3, timeoutMinutes: 30 } }

  it('openRef(loop factory id) resolves via /api/loops/factory and exposes loopRef', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/loops/factory') {
        return { ok: true, status: 200, json: async () => ({ loops: [{ id: 'factory:implement', name: 'Implement', description: 'd', graph }] }) }
      }
      return notFoundRes
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAgentRefActions())
    await act(async () => { await result.current.openRef('p1', { kind: 'loop', loopId: 'factory:implement' }) })
    expect(result.current.loopRef).toMatchObject({ id: 'factory:implement', name: 'Implement', locked: true, status: null })
    act(() => result.current.closeLoopRef())
    expect(result.current.loopRef).toBeNull()
    vi.unstubAllGlobals()
  })

  it('a job-detected uuid that is a LOOP DEFINITION falls back to the loops API', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/jobs/')) return notFoundRes
      if (url === `/api/loops/${UUID}`) {
        return { ok: true, status: 200, json: async () => ({ loop: { id: UUID, name: 'My loop', description: null, status: 'published', graph } }) }
      }
      return notFoundRes
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAgentRefActions())
    await act(async () => { await result.current.openRef('p1', { kind: 'job', jobId: UUID }) })
    expect(result.current.jobRef).toBeNull()
    expect(result.current.loopRef).toMatchObject({ id: UUID, name: 'My loop', status: 'published', locked: false })
    vi.unstubAllGlobals()
  })

  it('a uuid that is neither job nor loop keeps the not-found toast (no modal)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => notFoundRes))
    const { result } = renderHook(() => useAgentRefActions())
    await act(async () => { await result.current.openRef('p1', { kind: 'job', jobId: UUID }) })
    expect(result.current.jobRef).toBeNull()
    expect(result.current.loopRef).toBeNull()
    expect(toast.info).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('a real job still opens the job modal (fallback never fires)', async () => {
    const fetchMock = vi.fn(async () => okRes)
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAgentRefActions())
    await act(async () => { await result.current.openRef('p1', { kind: 'job', jobId: UUID }) })
    expect(result.current.jobRef).toEqual({ projectId: 'p1', jobId: UUID })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
})

// ── LoopPreviewModal ──────────────────────────────────────────────────────────

describe('LoopPreviewModal', () => {
  const loop = {
    id: 'l1',
    name: 'Nightly refactor',
    description: 'Runs every night',
    status: 'published',
    graph: {
      nodes: [
        { id: 's', type: 'start' as const, position: { x: 0, y: 0 } },
        { id: 'a', type: 'ai-step' as const, position: { x: 0, y: 1 }, data: { prompt: 'do work' } },
        { id: 'e', type: 'end' as const, position: { x: 0, y: 2 } },
      ],
      edges: [],
      config: { maxIterations: 5, timeoutMinutes: 60 },
    },
    locked: false,
  }

  it('renders name, steps and Open-in-builder; builder navigates and closes', () => {
    const onClose = vi.fn()
    render(
      <MemoryRouter>
        <LoopPreviewModal loop={loop} onClose={onClose} />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('loop-preview-modal')).toBeInTheDocument()
    expect(screen.getByText('Nightly refactor')).toBeInTheDocument()
    expect(screen.getByText('do work')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('loop-preview-open-builder'))
    expect(onClose).toHaveBeenCalled()
  })

  it('a locked factory loop hides the builder action and shows the built-in pill', () => {
    render(
      <MemoryRouter>
        <LoopPreviewModal loop={{ ...loop, locked: true, status: null }} onClose={vi.fn()} />
      </MemoryRouter>,
    )
    expect(screen.queryByTestId('loop-preview-open-builder')).toBeNull()
    expect(screen.getByText('Built-in')).toBeInTheDocument()
  })

  it('Escape closes', () => {
    const onClose = vi.fn()
    render(
      <MemoryRouter>
        <LoopPreviewModal loop={loop} onClose={onClose} />
      </MemoryRouter>,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

// ── Per-bubble timestamp (elegant, always-recorded, subtle) ───────────────────

describe('AgentMessage per-bubble timestamp', () => {
  const ISO = '2026-07-05T09:08:07Z'

  it('renders a subtle yyyy-MM-dd HH:mm:ss <time> with the ISO datetime + a full-datetime tooltip', () => {
    render(<AgentMessage role="assistant" content="hi" createdAt={ISO} />)
    const time = document.querySelector('time')
    expect(time).not.toBeNull()
    expect(Date.parse(time!.getAttribute('datetime')!)).toBe(Date.parse(ISO))
    expect(time!.textContent).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) // date + HH:mm:ss
    expect(time!.getAttribute('title')).toBeTruthy() // consultable full date+time
    // Subtle by default (muted), not attention-grabbing.
    expect(time!.className).toContain('text-foreground/25')
  })

  it('renders the timestamp on a user bubble too', () => {
    render(<AgentMessage role="user" content="hola" createdAt={ISO} />)
    expect(Date.parse(document.querySelector('time')!.getAttribute('datetime')!)).toBe(Date.parse(ISO))
  })

  it('renders NO timestamp while streaming (no createdAt on the live buffer)', () => {
    render(<AgentMessage role="assistant" content="typing…" streaming />)
    expect(document.querySelector('time')).toBeNull()
  })

  it('renders NO timestamp for an invalid date (never a flickering NaN)', () => {
    render(<AgentMessage role="assistant" content="x" createdAt="not-a-date" />)
    expect(document.querySelector('time')).toBeNull()
  })
})
