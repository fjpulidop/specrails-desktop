/**
 * Regressions introduced (and fixed) around the live streaming store:
 * ghost tail from a stale prefetch, end-of-turn flicker, interactive cards in
 * old rows during a turn, content-visibility vs a restored scroll, and optimistic
 * rows surviving a background revalidation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, type ReactNode } from 'react'
import { render, cleanup } from '@testing-library/react'

const wsHandlers = new Map<string, (msg: unknown) => void>()
const wsHandler = (msg: unknown) => { for (const fn of [...wsHandlers.values()]) fn(msg) }
vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (id: string, fn: (m: unknown) => void) => { wsHandlers.set(id, fn) },
    unregisterHandler: (id: string) => { wsHandlers.delete(id) },
    connectionStatus: 'connected',
  }),
}))
vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects: [], activeProjectId: null, setActiveProjectId: vi.fn() }),
}))
vi.mock('../../../../context/UiModeContext', () => ({
  useUiMode: () => ({ uiMode: 'agent', requestedMode: 'agent', isPending: false, setUiMode: vi.fn(), toggleUiMode: vi.fn() }),
}))
vi.mock('../../../providers/hooks/useAvailableProviders', () => ({
  useAvailableProviders: () => ({ available: { claude: true }, availableIds: ['claude'], issues: {}, launchDescriptors: {}, loading: false }),
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }))

const { CONVS, state } = vi.hoisted(() => {
  const CONVS = ['c1', 'c2'].map((id) => ({
    id, title: `Mission ${id}`, provider: 'claude', model: null, session_id: null, pinned_project_id: null,
    tier_level: 0 as const, created_at: '', updated_at: '',
  }))
  const state = {
    transcripts: new Map<string, unknown[]>(),
    /** Resolves the NEXT snapshot read of a conversation (manual control). */
    gates: new Map<string, { release: () => void }>(),
    gated: new Set<string>(),
    live: new Map<string, { isStreaming: boolean; streamingText: string }>(),
  }
  return { CONVS, state }
})
vi.mock('../../lib/agent-api', async (orig) => {
  const actual = await orig<typeof import('../../lib/agent-api')>()
  const val = <T,>(value: T) => async () => value
  return {
    ...actual,
    listAgentConversations: vi.fn(val(CONVS)),
    createAgentConversation: vi.fn(async () => CONVS[0]),
    getAgentConversation: vi.fn(async (id: string) => {
      const snapshot = {
        conversation: CONVS.find((c) => c.id === id)!,
        messages: state.transcripts.get(id) ?? [],
        pendingMessages: [],
        live: state.live.get(id),
      }
      if (state.gated.has(id)) {
        state.gated.delete(id)
        await new Promise<void>((resolve) => { state.gates.set(id, { release: resolve }) })
      }
      return snapshot
    }),
    sendAgentMessage: vi.fn(() => new Promise(() => {})),
    listAgentAttachments: vi.fn(val([])),
    patchAgentConversation: vi.fn(val(CONVS[0])),
    getMcpStatus: vi.fn(val({ enabled: true, running: true })),
    getAvailableProviders: vi.fn(val({ any: true, installed: ['claude'] })),
    getAgentActiveTurns: vi.fn(val({ snapshotVersion: 1, capturedAt: new Date().toISOString(), turns: [] })),
    getMissionSubagents: vi.fn(val({ subagents: [], session: null })),
    getAgentModels: vi.fn(val({ models: [], supportsImageInput: true, customModelAliases: false, efforts: [] })),
  }
})

import { AgentChatProvider, useAgentChat, retainOptimisticRows, placeOptimisticRows } from '../../context/AgentChatContext'
import { AgentConversationView } from '../AgentConversationView'
import { MissionExtensionsProvider, type MissionExtensions, type MissionFenceCardProps } from '../../context/MissionExtensionsContext'
import { useIsConversationStreaming } from '../../hooks/useAgentLive'
import { saveMissionScroll } from '../../lib/mission-view-state'

