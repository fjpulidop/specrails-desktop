import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('../../providers/hooks/useProviderDetection', () => ({
  useProviderDetection: () => ({
    detected: ['claude'],
    providers: { claude: { id: 'claude', displayName: 'Claude Code' } },
    loading: false,
  }),
}))
vi.mock('../../loops/lib/loops-api', () => ({ loopsApi: { list: vi.fn(async () => []) } }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }))

import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'
import { FlowProvider, useConversationFlow } from '../context/FlowContext'
import { FlowMissionsBridge, useFlowConversationMode } from '../components/FlowMissionsBridge'
import { FlowEntryCard } from '../components/FlowEntryCard'
import { FlowDock } from '../components/FlowDock'
import { FlowOfferCard } from '../components/FlowOfferCard'
import { AgentMessage } from '../../missions/components/AgentMessage'
import { resetLocalIntents } from '../../rails/lib/rail-launch-intents'
import type { Flow } from '../lib/flow-api'

const flow = (over: Partial<Flow> = {}): Flow => ({
  id: 'f1', conversationId: 'c1', ticketId: 7, state: 'active', branch: 'feat/7-calm-dashboard', worktreePath: '/wt/f1/ticket-7',
  baseSha: 'a', headSha: 'b', railIndex: null, deliveryId: null, step: null, ...over,
})

let wsHandlers: Map<string, (msg: unknown) => void>
const ws = {
  registerHandler: (id: string, fn: (msg: unknown) => void) => { wsHandlers.set(id, fn) },
  unregisterHandler: (id: string) => { wsHandlers.delete(id) },
  connectionStatus: 'connected' as const,
}

type Call = { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[]
let current: Flow | null
let availability: { available: boolean; reason: string; missing: string[] }

function respond(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: async () => body, clone() { return this } } as unknown as Response
}

function mockFetch() {
  calls = []
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    calls.push({ url, method, body })
    if (url.endsWith('/flow/availability')) return respond(200, availability)
    if (url.includes('/flow/by-conversation/')) return respond(200, { flow: current })
    if (url.endsWith('/flow') && method === 'POST') { current = flow(); return respond(201, { flow: current }) }
    if (url.endsWith('/flow/f1/pause')) { current = flow({ state: 'paused' }); return respond(200, { flow: current }) }
    if (url.endsWith('/flow/f1/resume')) { current = flow(); return respond(200, { flow: current }) }
    if (url.endsWith('/flow/f1/discard')) { current = flow({ state: 'discarded' }); return respond(200, { flow: current }) }
    if (url.endsWith('/flow/f1/hand-off')) { current = flow({ state: 'handed_off', railIndex: 1, deliveryId: 'd1' }); return respond(202, { flow: current, loopRunIds: ['run-9'], deliveryId: 'd1' }) }
    if (url.endsWith('/flow/f1/diff')) return respond(200, { branch: 'feat/7-calm-dashboard', baseSha: 'a', headSha: 'b', files: [{ path: 'src/App.tsx', status: 'modified', additions: 8, deletions: 2 }, { path: 'src/new.ts', status: 'added', additions: 2, deletions: 0 }, { path: 'logo.png', status: 'untracked', additions: null, deletions: null }], totals: { files: 3, additions: 10, deletions: 2 } })
    if (url.endsWith('/flow/f1/cost')) return respond(200, { flowId: 'f1', costUsd: 0.42, turns: 3, unpricedTurns: 0 })
    if (url.endsWith('/rails') && method === 'GET') return respond(200, { rails: [{ railIndex: 0, ticketIds: [3], mode: 'implement' }, { railIndex: 1, ticketIds: [], mode: 'implement' }], activeJobs: { 0: { jobId: 'j' } }, activeLoopRuns: {}, prDeliveries: {} })
    if (url.endsWith('/tickets') && method === 'GET') return respond(200, { tickets: [{ id: 7, title: 'Calm dashboard', status: 'in_progress', labels: [] }] })
    if (url.endsWith('/repositories')) return respond(200, { repositories: [{ id: 'primary', projectId: 'p1', name: 'App', path: '/app', isPrimary: true, kind: 'git', integrationBranch: null, addedAt: '' }] })
    if (url.includes('/intent')) return respond(200, { message: { intents: [{ ...body, at: 'now' }] } })
    return respond(200, {})
  })
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <SharedWebSocketContext.Provider value={ws}>
      <FlowMissionsBridge>{children}</FlowMissionsBridge>
    </SharedWebSocketContext.Provider>
  )
}

