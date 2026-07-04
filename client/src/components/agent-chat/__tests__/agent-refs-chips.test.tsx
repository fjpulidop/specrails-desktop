import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

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
import { toast } from 'sonner'
import { AgentMessage } from '../AgentMessage'
import { AgentPrDecisionCard } from '../AgentPrDecisionCard'
import type { AgentPrDecisionEnvelope } from '../../../lib/agent-api'
import type { AgentRefTarget } from '../../../lib/agent-refs'

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
