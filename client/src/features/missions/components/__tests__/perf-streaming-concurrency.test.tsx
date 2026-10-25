/**
 * Streaming-concurrency harness (perf-pass 2026-10).
 *
 * Mounts the real AgentChatProvider + the mission conversation view with a mocked
 * WS that streams tokens for three BACKGROUND missions, then measures what the
 * person feels: renders of the open mission / app shell / sidebar per background
 * token, markdown renders, time to open a long mission, and requests on open.
 *
 * Numbers are jsdom-relative (React work, not paint) — compare before/after on the
 * same machine. Set PERF_OUT=<file.json> to dump the metrics.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, type ReactNode } from 'react'
import { render, cleanup } from '@testing-library/react'
import { writeFileSync } from 'node:fs'

const wsHandlers = new Map<string, (msg: unknown) => void>()
/** Fan a WS message out to every registered handler, like the shared socket. */
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
  useUiMode: () => ({ uiMode: 'agent', setUiMode: vi.fn(), toggleUiMode: vi.fn() }),
}))
vi.mock('../../../providers/hooks/useAvailableProviders', () => ({
  useAvailableProviders: () => ({ available: { claude: true }, availableIds: ['claude'], issues: {}, launchDescriptors: {}, loading: false }),
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }))

const markdownRenders = vi.hoisted(() => ({ count: 0 }))
vi.mock('react-markdown', async (orig) => {
  const actual = await orig<typeof import('react-markdown')>()
  const Real = actual.default
  return { ...actual, default: (props: Parameters<typeof Real>[0]) => { markdownRenders.count++; return Real(props) } }
})

const { CONVS, transcript, requests } = vi.hoisted(() => {
const CONVS = ['c1', 'c2', 'c3', 'c4'].map((id) => ({
  id, title: `Mission ${id}`, provider: 'claude', model: null, session_id: null, pinned_project_id: null,
  tier_level: 0 as const, created_at: '', updated_at: '',
}))
const transcript = (conversationId: string, n: number) => Array.from({ length: n }, (_, i) => ({
  id: `${conversationId}-m${i}`, conversation_id: conversationId, role: (i % 2 ? 'assistant' : 'user') as 'assistant' | 'user',
  content: i % 2
    ? `## Step ${i}\n\nI changed **three files** and ran the suite.\n\n- item one\n- item two with \`code\`\n\n\`\`\`ts\nconst x = ${i}\nexport function f${i}() { return x }\n\`\`\`\n\nDone.`
    : `Please continue with step ${i}`,
  created_at: '2026-10-24T10:00:00.000Z',
}))

  const requests: string[] = []
  return { CONVS, transcript, requests }
})
vi.mock('../../lib/agent-api', async (orig) => {
  const actual = await orig<typeof import('../../lib/agent-api')>()
  const count = <T,>(name: string, value: T) => async (...args: unknown[]) => { requests.push(`${name}:${String(args[0] ?? '')}`); return value }
  return {
    ...actual,
    listAgentConversations: vi.fn(count('list', CONVS)),
    createAgentConversation: vi.fn(async () => CONVS[0]),
    getAgentConversation: vi.fn(async (id: string) => {
      requests.push(`get:${id}`)
      await new Promise((r) => setTimeout(r, 15)) // network
      return { conversation: CONVS.find((c) => c.id === id)!, messages: transcript(id, 160) }
    }),
    listAgentAttachments: vi.fn(count('attachments', [])),
    patchAgentConversation: vi.fn(async () => CONVS[0]),
    getMcpStatus: vi.fn(count('mcp', { enabled: true, running: true })),
    getAvailableProviders: vi.fn(count('providers', { any: true, installed: ['claude'] })),
    getAgentActiveTurns: vi.fn(count('active-turns', { snapshotVersion: 1, capturedAt: new Date().toISOString(), turns: [] })),
    getMissionSubagents: vi.fn(count('subagents', { subagents: [], session: null })),
    getAgentModels: vi.fn(count('models', { models: [], supportsImageInput: true, customModelAliases: false, efforts: [] })),
  }
})

import { AgentChatProvider, useAgentChat } from '../../context/AgentChatContext'
import { AgentConversationView } from '../AgentConversationView'
import * as liveHooks from '../../hooks/useAgentLive'

const renders = { app: 0, sidebar: 0 }
/** Event-loop lag sampler: how long the main thread was blocked between 4ms ticks. */
function lagSampler() {
  const lags: number[] = []
  let last = performance.now()
  const timer = setInterval(() => { const now = performance.now(); lags.push(Math.max(0, now - last - 4)); last = now }, 4)
  return {
    stop() {
      clearInterval(timer)
      const sorted = [...lags].sort((a, b) => a - b)
      const sum = lags.reduce((a, b) => a + b, 0)
      return { samples: lags.length, blockedMs: Math.round(sum), p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0), maxMs: Math.round(sorted[sorted.length - 1] ?? 0) }
    },
  }
}
const reset = () => { markdownRenders.count = 0; renders.app = 0; renders.sidebar = 0 }