beforeEach(() => {
  wsHandlers = new Map()
  current = flow()
  availability = { available: true, reason: 'Flow is available', missing: [] }
  resetLocalIntents()
  mockFetch()
})

describe('FlowEntryCard', () => {
  it('explains the isolated worktree and starts the Flow on Start', async () => {
    current = null
    const onStarted = vi.fn()
    render(<Providers><FlowEntryCard idea="Try a calmer dashboard" projectId="p1" conversationId="c1" provider="claude" onStarted={onStarted} onCancel={vi.fn()} /></Providers>)
    expect(screen.getByText(/isolated worktree where the agent can write code\. Your main branch is not touched\./)).toBeInTheDocument()
    expect(screen.getByTestId('flow-entry-idea')).toHaveTextContent('Try a calmer dashboard')
    expect(screen.getByText(/works with Claude/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('flow-entry-start')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' })))
    expect(calls.find((c) => c.url.endsWith('/api/projects/p1/flow') && c.method === 'POST')!.body).toEqual({ conversationId: 'c1', idea: 'Try a calmer dashboard' })
  })

  it('is disabled with the missing capabilities in plain words when Flow is unavailable', async () => {
    availability = { available: false, reason: 'update Core', missing: ['flowSessions', 'deriveChange'] }
    render(<Providers><FlowEntryCard idea="x" projectId="p1" conversationId="c1" onStarted={vi.fn()} onCancel={vi.fn()} /></Providers>)
    const note = await screen.findByTestId('flow-entry-blocked')
    expect(note).toHaveTextContent('Flow needs a newer Specrails Core')
    expect(note).toHaveTextContent('cannot interrupt a running agent yet')
    expect(note).toHaveTextContent('cannot derive a spec from code yet')
    expect(screen.getByTestId('flow-entry-start')).toBeDisabled()
  })

  it('treats a 409 feature_unavailable availability answer as unavailable', async () => {
    vi.mocked(fetch).mockImplementation(async () => respond(409, { error: 'feature_unavailable', detail: 'Flow is not available in this project' }))
    render(<Providers><FlowEntryCard idea="x" projectId="p1" conversationId="c1" onStarted={vi.fn()} onCancel={vi.fn()} /></Providers>)
    expect(await screen.findByTestId('flow-entry-blocked')).toHaveTextContent('Flow is not available right now')
    expect(screen.getByTestId('flow-entry-start')).toBeDisabled()
  })
})

describe('Flow mode in the conversation', () => {
  it('turns the conversation into Flow mode only while the Flow is active', async () => {
    const { result } = renderHook(() => useFlowConversationMode('c1', 'p1'), { wrapper: Providers })
    await waitFor(() => expect(result.current).toEqual({ attributes: { 'data-flow': 'active' }, gitBranch: { branch: 'feat/7-calm-dashboard', label: 'Flow worktree' }, interruptWhileBusy: true }))
    act(() => wsHandlers.get('flow-mode')!({ type: 'flow.state', projectId: 'p1', conversationId: 'c1', flowId: 'f1', flow: flow({ state: 'paused' }) }))
    expect(result.current).toBeNull()
  })

  it('shows the Flow bar with branch, files, real cost and the controls', async () => {
    render(<Providers><FlowDock conversationId="c1" projectId="p1" inline /></Providers>)
    const bar = await screen.findByTestId('flow-bar')
    expect(bar).toHaveTextContent('feat/7-calm-dashboard')
    await waitFor(() => expect(screen.getByTestId('flow-bar-stats')).toHaveTextContent('3 files+10−2'))
    expect(screen.getByTestId('flow-bar-cost')).toHaveTextContent('$0.420')
    for (const id of ['changes', 'pause', 'discard', 'this-is-it']) expect(screen.getByTestId(`flow-bar-${id}`)).toBeInTheDocument()
    expect(screen.getByRole('toolbar', { name: 'Flow actions' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('flow-bar-changes'))
    const dialog = await screen.findByTestId('flow-changes-dialog')
    await waitFor(() => expect(dialog.querySelectorAll('[data-testid="flow-changes-file"]')).toHaveLength(3))
    expect(dialog).toHaveTextContent('src/App.tsx')
    expect(dialog).toHaveTextContent('—')
  })

  it('shows — when no turn is priced yet', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => String(input).endsWith('/cost')
      ? respond(200, { flowId: 'f1', costUsd: 0, turns: 1, unpricedTurns: 1 })
      : String(input).includes('/by-conversation/') ? respond(200, { flow: current }) : respond(200, { files: [], totals: { files: 0, additions: 0, deletions: 0 } }))
    render(<Providers><FlowDock conversationId="c1" projectId="p1" inline /></Providers>)
    await waitFor(() => expect(screen.getByTestId('flow-bar-cost')).toHaveTextContent('—'))
  })

  it('pauses, then offers Resume Flow and resumes', async () => {
    render(<Providers><FlowDock conversationId="c1" projectId="p1" inline /></Providers>)
    const pause = await screen.findByTestId('flow-bar-pause')
    await act(async () => { fireEvent.click(pause) })
    await waitFor(() => expect(screen.getByTestId('flow-bar')).toHaveAttribute('data-flow-state', 'paused'))
    expect(screen.getByTestId('flow-bar-note')).toHaveTextContent('The worktree and the spec are kept')
    await act(async () => { fireEvent.click(screen.getByTestId('flow-bar-resume')) })
    await waitFor(() => expect(screen.getByTestId('flow-bar')).toHaveAttribute('data-flow-state', 'active'))
    expect(calls.map((c) => c.url).filter((u) => /\/(pause|resume)$/.test(u))).toEqual([
      expect.stringMatching(/\/api\/projects\/p1\/flow\/f1\/pause$/), expect.stringMatching(/\/flow\/f1\/resume$/),
    ])
  })

  it('asks before discarding and only then calls discard', async () => {
    render(<Providers><FlowDock conversationId="c1" projectId="p1" inline /></Providers>)
    fireEvent.click(await screen.findByTestId('flow-bar-discard'))
    const dialog = await screen.findByTestId('flow-discard-dialog')
    expect(dialog).toHaveTextContent('The worktree, its branch and the placeholder spec are deleted')
    expect(calls.some((c) => c.url.endsWith('/discard'))).toBe(false)
    await act(async () => { fireEvent.click(screen.getByTestId('flow-discard-confirm')) })
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/flow/f1/discard') && c.method === 'POST')).toBe(true))
    await waitFor(() => expect(screen.queryByTestId('flow-bar')).toBeNull())
  })

  it('explains needs-review without destructive controls', async () => {
    current = flow({ state: 'needs-review' })
    render(<Providers><FlowDock conversationId="c1" projectId="p1" inline /></Providers>)
    expect(await screen.findByTestId('flow-bar-note')).toHaveTextContent('Nothing was deleted')
    expect(screen.queryByTestId('flow-bar-discard')).toBeNull()
  })

  it('"This is it" swaps the bar for the hand-off card with Flow → Spec, launching through the hand-off route', async () => {
    const { result } = renderHook(() => useFlowConversationMode('c1', 'p1'), { wrapper: Providers })
    await waitFor(() => expect(result.current).not.toBeNull())
    render(<Providers><FlowDock conversationId="c1" projectId="p1" inline /></Providers>)
    fireEvent.click(await screen.findByTestId('flow-bar-this-is-it'))
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    const card = await screen.findByTestId('flow-hand-off-card')
    await waitFor(() => expect(screen.queryByTestId('flow-bar')).toBeNull())
    expect(card).toHaveTextContent('Flow → Spec')
    expect(card).toHaveTextContent('#7')
    expect(screen.queryByTestId('rail-card-repositories')).toBeNull()
    expect(screen.queryByTestId('rail-card-target-pr')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('rail-card-play')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('rail-card-play')) })
    await waitFor(() => expect(screen.getByTestId('agent-rail-launch-stub-launched')).toBeInTheDocument())
    const handOff = calls.find((c) => c.url.endsWith('/flow/f1/hand-off'))!
    expect(handOff.body).toMatchObject({ railIndex: 1, loopId: 'factory:flow-spec' })
    expect(calls.some((c) => /\/rails\/\d+\/(launch|tickets)$/.test(c.url))).toBe(false)
    // No offer message anchors this Flow: nothing is patched on a phantom message.
    expect(calls.some((c) => c.url.includes('/intent'))).toBe(false)
  })

  it('"Not yet" returns to the Flow', async () => {
    render(<Providers><FlowDock conversationId="c1" projectId="p1" inline /></Providers>)
    fireEvent.click(await screen.findByTestId('flow-bar-this-is-it'))
    await screen.findByTestId('flow-hand-off-card')
    fireEvent.click(screen.getByTestId('rail-card-dismiss'))
    expect(await screen.findByTestId('flow-bar')).toHaveAttribute('data-flow-state', 'active')
  })

  it('applies flow.state events only for watched projects', async () => {
    const { result } = renderHook(() => useConversationFlow('c1', 'p1'), { wrapper: ({ children }) => <SharedWebSocketContext.Provider value={ws}><FlowProvider>{children}</FlowProvider></SharedWebSocketContext.Provider> })
    await waitFor(() => expect(result.current.flow?.state).toBe('active'))
    act(() => wsHandlers.get('flow-mode')!({ type: 'flow.state', projectId: 'p2', conversationId: 'c1', flowId: 'f1', flow: flow({ state: 'discarded' }) }))
    expect(result.current.flow?.state).toBe('active')
    act(() => wsHandlers.get('flow-mode')!({ type: 'other', projectId: 'p1', conversationId: 'c1', flow: flow({ state: 'discarded' }) }))
    expect(result.current.flow?.state).toBe('active')
    act(() => wsHandlers.get('flow-mode')!({ type: 'flow.state', projectId: 'p1', conversationId: 'c1', flowId: 'f1', flow: flow({ state: 'paused' }) }))
    expect(result.current.flow?.state).toBe('paused')
  })
})

