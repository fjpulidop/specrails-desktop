import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: () => {},
    unregisterHandler: () => {},
    connectionStatus: 'connected',
  }),
}))

// The active project must be able to CHANGE after mount, and the change must
// re-render the provider — that is the whole behaviour under test. The mock
// therefore owns real React state, created inside the provider's own hook
// order, and hands its setter out so the test can move the project the way the
// sidebar would.
let mountProjectId: string | null = null
const projectSetters: Array<(id: string | null) => void> = []
vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => {
    const [activeProjectId, setActiveProjectId] = useState<string | null>(mountProjectId)
    if (!projectSetters.includes(setActiveProjectId)) projectSetters.push(setActiveProjectId)
    return { projects: [], activeProjectId, setActiveProjectId }
  },
}))

let uiMode: 'agent' | 'board' = 'agent'
vi.mock('../UiModeContext', () => ({
  useUiMode: () => ({ uiMode, setUiMode: vi.fn(), toggleUiMode: vi.fn() }),
}))

const conv = {
  id: 'c1',
  title: 'Mission one',
  provider: 'claude',
  model: null,
  session_id: null,
  pinned_project_id: null as string | null,
  tier_level: 0 as const,
  created_at: '',
  updated_at: '',
}

vi.mock('../../lib/agent-api', async (orig) => {
  const actual = await orig<typeof import('../../lib/agent-api')>()
  return {
    ...actual,
    listAgentConversations: vi.fn(async () => [conv]),
    createAgentConversation: vi.fn(async () => conv),
    getAgentConversation: vi.fn(async () => ({ conversation: conv, messages: [] })),
    // The real endpoint answers with the persisted ROW (snake_case), so the
    // pinned project must come back as `pinned_project_id`, not as the camelCase
    // patch key — otherwise the test would pass while the UI showed nothing.
    patchAgentConversation: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({
      ...conv,
      ...('pinnedProjectId' in patch ? { pinned_project_id: patch.pinnedProjectId as string | null } : {}),
    })),
    deleteAgentConversation: vi.fn(async () => {}),
    sendAgentMessage: vi.fn(async () => ({ queued: false })),
    abortAgentTurn: vi.fn(async () => {}),
    getMcpStatus: vi.fn(async () => ({ enabled: true, running: true })),
    enableMcp: vi.fn(async () => {}),
    getAvailableProviders: vi.fn(async () => ({ any: true, providers: [] })),
  }
})

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}))

import * as agentApi from '../../lib/agent-api'
import { AgentChatProvider, useAgentChat } from '../AgentChatContext'

function Harness() {
  const agentChat = useAgentChat()
  return (
    <div>
      <span data-testid="draft-pin">{agentChat.draftPinnedProjectId ?? ''}</span>
      <span data-testid="active-id">{agentChat.active?.id ?? ''}</span>
      <span data-testid="active-pin">{agentChat.active?.pinned_project_id ?? ''}</span>
      <button onClick={agentChat.open}>open</button>
      <button onClick={() => void agentChat.selectConversation('c1')}>select</button>
      <button onClick={() => void agentChat.send('hola')}>send</button>
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mountProjectId = null
  projectSetters.length = 0
  uiMode = 'agent'
  conv.pinned_project_id = null
  vi.mocked(agentApi.listAgentConversations).mockResolvedValue([conv])
  vi.mocked(agentApi.getAgentConversation).mockResolvedValue({ conversation: conv, messages: [] })
  vi.mocked(agentApi.getMcpStatus).mockResolvedValue({ enabled: true, running: true })
  vi.mocked(agentApi.getAvailableProviders).mockResolvedValue({ any: true, providers: [] })
})

async function moveProject(id: string | null): Promise<void> {
  expect(projectSetters.length).toBeGreaterThan(0)
  await act(async () => { for (const set of projectSetters) set(id) })
}

describe('Agent Mode project binding', () => {
  it('binds a draft mission to the project the user selects', async () => {
    mountProjectId = 'p1'
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await waitFor(() => expect(projectSetters.length).toBeGreaterThan(0))

    // Mount alone must not bind: an explicitly Home-pinned mission stays Home.
    expect(screen.getByTestId('draft-pin').textContent).toBe('')

    await moveProject('p2')
    expect(screen.getByTestId('draft-pin').textContent).toBe('p2')
  })

  it('patches an empty mission conversation to the newly selected project', async () => {
    mountProjectId = 'p1'
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('active-id').textContent).toBe('c1'))

    await moveProject('p2')

    await waitFor(() => expect(agentApi.patchAgentConversation).toHaveBeenCalledWith('c1', { pinnedProjectId: 'p2' }))
    await waitFor(() => expect(screen.getByTestId('active-pin').textContent).toBe('p2'))
  })

  it('leaves a mission that already carries messages untouched', async () => {
    mountProjectId = 'p1'
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('active-id').textContent).toBe('c1'))
    await act(async () => { fireEvent.click(screen.getByText('send')) })
    vi.mocked(agentApi.patchAgentConversation).mockClear()

    await moveProject('p2')

    expect(agentApi.patchAgentConversation).not.toHaveBeenCalled()
    expect(screen.getByTestId('active-pin').textContent).toBe('')
  })

  it('does not re-patch a conversation already pinned to that project', async () => {
    mountProjectId = 'p1'
    conv.pinned_project_id = 'p2'
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await act(async () => { fireEvent.click(screen.getByText('open')) })
    await waitFor(() => expect(screen.getByTestId('active-pin').textContent).toBe('p2'))
    vi.mocked(agentApi.patchAgentConversation).mockClear()

    await moveProject('p2')

    expect(agentApi.patchAgentConversation).not.toHaveBeenCalled()
  })

  it('ignores a switch back to Home (no project)', async () => {
    mountProjectId = 'p1'
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await waitFor(() => expect(projectSetters.length).toBeGreaterThan(0))

    await moveProject(null)

    expect(screen.getByTestId('draft-pin').textContent).toBe('')
  })

  it('never binds in board mode (the floating panel keeps its pin)', async () => {
    uiMode = 'board'
    mountProjectId = 'p1'
    render(<AgentChatProvider><Harness /></AgentChatProvider>)
    await waitFor(() => expect(projectSetters.length).toBeGreaterThan(0))

    await moveProject('p2')

    expect(screen.getByTestId('draft-pin').textContent).toBe('')
  })
})