/** App-shell stand-in: uses chat actions only (like DesktopApp/App.tsx). */
function AppLike() {
  renders.app++
  const chat = useAgentChat()
  void chat.toggle
  return null
}
/** Sidebar stand-in: needs the set of streaming missions + unread. */
function SidebarLike() {
  renders.sidebar++
  const chat = useAgentChat()
  const streaming = liveHooks.useStreamingConversationIds()
  void chat.unreadConversationIds
  void streaming
  return null
}

let chatApi: ReturnType<typeof useAgentChat> | null = null
function Capture() {
  const chat = useAgentChat()
  useEffect(() => { chatApi = chat })
  return null
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <AgentChatProvider>
      <Capture />
      <AppLike />
      <SidebarLike />
      {children}
    </AgentChatProvider>
  )
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, timeout = 15000) {
  const t0 = performance.now()
  while (!cond()) {
    if (performance.now() - t0 > timeout) throw new Error('timeout')
    await tick(5)
  }
}
const metrics: Record<string, unknown> = {}

describe('streaming concurrency harness', () => {
  beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false })
  afterAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    // eslint-disable-next-line no-console
    console.log('PERF_METRICS', JSON.stringify(metrics, null, 2))
    if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, JSON.stringify(metrics, null, 2))
  })
  beforeEach(() => { cleanup(); requests.length = 0; chatApi = null; wsHandlers.clear(); vi.clearAllMocks() })

  it('background tokens do not re-render the open mission, the shell or the sidebar', async () => {
    render(<Shell><AgentConversationView variant="inline" /></Shell>)
    await until(() => chatApi !== null)
    await chatApi!.refreshConversations()
    await until(() => chatApi!.conversations.length === 4)
    await chatApi!.selectConversation('c1')
    await until(() => chatApi?.active?.id === 'c1' && chatApi.messages.length === 160)
    // The transcript backfills in a transition: wait until every row is mounted.
    await until(() => markdownRenders.count >= 80)
    await tick(300)
    reset()
    const lag = lagSampler()
    const TICKS = 60
    for (let i = 0; i < TICKS; i++) {
      for (const id of ['c2', 'c3', 'c4']) {
        for (let k = 0; k < 3; k++) wsHandler({ type: 'agent_stream', conversationId: id, delta: `tok${i}-${k} ` })
        await tick(0)
      }
      await tick(16)
    }
    await tick(400)
    metrics.backgroundTokens = {
      events: TICKS * 9,
      lag: lag.stop(), appRenders: renders.app, sidebarRenders: renders.sidebar,
      markdownRenders: markdownRenders.count,
    }
    // Regression bound: a background token must never re-render the open mission or the shell.
    expect(renders.app).toBeLessThanOrEqual(8)
    expect(renders.sidebar).toBeLessThanOrEqual(8)
    expect(markdownRenders.count).toBeLessThanOrEqual(2)
  }, 60000)

  it('opens a long mission quickly while three others stream', async () => {
    render(<Shell><AgentConversationView variant="inline" /></Shell>)
    await until(() => chatApi !== null)
    await chatApi!.refreshConversations()
    await until(() => chatApi!.conversations.length === 4)
    let n = 0
    const timer = setInterval(() => {
      for (const id of ['c2', 'c3', 'c4']) wsHandler({ type: 'agent_stream', conversationId: id, delta: `t${n++} ` })
    }, 16)
    await tick(200)
    reset()
    requests.length = 0
    const lag = lagSampler()
    const t0 = performance.now()
    void chatApi!.selectConversation('c1')
    await until(() => document.body.textContent?.includes('Step 159') === true || document.body.textContent?.includes('step 158') === true)
    const open = performance.now() - t0
    await tick(500)
    clearInterval(timer)
    metrics.openMission = {
      timeToLastMessageMs: Math.round(open),
      lag: lag.stop(), appRenders: renders.app, sidebarRenders: renders.sidebar,
      markdownRenders: markdownRenders.count,
      requests: [...requests],
    }
    expect(open).toBeLessThan(10000)
  }, 60000)

  it('streams the OPEN mission without re-rendering settled messages', async () => {
    render(<Shell><AgentConversationView variant="inline" /></Shell>)
    await until(() => chatApi !== null)
    await chatApi!.refreshConversations()
    await until(() => chatApi!.conversations.length === 4)
    await chatApi!.selectConversation('c1')
    await until(() => chatApi?.active?.id === 'c1' && chatApi.messages.length === 160)
    await until(() => markdownRenders.count >= 80)
    await tick(300)
    reset()
    const lag = lagSampler()
    for (let i = 0; i < 60; i++) {
      for (let k = 0; k < 3; k++) wsHandler({ type: 'agent_stream', conversationId: 'c1', delta: `word${i}-${k} ` })
      await tick(16)
    }
    await tick(400)
    metrics.activeTokens = { events: 180, lag: lag.stop(), appRenders: renders.app, sidebarRenders: renders.sidebar, markdownRenders: markdownRenders.count }
    expect(document.body.textContent).toContain('word0-0')
    // Settled messages are memoised: markdown renders only for the live bubble.
    expect(markdownRenders.count).toBeLessThan(400)
  }, 60000)

  it('revisits a mission from cache and revalidates once (stale-while-revalidate)', async () => {
    render(<Shell><AgentConversationView variant="inline" /></Shell>)
    await until(() => chatApi !== null)
    await chatApi!.refreshConversations()
    await chatApi!.selectConversation('c1')
    await until(() => chatApi?.active?.id === 'c1' && chatApi.messages.length === 160)
    await chatApi!.selectConversation('c2')
    await until(() => chatApi?.active?.id === 'c2' && chatApi.messages.length === 160)
    await tick(300)
    requests.length = 0
    const t0 = performance.now()
    const reopened = chatApi!.selectConversation('c1')
    await until(() => chatApi?.active?.id === 'c1' && (chatApi?.messages.length ?? 0) === 160)
    const painted = performance.now() - t0
    await reopened
    await tick(200)
    metrics.revisit = { timeToTranscriptStateMs: Math.round(painted), requests: [...requests.filter((r) => r.startsWith('get:'))] }
    expect(requests.filter((r) => r === 'get:c1')).toHaveLength(1) // one revalidation, no duplicate
  }, 60000)

  it('warms a mission on intent so the open needs no extra round trip', async () => {
    render(<Shell><AgentConversationView variant="inline" /></Shell>)
    await until(() => chatApi !== null)
    await chatApi!.refreshConversations()
    await chatApi!.selectConversation('c1')
    await until(() => chatApi?.active?.id === 'c1')
    requests.length = 0
    chatApi!.prefetchConversation?.('c3')
    chatApi!.prefetchConversation?.('c3') // hover jitter must not double-fetch
    await until(() => requests.includes('get:c3'))
    const t0 = performance.now()
    await chatApi!.selectConversation('c3')
    const open = performance.now() - t0
    await tick(100)
    metrics.prefetchedOpen = { selectResolvedMs: Math.round(open), requests: requests.filter((r) => r.startsWith('get:')) }
    // prefetch (1) + the revalidation read of the open (1); never a third.
    expect(requests.filter((r) => r === 'get:c3').length).toBeLessThanOrEqual(2)
    expect(chatApi?.active?.id).toBe('c3')
  }, 60000)

  it('a long streamed answer re-parses only its live tail', async () => {
    render(<Shell><AgentConversationView variant="inline" /></Shell>)
    await until(() => chatApi !== null)
    await chatApi!.refreshConversations()
    await chatApi!.selectConversation('c1')
    await until(() => chatApi?.active?.id === 'c1' && chatApi.messages.length === 160)
    await until(() => markdownRenders.count >= 80)
    const paragraph = (i: number) => `Paragraph ${i}: ${'the agent explains what it changed and why. '.repeat(10)}\n\n`
    for (let i = 0; i < 40; i++) wsHandler({ type: 'agent_stream', conversationId: 'c1', delta: paragraph(i) })
    await tick(800) // the smoothed reveal catches up with the 18 KB burst
    await until(() => document.body.textContent?.includes('Paragraph 39') === true, 20000)
    await tick(300)
    reset()
    const FRAMES = 40
    for (let i = 0; i < FRAMES; i++) {
      wsHandler({ type: 'agent_stream', conversationId: 'c1', delta: `live${i} ` })
      await tick(16)
    }
    await tick(300)
    metrics.longStreamTail = { frames: FRAMES, markdownRenders: markdownRenders.count, perFrame: +(markdownRenders.count / FRAMES).toFixed(2) }
    // Whole-text parsing would cost ~1 parse of 18 KB per frame; chunking keeps it to the tail (+ one per new chunk).
    expect(markdownRenders.count).toBeLessThan(FRAMES * 3)
  }, 60000)

  it('a turn starting and ending does not re-parse the settled transcript', async () => {
    render(<Shell><AgentConversationView variant="inline" /></Shell>)
    await until(() => chatApi !== null)
    await chatApi!.refreshConversations()
    await chatApi!.selectConversation('c1')
    await until(() => chatApi?.active?.id === 'c1' && chatApi.messages.length === 160)
    await until(() => markdownRenders.count >= 80)
    await tick(300)
    reset()
    wsHandler({ type: 'agent_stream', conversationId: 'c1', delta: 'Working' })
    await tick(300)
    wsHandler({ type: 'agent_done', conversationId: 'c1', messageId: 'done-1', fullText: 'All done' })
    await tick(400)
    metrics.turnBoundary = { markdownRenders: markdownRenders.count }
    // 80 assistant rows would re-parse on each boundary if rows followed the in-flight flag.
    expect(markdownRenders.count).toBeLessThan(20)
  }, 60000)
})
