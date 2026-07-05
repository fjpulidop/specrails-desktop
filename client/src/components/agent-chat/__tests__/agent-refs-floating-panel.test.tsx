import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

// ── Regression: BOARD mode (floating AgentChatPanel) ref clicks ──────────────
// Ticket/job refs in the floating panel were clickable but no modal ever
// appeared: the ticket modal opened at z-50 BEHIND the z-[60] panel, and the
// job modal's fixed overlay was containing-blocked + clipped INSIDE the panel
// (backdrop-filter/transform + overflow-hidden). These tests pin the click →
// modal path from the floating-panel context.

let wsHandler: ((msg: unknown) => void) | null = null
vi.mock('../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (m: unknown) => void) => { wsHandler = fn },
    unregisterHandler: () => { wsHandler = null },
    connectionStatus: 'connected',
  }),
}))

const projects = [
  { id: 'p1', name: 'acme-api', slug: 'acme-api', path: '/acme', provider: 'claude' },
]
vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects, activeProjectId: 'p1', setActiveProjectId: vi.fn() }),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}))

vi.mock('../../../context/WebViewModalContext', () => ({
  useWebViewModal: () => ({ openWebView: vi.fn(), canOpenWebView: false }),
}))

// The app-root ticket modal provider — spy on the cross-project open.
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

// Stub the lazily-imported JobDetailModal (its real portal behaviour is pinned
// in components/__tests__/JobDetailModal.test.tsx) — here we prove the floating
// panel actually MOUNTS it with the pinned project + job id.
vi.mock('../../JobDetailModal', () => ({
  JobDetailModal: ({ jobId, projectId }: { jobId: string; projectId?: string }) => (
    <div data-testid="job-detail-modal">{projectId}:{jobId}</div>
  ),
}))

// Pinned conversation: refs resolve against the mission's pinned project.
const conv = {
  id: 'c1', title: 'Ship it', provider: 'claude', model: null, session_id: null,
  pinned_project_id: 'p1', tier_level: 0 as const, reasoning_effort: null,
  created_at: '2026-07-04T10:00:00.000Z', updated_at: '2026-07-04T10:00:00.000Z',
}

vi.mock('../../../lib/agent-api', async (orig) => {
  const actual = await orig<typeof import('../../../lib/agent-api')>()
  return {
    ...actual,
    listAgentConversations: vi.fn(async () => [conv]),
    createAgentConversation: vi.fn(async () => conv),
    getAgentConversation: vi.fn(async () => ({ conversation: conv, messages: [] })),
    patchAgentConversation: vi.fn(async () => conv),
    deleteAgentConversation: vi.fn(async () => {}),
    sendAgentMessage: vi.fn(async () => ({ queued: false })),
    abortAgentTurn: vi.fn(async () => {}),
    editQueuedAgentMessage: vi.fn(async () => 'saved' as const),
    getMcpStatus: vi.fn(async () => ({ enabled: true, running: true })),
    enableMcp: vi.fn(async () => {}),
    getAgentModels: vi.fn(async () => ({
      models: [{ value: 'sonnet', label: 'Claude Sonnet', default: true }],
      supportsImageInput: true,
      efforts: ['low', 'medium', 'high'],
    })),
  }
})

import { AgentChatProvider, useAgentChat } from '../../../context/AgentChatContext'

const UUID = '85d6ab14-1111-4222-8333-444455556666'

function Harness() {
  const a = useAgentChat()
  return <button onClick={a.open}>open</button>
}

async function openPanelWithReply(fullText: string) {
  render(<AgentChatProvider><Harness /></AgentChatProvider>)
  await act(async () => { fireEvent.click(screen.getByText('open')) })
  await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  await act(async () => {
    wsHandler!({ type: 'agent_done', conversationId: 'c1', fullText })
  })
}

beforeEach(() => {
  wsHandler = null
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('floating panel (board mode) ref clicks', () => {
  it('a ticket ref chip verifies against the pinned project and opens the app-root ticket modal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) })))
    await openPanelWithReply('Moved #3 — Add dark mode to done')
    const chip = await screen.findByTestId('agent-ref-chip')
    expect(chip).toHaveAttribute('data-ref-kind', 'ticket')
    await act(async () => { fireEvent.click(chip) })
    await waitFor(() => expect(openTicketDetailInProject).toHaveBeenCalledWith('p1', 3))
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/projects/p1/tickets/3')
  })

  it('a job ref chip mounts the JobDetailModal scoped to the pinned project', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) })))
    await openPanelWithReply(`Job launched: ${UUID}`)
    const chip = await screen.findByTestId('agent-ref-chip')
    expect(chip).toHaveAttribute('data-ref-kind', 'job')
    await act(async () => { fireEvent.click(chip) })
    const modal = await screen.findByTestId('job-detail-modal')
    expect(modal.textContent).toBe(`p1:${UUID}`)
  })

  it('the floating panel stays BELOW the modal layer: z-[60] panel vs z-[65] modals', async () => {
    // The stacking contract this fix relies on: the panel must not outrank the
    // modal layer (JobDetailModal z-[65], TicketDetailModal/SplitView z-[68] —
    // pinned in their own component tests).
    await openPanelWithReply('hola')
    const dialog = screen.getByRole('dialog')
    expect(dialog.classList.contains('z-[60]')).toBe(true)
    expect(dialog.classList.contains('z-[65]')).toBe(false)
  })
})
