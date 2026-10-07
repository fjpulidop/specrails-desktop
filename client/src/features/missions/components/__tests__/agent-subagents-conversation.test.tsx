import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const ws = vi.hoisted(() => ({ handlers: new Map<string, (message: unknown) => void>() }))
vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (id: string, fn: (message: unknown) => void) => { ws.handlers.set(id, fn) },
    unregisterHandler: (id: string) => { ws.handlers.delete(id) },
    connectionStatus: 'connected',
  }),
}))
vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects: [{ id: 'p1', name: 'acme', slug: 'acme', path: '/acme', provider: 'claude' }], activeProjectId: 'p1', setActiveProjectId: vi.fn() }),
}))
vi.mock('../../../browser/context/WebViewModalContext', () => ({ useWebViewModal: () => ({ openWebView: vi.fn(), canOpenWebView: false }) }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), success: vi.fn() }), Toaster: () => null }))

const conv = { id: 'c1', title: null, provider: 'claude', model: null, session_id: null, pinned_project_id: 'p1', tier_level: 0 as const, reasoning_effort: null, created_at: '', updated_at: '' }
vi.mock('../../lib/agent-api', async (orig) => {
  const actual = await orig<typeof import('../../lib/agent-api')>()
  return {
    ...actual,
    listAgentConversations: vi.fn(async () => [conv]),
    getAgentConversation: vi.fn(async () => ({ conversation: conv, messages: [] })),
    getMcpStatus: vi.fn(async () => ({ enabled: true, running: true })),
    getAvailableProviders: vi.fn(async () => ({ any: true, installed: ['claude'] })),
    getAgentModels: vi.fn(async () => ({ models: [{ value: 'sonnet', label: 'Sonnet', default: true }], supportsImageInput: true, efforts: ['low'] })),
    getMissionSubagents: vi.fn(async () => ({ subagents: [], session: null })),
    stopMissionSubagents: vi.fn(async () => ({ stopped: [] })),
  }
})

import * as agentApi from '../../lib/agent-api'
import type { AgentMessage, AgentSubagent } from '../../lib/agent-api'
import { AgentChatProvider, useAgentChat } from '../../context/AgentChatContext'
import { AgentConversationView } from '../AgentConversationView'
import { composerDrafts, __clearComposerDrafts } from '../../lib/agent-composer-drafts'

const node = (over: Partial<AgentSubagent> = {}): AgentSubagent => ({
  subagentId: 'sa-1', parentId: null, kind: 'background', agentType: 'Explore', description: 'Scan the repo', phase: 'running', reason: null,
  restarts: 0, startedAt: new Date().toISOString(), endedAt: null, usage: null, toolUses: null, durationMs: null, resultSummary: null,
  launchedInTurnId: 'turn-1', ...over,
})
const messages: AgentMessage[] = [
  { id: 'm1', conversation_id: 'c1', role: 'user', content: 'Investigate', created_at: '' },
  { id: 'm2', conversation_id: 'c1', role: 'assistant', content: 'Launched two agents.', created_at: '', core_turn_id: 'turn-1', turn_origin: 'user' },
  { id: 'm3', conversation_id: 'c1', role: 'assistant', content: 'Both agents reported back.', created_at: '', core_turn_id: 'turn-2', turn_origin: 'subagent' },
]

function Harness() {
  const chat = useAgentChat()
  return <div><button onClick={() => void chat.selectConversation('c1')}>select</button><AgentConversationView variant="inline" /></div>
}

const emit = (message: unknown) => act(() => { for (const handler of ws.handlers.values()) handler(message) })

async function mount(subagents: AgentSubagent[]) {
  vi.mocked(agentApi.getAgentConversation).mockResolvedValue({ conversation: conv, messages })
  vi.mocked(agentApi.getMissionSubagents).mockResolvedValue({ subagents, session: { residentPhase: 'background', processAlive: true, liveSubagents: 1, subagents: [] } })
  render(<AgentChatProvider><Harness /></AgentChatProvider>)
  await act(async () => { fireEvent.click(screen.getByText('select')) })
  await screen.findByText('Launched two agents.')
}

