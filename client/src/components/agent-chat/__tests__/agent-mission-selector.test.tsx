import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

// ── Mocks (mirror agent-chat.test.tsx harness) ────────────────────────────────
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

function conv(id: string, title: string | null, updatedAt: string) {
  return {
    id, title, provider: 'claude', model: null, session_id: null,
    pinned_project_id: null, tier_level: 0 as const, reasoning_effort: null,
    created_at: updatedAt, updated_at: updatedAt,
  }
}
// Newest-first fixture (c1 newest) — the server's ORDER BY updated_at DESC.
const c1 = conv('c1', 'Deploy checklist', '2026-07-04T10:00:00.000Z')
const c2 = conv('c2', 'Spending report', '2026-07-03T10:00:00.000Z')
const c3 = conv('c3', null, '2026-07-02T10:00:00.000Z')

vi.mock('../../../lib/agent-api', async (orig) => {
  const actual = await orig<typeof import('../../../lib/agent-api')>()
  return {
    ...actual,
    listAgentConversations: vi.fn(async () => []),
    createAgentConversation: vi.fn(async () => c1),
    getAgentConversation: vi.fn(async () => ({ conversation: c1, messages: [] })),
    patchAgentConversation: vi.fn(async () => c1),
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

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}))

import { toast } from 'sonner'
import * as agentApi from '../../../lib/agent-api'
import { AgentChatProvider, useAgentChat } from '../../../context/AgentChatContext'

function Harness() {
  const a = useAgentChat()
  return (
    <div>
      <span data-testid="active-id">{a.active?.id ?? 'none'}</span>
      <button onClick={a.open}>open</button>
    </div>
  )
}

/** Open the panel with `list` as the stored conversations (newest-first). */
async function openPanel(list = [c1, c2, c3]) {
  vi.mocked(agentApi.listAgentConversations).mockResolvedValue(list)
  vi.mocked(agentApi.getAgentConversation).mockImplementation(async (id: string) => ({
    conversation: list.find((c) => c.id === id) ?? list[0],
    messages: [],
  }))
  render(<AgentChatProvider><Harness /></AgentChatProvider>)
  await act(async () => { fireEvent.click(screen.getByText('open')) })
  await waitFor(() => expect(screen.getByTestId('active-id').textContent).toBe(list[0]?.id ?? 'none'))
}

function openDropdown() {
  fireEvent.click(screen.getByTestId('mission-trigger'))
}

