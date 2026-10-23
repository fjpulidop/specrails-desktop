import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { ReactNode } from 'react'

// The Flow → Spec hand-off card runs on the Flow conversation's CURRENT engine.
const machine = vi.hoisted(() => ({ detected: ['claude', 'codex'] as string[] }))
vi.mock('../../providers/hooks/useProviderDetection', () => ({
  useProviderDetection: () => ({
    detected: machine.detected,
    providers: { claude: { id: 'claude', displayName: 'Claude Code' }, codex: { id: 'codex', displayName: 'Codex' } },
    loading: false,
  }),
}))
const chat = vi.hoisted(() => ({ conversation: { id: 'c1', title: null, provider: 'codex', model: 'gpt-6.1-sol', session_id: null, pinned_project_id: 'p1', tier_level: 1, reasoning_effort: 'medium', created_at: '', updated_at: '' } as Record<string, unknown> }))
vi.mock('../../missions/context/AgentChatContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../missions/context/AgentChatContext')>()
  return { ...actual, useAgentChat: () => ({ ...actual.useAgentChat(), messages: [], isStreaming: false, conversations: [chat.conversation], active: chat.conversation }) }
})
vi.mock('../../loops/lib/loops-api', () => ({ loopsApi: { list: vi.fn(async () => []) } }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }))
vi.mock('../../background/context/BackgroundProcessesContext', () => ({
  useBackgroundProcesses: () => ({ processes: [], history: [], historyLoading: false, historyError: null, refreshHistory: async () => {}, kill: async () => {} }),
}))

import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'
import { FlowMissionsBridge } from '../components/FlowMissionsBridge'
import { AgentRunStrip } from '../../missions/components/AgentRunStrip'
import { resetLocalIntents } from '../../rails/lib/rail-launch-intents'
import { flowHandOffEngine } from '../lib/flow-engine'
import type { Flow } from '../lib/flow-api'

const flow = (over: Partial<Flow> = {}): Flow => ({
  id: 'f1', conversationId: 'c1', ticketId: 8, state: 'active', branch: 'feat/8-arkanoid', worktreePath: '/wt/f1/ticket-8',
  baseSha: 'a', headSha: 'b', railIndex: null, deliveryId: null, step: null, ...over,
})

const ws = { registerHandler: () => {}, unregisterHandler: () => {}, connectionStatus: 'connected' as const }
type Call = { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[]

function respond(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: async () => body, clone() { return this } } as unknown as Response
}

beforeEach(() => {
  machine.detected = ['claude', 'codex']
  chat.conversation = { ...chat.conversation, provider: 'codex', model: 'gpt-6.1-sol', reasoning_effort: 'medium' }
  resetLocalIntents()
  calls = []
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    calls.push({ url, method, body })
    if (url.endsWith('/flow/availability')) return respond(200, { available: true, reason: 'ok', missing: [] })
    if (url.includes('/flow/by-conversation/')) return respond(200, { flow: flow() })
    if (url.endsWith('/flow/f1/hand-off')) return respond(202, { flow: flow({ state: 'handed_off', railIndex: 1, deliveryId: 'd1' }), loopRunIds: ['run-9'], deliveryId: 'd1' })
    if (url.endsWith('/flow/f1/diff')) return respond(200, { branch: 'feat/8-arkanoid', baseSha: 'a', headSha: 'b', files: [], totals: { files: 0, additions: 0, deletions: 0 } })
    if (url.endsWith('/flow/f1/cost')) return respond(200, { flowId: 'f1', costUsd: 0, turns: 0, unpricedTurns: 0 })
    if (url.endsWith('/rails') && method === 'GET') return respond(200, { rails: [{ railIndex: 0, ticketIds: [3], mode: 'implement' }, { railIndex: 1, ticketIds: [], mode: 'implement' }], activeJobs: { 0: { jobId: 'j' } }, activeLoopRuns: {}, prDeliveries: {} })
    if (url.endsWith('/tickets') && method === 'GET') return respond(200, { tickets: [{ id: 8, title: 'Arkanoid power-ups', status: 'in_progress', labels: [] }] })
    if (url.endsWith('/repositories')) return respond(200, { repositories: [{ id: 'primary', projectId: 'p1', name: 'App', path: '/app', isPrimary: true, kind: 'git', integrationBranch: null, addedAt: '' }] })
    return respond(200, {})
  })
})

function Providers({ children }: { children: ReactNode }) {
  return <SharedWebSocketContext.Provider value={ws}><FlowMissionsBridge>{children}</FlowMissionsBridge></SharedWebSocketContext.Provider>
}

async function openHandOff() {
  render(<Providers><AgentRunStrip conversationId="c1" projectId="p1" inline /></Providers>)
  fireEvent.click(await screen.findByTestId('flow-bar-hand-off'))
  return screen.findByTestId('flow-hand-off-card')
}

describe('Flow → Spec hand-off engine default', () => {
  it('preselects the Codex conversation\'s engine and launches with its aiEngine/model/effort', async () => {
    const card = await openHandOff()
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    expect(screen.queryByTestId('rail-card-hand-off-note')).toBeNull()
    expect(card).not.toHaveTextContent('Claude Code')
    await act(async () => { fireEvent.click(screen.getByTestId('rail-card-play')) })
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/flow/f1/hand-off'))).toBe(true))
    expect(calls.find((c) => c.url.endsWith('/flow/f1/hand-off'))!.body).toMatchObject({ railIndex: 1, loopId: 'factory:flow-spec', aiEngine: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' })
  })

  it('falls back to the rail default with a note when the conversation\'s provider cannot run here', async () => {
    machine.detected = ['claude']
    await openHandOff()
    // The fallback only matters when changing how: it sits inside "Change how".
    const note = await screen.findByTestId('rail-card-hand-off-note')
    expect(note).toHaveTextContent("Codex can't run Flow → Spec on this machine")
    expect(note.closest('[data-testid="rail-card-hand-off-settings"]')).not.toBeNull()
    expect(screen.getByTestId('rail-card-hand-off-line')).not.toHaveTextContent('Codex')
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('rail-card-play')) })
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/flow/f1/hand-off'))).toBe(true))
    expect(calls.find((c) => c.url.endsWith('/flow/f1/hand-off'))!.body).not.toMatchObject({ aiEngine: 'codex' })
  })
})

describe('flowHandOffEngine', () => {
  const conversation = { provider: 'codex', model: 'gpt-6.1-sol', reasoning_effort: 'high' }
  it('uses the conversation selection when usable (or while detection is pending)', () => {
    expect(flowHandOffEngine(conversation, ['codex'])).toEqual({ aiEngine: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', fallbackFrom: null })
    expect(flowHandOffEngine(conversation, [], true)).toMatchObject({ aiEngine: 'codex', fallbackFrom: null })
  })
  it('falls back to the rail default otherwise', () => {
    expect(flowHandOffEngine(conversation, ['claude'])).toEqual({ aiEngine: null, model: null, reasoningEffort: null, fallbackFrom: 'codex' })
    expect(flowHandOffEngine({ provider: 'roles', model: null, reasoning_effort: null }, ['claude'])).toMatchObject({ aiEngine: null, fallbackFrom: 'roles' })
    expect(flowHandOffEngine(null, ['claude'])).toEqual({ aiEngine: null, model: null, reasoningEffort: null, fallbackFrom: null })
  })
})