describe('mission conversation with Core sub-agents', () => {
  beforeEach(() => {
    ws.handlers.clear()
    __clearComposerDrafts()
    vi.mocked(fetch).mockImplementation(async (url) => ({ ok: true, status: 200, json: async () => String(url).endsWith('/git') ? { git: false, repositoryId: 'primary-p1' } : {} }) as Response)
  })

  it('anchors the card under the launching message and labels continuation turns', async () => {
    await mount([node(), node({ subagentId: 'sa-2', description: 'Read the docs', phase: 'idle', endedAt: new Date().toISOString() })])
    const card = await screen.findByTestId('agent-subagents-card')
    const launching = screen.getByText('Launched two agents.').closest('.space-y-1') as HTMLElement
    expect(launching).toContainElement(card)
    expect(within(card).getAllByTestId('agent-subagent-row')).toHaveLength(2)
    const continuation = screen.getByText('Both agents reported back.').closest('.space-y-1') as HTMLElement
    expect(within(continuation).getByTestId('agent-turn-origin')).toHaveTextContent('Continued after background agents')
    // Composer pill mirrors the live agent and stops through the API.
    const pill = screen.getByTestId('agent-background-agents-pill')
    expect(pill).toHaveTextContent('1 agent working')
    await act(async () => { fireEvent.click(within(pill).getByRole('button', { name: 'Stop all agents' })) })
    expect(agentApi.stopMissionSubagents).toHaveBeenCalledWith('c1', undefined)
  })

  it('shows unanchored agents, the background turn and the deferred notice live', async () => {
    await mount([])
    emit({ type: 'agent_subagent', conversationId: 'c1', subagent: node({ subagentId: 'sa-9', description: 'Live task', launchedInTurnId: 'turn-9' }) })
    expect(await screen.findByText('Live task')).toBeInTheDocument()
    emit({ type: 'agent_turn_started', conversationId: 'c1', turnId: 'bg-1', origin: 'subagent', triggeredBy: ['sa-9'] })
    emit({ type: 'agent_stream', conversationId: 'c1', turnId: 'bg-1', delta: 'Reviewing results' })
    expect(within(screen.getByTestId('agent-background-turn')).getByText('Reviewing results')).toBeInTheDocument()
    emit({ type: 'agent_session_updated', conversationId: 'c1', outcome: 'deferred', changes: { model: 'opus' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop agents and apply now' })) })
    expect(agentApi.stopMissionSubagents).toHaveBeenCalledWith('c1', undefined)
  })

  it('drafts a relaunch request for an interrupted agent', async () => {
    await mount([node({ phase: 'interrupted', reason: 'restart', endedAt: new Date().toISOString() })])
    fireEvent.click(await screen.findByTestId('agent-subagents-summary'))
    fireEvent.click(await screen.findByRole('button', { name: 'Relaunch' }))
    await waitFor(() => expect(composerDrafts.get('c1')).toBe('Please relaunch the background agent for: Scan the repo'))
  })

  it('explains a sub-agent policy the provider cannot enforce in the user language', async () => {
    await mount([])
    emit({ type: 'agent_error', conversationId: 'c1', error: 'raw Core text', code: 'policy_unenforceable', provider: 'codex' })
    expect(await screen.findByText(/Codex can't turn sub-agents off/)).toBeInTheDocument()
    expect(screen.queryByText(/raw Core text/)).not.toBeInTheDocument()
  })

  it('shows session notices in the mission and dismisses them', async () => {
    await mount([])
    emit({ type: 'agent_session_notice', conversationId: 'c1', level: 'warning', code: 'host_degraded', scope: 'global', message: 'raw', timestamp: 't' })
    expect(await screen.findByText(/Core sessions are unavailable for this project/)).toBeInTheDocument()
    emit({ type: 'agent_sessions_host', scope: 'global', status: 'ready' })
    await waitFor(() => expect(screen.queryByTestId('agent-session-notices')).not.toBeInTheDocument())
  })
})

