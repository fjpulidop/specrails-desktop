import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

const ws = vi.hoisted(() => ({
  handlers: new Map<string, (message: unknown) => void>(),
  status: 'connected' as string,
}))
vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (id: string, fn: (message: unknown) => void) => { ws.handlers.set(id, fn) },
    unregisterHandler: (id: string) => { ws.handlers.delete(id) },
    connectionStatus: ws.status,
  }),
}))

import { MissionSessionsProvider, useMissionSession, useMissionSessions } from '../MissionSessionsContext'
import type { AgentSubagent } from '../../lib/agent-api'

const node = (over: Partial<AgentSubagent> = {}): AgentSubagent => ({
  subagentId: 'sa-1', parentId: null, kind: 'background', agentType: null, description: 'Scan', phase: 'running', reason: null,
  restarts: 0, startedAt: '2026-10-07T10:00:00.000Z', endedAt: null, usage: null, toolUses: null, durationMs: null, resultSummary: null,
  launchedInTurnId: 't1', ...over,
})

function respond(routes: Record<string, unknown>) {
  const urls: Array<{ url: string; init?: RequestInit }> = []
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input)
    urls.push({ url, init })
    const key = Object.keys(routes).find((suffix) => url.includes(suffix))
    return new Response(JSON.stringify(key ? routes[key] : {}), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return urls
}

function Probe({ id }: { id: string }) {
  const view = useMissionSession(id)
  const { stopSubagents, backgroundConversationIds } = useMissionSessions()
  return <div>
    <output data-testid="phase">{view?.residentPhase ?? 'none'}</output>
    <output data-testid="count">{Object.keys(view?.subagents ?? {}).length}</output>
    <output data-testid="live">{view?.liveSubagents ?? -1}</output>
    <output data-testid="background">{[...backgroundConversationIds].sort().join(',')}</output>
    <button onClick={() => void stopSubagents(id, ['sa-1'])}>stop</button>
  </div>
}

const emit = (message: unknown) => act(() => { for (const handler of ws.handlers.values()) handler(message) })

describe('MissionSessionsProvider', () => {
  beforeEach(() => { ws.handlers.clear(); ws.status = 'connected' })

  it('loads a mission once and applies its WebSocket events', async () => {
    const urls = respond({ '/subagents': { subagents: [node()], session: { residentPhase: 'background', processAlive: true, liveSubagents: 1, subagents: [] } } })
    const { rerender } = render(<MissionSessionsProvider><Probe id="c1" /></MissionSessionsProvider>)
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'))
    expect(screen.getByTestId('phase')).toHaveTextContent('background')
    rerender(<MissionSessionsProvider><Probe id="c1" /></MissionSessionsProvider>)
    expect(urls.filter((call) => call.url.endsWith('/conversations/c1/subagents'))).toHaveLength(1)
    emit({ type: 'agent_subagent', conversationId: 'c1', subagent: node({ subagentId: 'sa-2' }) })
    emit({ type: 'agent_resident_state', conversationId: 'c1', phase: 'idle', liveSubagents: 0 })
    emit({ type: 'unrelated', conversationId: 'c1' })
    expect(screen.getByTestId('count')).toHaveTextContent('2')
    expect(screen.getByTestId('phase')).toHaveTextContent('idle')
  })

  it('builds a view from bare rows and stops sub-agents through the API', async () => {
    const urls = respond({ '/subagents/stop': { stopped: ['sa-1'] }, '/subagents': { subagents: [node({ phase: 'idle' })], session: null } })
    render(<MissionSessionsProvider><Probe id="c1" /></MissionSessionsProvider>)
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'))
    act(() => { screen.getByText('stop').click() })
    await waitFor(() => expect(urls.some((call) => call.url.endsWith('/subagents/stop'))).toBe(true))
    const stop = urls.find((call) => call.url.endsWith('/subagents/stop'))!
    expect(JSON.parse(String(stop.init?.body))).toEqual({ subagentIds: ['sa-1'] })
  })

  it('shares one handler across nested providers', () => {
    respond({ '/subagents': { subagents: [], session: null } })
    render(<MissionSessionsProvider><MissionSessionsProvider><Probe id="c1" /></MissionSessionsProvider></MissionSessionsProvider>)
    expect(ws.handlers.size).toBe(1)
  })

  it('reconciles live sessions from the active-turns snapshot after a reconnect', async () => {
    respond({
      '/active-turns': { conversations: [], sessions: [{ conversationId: 'c2', residentPhase: 'background', processAlive: true, liveSubagents: 1, subagents: [node()] }] },
      '/subagents': { subagents: [], session: null },
    })
    ws.status = 'disconnected'
    const ui = (id: string) => <MissionSessionsProvider><Probe id={id} /></MissionSessionsProvider>
    const { rerender } = render(ui('c1'))
    emit({ type: 'agent_resident_state', conversationId: 'c1', phase: 'background', liveSubagents: 2 })
    expect(screen.getByTestId('live')).toHaveTextContent('2')
    ws.status = 'connected'
    rerender(ui('c1'))
    await waitFor(() => expect(screen.getByTestId('live')).toHaveTextContent('0'))
    expect(screen.getByTestId('phase')).toHaveTextContent('idle')
    rerender(ui('c2'))
    expect(screen.getByTestId('phase')).toHaveTextContent('background')
    expect(screen.getByTestId('background')).toHaveTextContent('c2')
  })

  it('reads live background work from the snapshot on first mount', async () => {
    respond({
      '/active-turns': { conversations: [], sessions: [{ conversationId: 'c7', residentPhase: 'idle', processAlive: true, liveSubagents: 2, subagents: [] }] },
      '/subagents': { subagents: [], session: null },
    })
    render(<MissionSessionsProvider><Probe id="c1" /></MissionSessionsProvider>)
    await waitFor(() => expect(screen.getByTestId('background')).toHaveTextContent('c7'))
  })

  it('is inert outside a provider', () => {
    render(<Probe id="c1" />)
    expect(screen.getByTestId('phase')).toHaveTextContent('none')
  })
})