let chatApi: ReturnType<typeof useAgentChat> | null = null
function Capture() {
  const chat = useAgentChat()
  useEffect(() => { chatApi = chat })
  return null
}
let c2Streaming = false
function Probe() {
  c2Streaming = useIsConversationStreaming('c2')
  return null
}
function Shell({ children }: { children?: ReactNode }) {
  return (
    <AgentChatProvider>
      <Capture />
      <Probe />
      {children}
    </AgentChatProvider>
  )
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, timeout = 8000) {
  const t0 = performance.now()
  while (!cond()) {
    if (performance.now() - t0 > timeout) throw new Error('timeout')
    await tick(5)
  }
}
const row = (conv: string, i: number, role: 'user' | 'assistant', content: string) => ({
  id: `${conv}-m${i}`, conversation_id: conv, role, content, created_at: '2026-10-24T10:00:00.000Z',
})
const longTranscript = (conv: string, n: number, extra: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => row(conv, i, i % 2 ? 'assistant' : 'user', extra[i] ?? `message ${i}`))

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false })
afterAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  cleanup(); chatApi = null; c2Streaming = false
  wsHandlers.clear(); state.transcripts.clear(); state.gates.clear(); state.gated.clear(); state.live.clear()
  vi.clearAllMocks()
})

async function boot(children?: ReactNode) {
  render(<Shell>{children}</Shell>)
  await until(() => chatApi !== null)
  await chatApi!.refreshConversations()
  await until(() => chatApi!.conversations.length === 2)
}

describe('ghost streaming tail', () => {
  it('a hover prefetch that resolves after the turn ended never revives the live state', async () => {
    state.transcripts.set('c2', longTranscript('c2', 4))
    state.live.set('c2', { isStreaming: true, streamingText: 'stale partial' })
    await boot()
    await chatApi!.selectConversation('c1')
    state.gated.add('c2')
    chatApi!.prefetchConversation?.('c2') // hover: the read is now in flight
    await until(() => state.gates.has('c2'))
    // The turn runs and ends while the read is still pending.
    wsHandler({ type: 'agent_stream', conversationId: 'c2', delta: 'hello' })
    await until(() => c2Streaming)
    wsHandler({ type: 'agent_done', conversationId: 'c2', messageId: 'c2-final', fullText: 'hello' })
    await until(() => !c2Streaming)
    // Click: the open shares the pending read; the old response lands afterwards.
    const opening = chatApi!.selectConversation('c2')
    await tick(20)
    state.gates.get('c2')!.release()
    await opening
    await until(() => chatApi?.active?.id === 'c2')
    await tick(150)
    expect(c2Streaming).toBe(false)
  })
})

describe('end-of-turn hand-off', () => {
  it('the streamed answer is never off screen between the tail and its final row', async () => {
    state.transcripts.set('c1', longTranscript('c1', 40))
    await boot(<AgentConversationView variant="inline" />)
    await chatApi!.selectConversation('c1')
    await until(() => chatApi?.active?.id === 'c1' && chatApi.messages.length === 40)
    await until(() => document.body.textContent?.includes('message 39') === true)
    const ANSWER = 'zzanswerzz'
    wsHandler({ type: 'agent_stream', conversationId: 'c1', delta: ANSWER })
    await until(() => document.body.textContent?.includes(ANSWER) === true)
    const seen: boolean[] = []
    const observer = new MutationObserver(() => { seen.push(document.body.textContent?.includes(ANSWER) === true) })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    wsHandler({ type: 'agent_done', conversationId: 'c1', messageId: 'c1-final', fullText: ANSWER })
    await until(() => chatApi!.messages.some((m) => m.id === 'c1-final'))
    await tick(400)
    observer.disconnect()
    expect(document.body.textContent).toContain(ANSWER)
    expect(seen.includes(false)).toBe(false)
  })
})

describe('interactive cards in older rows during a turn', () => {
  it('stay disabled while the conversation streams, even many rows from the end', async () => {
    const Offer = ({ isStreaming }: MissionFenceCardProps) => <button data-testid="old-offer" disabled={isStreaming}>choose</button>
    const extensions = { fenceCards: { 'test-offer': Offer } } as unknown as MissionExtensions
    state.transcripts.set('c1', longTranscript('c1', 20, { 1: 'Pick one\n\n```test-offer\n{}\n```' }))
    await boot(<MissionExtensionsProvider value={extensions}><AgentConversationView variant="inline" /></MissionExtensionsProvider>)
    await chatApi!.selectConversation('c1')
    await until(() => document.querySelector('[data-testid="old-offer"]') !== null)
    const button = () => document.querySelector<HTMLButtonElement>('[data-testid="old-offer"]')!
    expect(button().disabled).toBe(false)
    wsHandler({ type: 'agent_stream', conversationId: 'c1', delta: 'working' })
    await until(() => button().disabled)
    wsHandler({ type: 'agent_done', conversationId: 'c1', messageId: 'c1-final', fullText: 'working' })
    await until(() => !button().disabled)
  })
})