describe('FlowOfferCard through the AgentMessage extension chain', () => {
  const offer = (recommended: 'flow' | 'implement') => `This one is exploratory.\n\n\`\`\`flow-offer\n${JSON.stringify({ idea: 'Prototype a calmer dashboard', reason: 'The look is still open.', recommended })}\n\`\`\``

  it('strips the fence and renders the recommendation with the other path one click away', async () => {
    current = null
    render(<Providers><AgentMessage role="assistant" content={offer('flow')} messageId="m1" conversationId="c1" refsProjectId="p1" isLatest /></Providers>)
    const card = await screen.findByTestId('flow-offer-card')
    expect(card).toHaveAttribute('data-recommended', 'flow')
    expect(card).toHaveTextContent('The look is still open.')
    expect(screen.getByTestId('flow-offer-choose-flow')).toHaveTextContent('Recommended')
    expect(screen.getByTestId('flow-offer-choose-implement')).toBeInTheDocument()
    expect(screen.queryByText(/"recommended"/)).toBeNull()
  })

  it('Implement records the choice and replies to the agent', async () => {
    current = null
    const onSend = vi.fn()
    render(<Providers><AgentMessage role="assistant" content={offer('flow')} messageId="m1" conversationId="c1" refsProjectId="p1" isLatest onPickOption={onSend} /></Providers>)
    const implement = await screen.findByTestId('flow-offer-choose-implement')
    await act(async () => { fireEvent.click(implement) })
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Let's write the spec first and run Implement."))
    expect(calls.find((c) => c.url.includes('/messages/m1/intent'))!.body).toEqual({ kind: 'flow-offer', proposalIndex: 0, recommendedMode: 'flow', status: 'accepted', chosenMode: 'implement' })
    expect(await screen.findByTestId('flow-offer-stub-implement')).toHaveTextContent('recommended: Flow')
  })

  it('Flow opens the entry card and Start records chosenMode + flowId', async () => {
    current = null
    render(<Providers><FlowOfferCard tag="flow-offer" payload={{ idea: 'Prototype it', recommended: 'implement' }} index={0} messageId="m1" conversationId="c1" projectId="p1" intents={null} isLatest isStreaming={false} /></Providers>)
    expect(screen.getByTestId('flow-offer-choose-implement')).toHaveTextContent('Recommended')
    fireEvent.click(screen.getByTestId('flow-offer-choose-flow'))
    await waitFor(() => expect(screen.getByTestId('flow-entry-start')).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByTestId('flow-entry-start')) })
    await waitFor(() => expect(calls.find((c) => c.url.includes('/intent'))?.body).toEqual({
      kind: 'flow-offer', proposalIndex: 0, recommendedMode: 'implement', status: 'accepted', chosenMode: 'flow', config: { flowId: 'f1' },
    }))
    expect(await screen.findByTestId('flow-offer-stub-flow')).toHaveTextContent('Flow in progress')
  })

  it('renders the frozen record (with the hand-off) from persisted intents', () => {
    render(<Providers><FlowOfferCard tag="flow-offer" payload={{ idea: 'x', recommended: 'flow' }} index={0} messageId="m1" conversationId="c1" projectId="p1" isLatest={false} isStreaming={false}
      intents={[
        { kind: 'flow-offer', proposalIndex: 0, status: 'accepted', at: 't', chosenMode: 'flow', recommendedMode: 'flow', config: { flowId: 'f1' } },
        { kind: 'flow-hand-off', proposalIndex: 0, status: 'launched', at: 't', railIndex: 1 },
      ]} /></Providers>)
    expect(screen.getByTestId('flow-offer-stub-flow')).toHaveTextContent('Flow handed off to Rail 2')
  })
})