beforeEach(() => {
  wsHandler = null
  vi.clearAllMocks()
  vi.mocked(agentApi.getMcpStatus).mockResolvedValue({ enabled: true, running: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AgentMissionSelector', () => {
  it('shows the active mission title on the trigger, with the New-mission fallback when untitled', async () => {
    await openPanel()
    expect(screen.getByTestId('mission-trigger')).toHaveTextContent('Deploy checklist')
    // Switch to the untitled conversation → fallback label.
    openDropdown()
    await act(async () => { fireEvent.click(screen.getByTestId('mission-row-c3')) })
    await waitFor(() => expect(screen.getByTestId('active-id').textContent).toBe('c3'))
    expect(screen.getByTestId('mission-trigger')).toHaveTextContent('New mission')
  })

  it('lists missions newest-first with relative times and switches on click', async () => {
    await openPanel()
    openDropdown()
    const listbox = screen.getByRole('listbox')
    const options = listbox.querySelectorAll('[data-testid^="mission-row-"]')
    expect([...options].map((o) => o.getAttribute('data-testid'))).toEqual([
      'mission-row-c1', 'mission-row-c2', 'mission-row-c3',
    ])
    // Relative time rendered (any "ago" suffix — locale en in tests).
    expect(screen.getByTestId('mission-row-c2').textContent).toMatch(/ago/)
    await act(async () => { fireEvent.click(screen.getByTestId('mission-row-c2')) })
    expect(agentApi.getAgentConversation).toHaveBeenCalledWith('c2')
    await waitFor(() => expect(screen.getByTestId('active-id').textContent).toBe('c2'))
    // Dropdown closed after selection.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('marks the active mission with aria-selected', async () => {
    await openPanel()
    openDropdown()
    expect(screen.getByTestId('mission-row-c1')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('mission-row-c2')).toHaveAttribute('aria-selected', 'false')
  })

  it('New mission resets to the empty compose screen (existing flow — no eager create)', async () => {
    await openPanel()
    const createsBefore = vi.mocked(agentApi.createAgentConversation).mock.calls.length
    openDropdown()
    await act(async () => { fireEvent.click(screen.getByTestId('mission-new')) })
    expect(screen.getByTestId('active-id').textContent).toBe('none')
    expect(screen.getByTestId('mission-trigger')).toHaveTextContent('New mission')
    // Reuses startNewConversation: the conversation is created on first send.
    expect(vi.mocked(agentApi.createAgentConversation).mock.calls.length).toBe(createsBefore)
    // Closed (AnimatePresence keeps the node mounted during the exit tween).
    expect(screen.getByTestId('mission-trigger')).toHaveAttribute('aria-expanded', 'false')
  })

  it('delete is a two-step inline confirm inside the row', async () => {
    await openPanel()
    openDropdown()
    fireEvent.click(screen.getByTestId('mission-delete-c2'))
    // Row swapped to the confirm state — nothing deleted yet.
    expect(agentApi.deleteAgentConversation).not.toHaveBeenCalled()
    expect(screen.getByTestId('mission-row-c2')).toHaveTextContent('Delete?')
    await act(async () => { fireEvent.click(screen.getByTestId('mission-confirm-yes')) })
    expect(agentApi.deleteAgentConversation).toHaveBeenCalledWith('c2')
    await waitFor(() => expect(screen.queryByTestId('mission-row-c2')).not.toBeInTheDocument())
    // Deleting a NON-active mission never switches the thread.
    expect(screen.getByTestId('active-id').textContent).toBe('c1')
  })

  it('✕ cancels the confirm without deleting', async () => {
    await openPanel()
    openDropdown()
    fireEvent.click(screen.getByTestId('mission-delete-c2'))
    fireEvent.click(screen.getByTestId('mission-confirm-no'))
    expect(agentApi.deleteAgentConversation).not.toHaveBeenCalled()
    expect(screen.getByTestId('mission-row-c2')).toHaveTextContent('Spending report')
  })

  it('an armed confirm reverts on its own after 3s', async () => {
    await openPanel()
    openDropdown()
    vi.useFakeTimers()
    fireEvent.click(screen.getByTestId('mission-delete-c2'))
    expect(screen.getByTestId('mission-row-c2')).toHaveTextContent('Delete?')
    act(() => { vi.advanceTimersByTime(3100) })
    expect(screen.getByTestId('mission-row-c2')).toHaveTextContent('Spending report')
    expect(agentApi.deleteAgentConversation).not.toHaveBeenCalled()
  })

  it('deleting the ACTIVE mission hands off to the newest remaining one', async () => {
    await openPanel()
    openDropdown()
    fireEvent.click(screen.getByTestId('mission-delete-c1'))
    await act(async () => { fireEvent.click(screen.getByTestId('mission-confirm-yes')) })
    expect(agentApi.deleteAgentConversation).toHaveBeenCalledWith('c1')
    // Handoff: newest remaining (c2) becomes the active thread.
    await waitFor(() => expect(screen.getByTestId('active-id').textContent).toBe('c2'))
  })

  it('deleting the LAST mission lands on the empty compose state', async () => {
    await openPanel([c1])
    openDropdown()
    fireEvent.click(screen.getByTestId('mission-delete-c1'))
    await act(async () => { fireEvent.click(screen.getByTestId('mission-confirm-yes')) })
    await waitFor(() => expect(screen.getByTestId('active-id').textContent).toBe('none'))
    expect(screen.getByTestId('mission-trigger')).toHaveTextContent('New mission')
  })

  it('warns differently when deleting a mission with a LIVE stream (still allowed)', async () => {
    await openPanel()
    // c2 starts streaming in the background.
    await act(async () => { wsHandler!({ type: 'agent_stream', conversationId: 'c2', delta: 'working…' }) })
    openDropdown()
    fireEvent.click(screen.getByTestId('mission-delete-c2'))
    expect(screen.getByTestId('mission-row-c2')).toHaveTextContent('Agent is working — delete anyway?')
    await act(async () => { fireEvent.click(screen.getByTestId('mission-confirm-yes')) })
    expect(agentApi.deleteAgentConversation).toHaveBeenCalledWith('c2')
  })

  it('surfaces a toast when the delete fails and keeps the row', async () => {
    vi.mocked(agentApi.deleteAgentConversation).mockRejectedValueOnce(new Error('network'))
    await openPanel()
    openDropdown()
    fireEvent.click(screen.getByTestId('mission-delete-c2'))
    await act(async () => { fireEvent.click(screen.getByTestId('mission-confirm-yes')) })
    expect(toast.error).toHaveBeenCalledWith("Couldn't delete the mission")
  })

  it('shows a live pulse dot on missions with a streaming turn', async () => {
    await openPanel()
    await act(async () => { wsHandler!({ type: 'agent_stream', conversationId: 'c2', delta: 'x' }) })
    openDropdown()
    expect(screen.getByTestId('mission-live-c2')).toBeInTheDocument()
    expect(screen.queryByTestId('mission-live-c3')).not.toBeInTheDocument()
  })

  it('shows a queued-count badge on missions with parked messages', async () => {
    await openPanel()
    await act(async () => {
      wsHandler!({ type: 'agent_queued', conversationId: 'c2', queueId: 'q1', text: 'later' })
      wsHandler!({ type: 'agent_queued', conversationId: 'c2', queueId: 'q2', text: 'even later' })
    })
    openDropdown()
    expect(screen.getByTestId('mission-queued-c2')).toHaveTextContent('2')
    expect(screen.queryByTestId('mission-queued-c1')).not.toBeInTheDocument()
  })

  it('hides search at ≤8 missions and shows+filters it above the threshold', async () => {
    // 8 → no search.
    const eight = Array.from({ length: 8 }, (_, i) => conv(`m${i}`, `Mission ${i}`, `2026-07-0${(i % 3) + 1}T0${i}:00:00.000Z`))
    await openPanel(eight)
    openDropdown()
    expect(screen.queryByPlaceholderText('Search missions…')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mission-trigger')) // close
    // 9 → search appears and filters.
    const nine = [...eight, conv('m8', 'Zebra hunt', '2026-06-30T00:00:00.000Z')]
    vi.mocked(agentApi.listAgentConversations).mockResolvedValue(nine)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    openDropdown()
    const search = await screen.findByPlaceholderText('Search missions…')
    fireEvent.change(search, { target: { value: 'zebra' } })
    expect(screen.getByTestId('mission-row-m8')).toBeInTheDocument()
    expect(screen.queryByTestId('mission-row-m0')).not.toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'no such mission' } })
    expect(screen.getByText('No missions match')).toBeInTheDocument()
  })

  it('full keyboard nav: ↓ highlights, Enter selects, Esc closes back to the trigger', async () => {
    await openPanel()
    const trigger = screen.getByTestId('mission-trigger')
    // ArrowDown on the closed trigger opens the list.
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    // Opens highlighted on the ACTIVE mission (c1 = option index 1); ↓ moves to c2.
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-activedescendant', 'agent-mission-opt-1')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-activedescendant', 'agent-mission-opt-2')
    await act(async () => { fireEvent.keyDown(trigger, { key: 'Enter' }) })
    expect(agentApi.getAgentConversation).toHaveBeenCalledWith('c2')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    // Reopen → Esc closes.
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('↑ wraps from the top action to the last mission; Enter on index 0 starts a new mission', async () => {
    await openPanel()
    const trigger = screen.getByTestId('mission-trigger')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // open (highlight = active = 1)
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })   // → 0 (New mission)
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-activedescendant', 'agent-mission-opt-0')
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })   // wraps → last mission (c3)
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-activedescendant', 'agent-mission-opt-3')
    fireEvent.keyDown(trigger, { key: 'Home' })
    await act(async () => { fireEvent.keyDown(trigger, { key: 'Enter' }) })
    expect(screen.getByTestId('active-id').textContent).toBe('none') // empty compose
  })

  it('Esc with an armed confirm disarms it first, keeping the list open', async () => {
    await openPanel()
    openDropdown()
    fireEvent.click(screen.getByTestId('mission-delete-c2'))
    expect(screen.getByTestId('mission-row-c2')).toHaveTextContent('Delete?')
    fireEvent.keyDown(screen.getByTestId('mission-trigger'), { key: 'Escape' })
    expect(screen.getByRole('listbox')).toBeInTheDocument() // still open
    expect(screen.getByTestId('mission-row-c2')).toHaveTextContent('Spending report')
  })
})