describe('scroll position on revisit', () => {
  it('lays rows out fully when a mission reopens mid-history (no content-visibility estimates)', async () => {
    state.transcripts.set('c1', longTranscript('c1', 40))
    saveMissionScroll('c1', { top: 500, atBottom: false })
    await boot(<AgentConversationView variant="inline" />)
    await chatApi!.selectConversation('c1')
    await until(() => document.body.textContent?.includes('message 39') === true)
    expect(document.querySelectorAll('[class*="content-visibility"]')).toHaveLength(0)
  })
  it('keeps content-visibility for a mission that opens at the bottom', async () => {
    state.transcripts.set('c1', longTranscript('c1', 40))
    saveMissionScroll('c1', { top: 0, atBottom: true })
    await boot(<AgentConversationView variant="inline" />)
    await chatApi!.selectConversation('c1')
    await until(() => document.body.textContent?.includes('message 39') === true)
    await until(() => document.querySelectorAll('[class*="content-visibility"]').length > 0)
  })
})

describe('optimistic rows and background revalidation', () => {
  const msg = (id: string, role: 'user' | 'assistant', content: string) => ({ id, conversation_id: 'c1', role, content, created_at: '' })
  it('keeps unsent local rows and error notes the snapshot does not carry', () => {
    const current = [msg('m1', 'user', 'a'), msg('local-u-q1', 'user', 'pending'), msg('err-1', 'assistant', 'failed')]
    const persisted = [msg('m1', 'user', 'a')]
    expect(retainOptimisticRows(current, persisted).map((m) => m.id)).toEqual(['local-u-q1', 'err-1'])
  })
  it('drops a local row once its acknowledged server id is in the snapshot (no duplicate)', () => {
    const current = [msg('local-u-q1', 'user', 'hello')]
    const serverIdOf = (queueId: string) => (queueId === 'q1' ? 'm9' : undefined)
    expect(retainOptimisticRows(current, [msg('m9', 'user', 'hello')], serverIdOf)).toEqual([])
  })
  it('never matches by content: a repeated "ok" does not swallow the unsent one', () => {
    const current = [msg('local-u-q2', 'user', 'ok')]
    // The snapshot has an earlier, different "ok"; the second is still on its way.
    expect(retainOptimisticRows(current, [msg('m1', 'user', 'ok')]).map((m) => m.id)).toEqual(['local-u-q2'])
    expect(retainOptimisticRows(current, [msg('m1', 'user', 'ok')], () => undefined).map((m) => m.id)).toEqual(['local-u-q2'])
  })
  it('an error note goes back after the row it followed, not to the end', () => {
    const err = { ...msg('err-1', 'assistant', 'failed'), client_after_id: 'm1' }
    const persisted = [msg('m1', 'user', 'a'), msg('m2', 'assistant', 'b'), msg('m3', 'user', 'c')]
    const kept = retainOptimisticRows([err], persisted)
    expect(placeOptimisticRows(persisted, kept).map((m) => m.id)).toEqual(['m1', 'err-1', 'm2', 'm3'])
    // Without an anchor (or when it is gone) it appends, as before.
    expect(placeOptimisticRows(persisted, [msg('err-2', 'assistant', 'x')]).map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'err-2'])
  })
  it('keeps several optimistic rows anchored to the same row in order', () => {
    const a = { ...msg('err-1', 'assistant', 'one'), client_after_id: 'm1' }
    const b = { ...msg('err-2', 'assistant', 'two'), client_after_id: 'm1' }
    expect(placeOptimisticRows([msg('m1', 'user', 'a'), msg('m2', 'user', 'b')], [a, b]).map((m) => m.id)).toEqual(['m1', 'err-1', 'err-2', 'm2'])
  })
  it('a revalidation read keeps the bubble of a message still being sent', async () => {
    state.transcripts.set('c1', longTranscript('c1', 4))
    await boot(<AgentConversationView variant="inline" />)
    await chatApi!.selectConversation('c1')
    await until(() => chatApi?.active?.id === 'c1' && chatApi.messages.length === 4)
    void chatApi!.send('still on its way')
    await until(() => chatApi!.messages.some((m) => m.id.startsWith('local-u-')))
    await chatApi!.selectConversation('c2')
    await until(() => chatApi?.active?.id === 'c2')
    await chatApi!.selectConversation('c1') // cached paint + background revalidate
    await tick(200)
    const mine = chatApi!.messages.filter((m) => m.content === 'still on its way')
    expect(mine).toHaveLength(1)
  })
})
