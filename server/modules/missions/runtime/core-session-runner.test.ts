import { describe, expect, it } from 'vitest'

import { SessionRequestError, type SessionEvent, type SessionEventEnvelope, type SessionHostClient } from '../../agent-sessions'
import type { LiveInputSink, LiveSessionHooks } from '../../../providers/live-session-types'
import type { AdapterEvent } from '../../../providers/types'
import { addUsage, createCoreSessionRunner, type TurnHandle } from './core-session-runner'

const at = '2026-10-07T10:00:00.000Z'
const tick = async () => { for (let index = 0; index < 6; index++) await new Promise((resolve) => setImmediate(resolve)) }
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: null, totalTokens: null, costUsd: 0.012, costEstimated: false, model: 'haiku' }

/** Minimal Core host: one session, scripted turn behaviour, real seq/journal semantics. */
class FakeCore implements SessionHostClient {
  closed = false
  exists = false
  requests: Array<{ method: string; params: Record<string, unknown> }> = []
  journal: SessionEventEnvelope[] = []
  /** What the provider does with an accepted input. */
  onInput: (inputId: string, delivery: string) => Array<Omit<SessionEvent, 'at'>> = (inputId) => [
    { type: 'input.state', inputId, state: 'started' },
    { type: 'turn.started', turnId: 't1', origin: 'user', inputIds: [inputId] },
    { type: 'session.provider-ref', providerSessionRef: 'prov-1' },
    { type: 'turn.output', turnId: 't1', channel: 'text', delta: 'Hel' },
    { type: 'turn.tool', turnId: 't1', toolUseId: 'tool-1', name: 'Read', phase: 'started', input: { file: 'a' } },
    { type: 'turn.tool', turnId: 't1', toolUseId: 'tool-1', name: 'Read', phase: 'completed', output: 'ok' },
    { type: 'turn.output', turnId: 't1', channel: 'text', delta: 'lo' },
    { type: 'turn.completed', turnId: 't1', status: 'completed', text: 'Hello', usage },
  ]
  dropLive: number[] = []
  private events = new Set<(envelope: SessionEventEnvelope) => void>()
  private lags = new Set<(sessionId: string, deliveredSeq: number) => void>()
  private closes = new Set<(reason: string) => void>()

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params })
    if (this.closed) throw new SessionRequestError('closed', { code: 'host_unavailable', retryable: true })
    switch (method) {
      case 'session.open':
        if (params.resume) {
          if (!this.exists) throw new SessionRequestError('Unknown session', { code: 'session_not_found', retryable: false })
          return { sessionId: 'conv-1', snapshot: { lastSeq: this.journal.length } } as T
        }
        this.exists = true
        this.push([{ type: 'session.opened', driver: String(params.driver), model: String(params.model), resumed: false, providerSessionRef: null }])
        return { sessionId: 'conv-1', snapshot: { lastSeq: this.journal.length } } as T
      case 'session.send': {
        const input = params.input as { inputId: string; delivery: string; text: string }
        this.push([{ type: 'input.accepted', inputId: input.inputId, delivery: input.delivery as 'queue', text: input.text }])
        setImmediate(() => this.push(this.onInput(input.inputId, input.delivery)))
        return { inputId: input.inputId, state: 'accepted' } as T
      }
      case 'session.events': {
        const rest = this.journal.filter((envelope) => envelope.seq > Number(params.afterSeq))
        return { events: rest, hasMore: false } as T
      }
      default:
        return {} as T
    }
  }

  push(bodies: Array<Omit<SessionEvent, 'at'>>) {
    let dropped = false
    for (const body of bodies) {
      const envelope = { sessionId: 'conv-1', seq: this.journal.length + 1, event: { ...body, at } as SessionEvent }
      this.journal.push(envelope)
      if (this.dropLive.includes(envelope.seq)) { dropped = true; continue }
      for (const listener of this.events) listener(envelope)
    }
    // Like Core's host: discarded notifications are announced with session.lagged.
    if (dropped) for (const listener of this.lags) listener('conv-1', 0)
  }
  onEvent(listener: (envelope: SessionEventEnvelope) => void) { this.events.add(listener); return () => { this.events.delete(listener) } }
  onLagged(listener: (sessionId: string, deliveredSeq: number) => void) { this.lags.add(listener); return () => { this.lags.delete(listener) } }
  onClose(listener: (reason: string) => void) { if (this.closed) { listener('closed'); return () => {} } this.closes.add(listener); return () => { this.closes.delete(listener) } }
  async close() { this.closed = true; for (const listener of this.closes) listener('closed') }
}

function hooks(overrides: Partial<LiveSessionHooks> = {}) {
  const events: AdapterEvent[] = []
  let sink: LiveInputSink | undefined
  let accepted = 0
  const value = {
    adapter: { id: 'claude' } as LiveSessionHooks['adapter'],
    cwd: '/tmp/agent',
    buildOpts: { prompt: 'say hello', model: 'haiku', systemPrompt: 'OPERATOR', sessionId: undefined, reasoning_effort: 'low' },
    onEvent: (event: AdapterEvent) => events.push(event),
    onInputReady: (ready: LiveInputSink) => { sink = ready },
    onInitialInputAccepted: () => { accepted += 1 },
    ...overrides,
  } as LiveSessionHooks
  return { value, events, sink: () => sink, accepted: () => accepted }
}

const context = (client: FakeCore, extra: Partial<Parameters<typeof createCoreSessionRunner>[0]> = {}) => ({
  sessionId: 'conv-1',
  client,
  driver: 'claude',
  policy: { subagents: 'enabled' as const, permissions: 'bypass' as const },
  mcpServers: [{ name: 'specrails', command: 'node', args: ['bridge.js'], env: { SPECRAILS_AGENT_CAPABILITY_FILE: '/x' } }],
  ...extra,
})

describe('CoreSessionTurnRunner', () => {
  it('opens the conversation session, maps the user turn to adapter events and reports Core usage', async () => {
    const core = new FakeCore()
    const handles: Array<TurnHandle | null> = []
    const h = hooks()
    const result = await createCoreSessionRunner(context(core, { legacyProviderSessionRef: 'legacy-claude-id', metadata: { conversationId: 'conv-1' }, onHandle: (handle) => handles.push(handle) }))(h.value)

    const open = core.requests.find((request) => request.method === 'session.open' && !request.params.resume)!
    expect(open.params).toMatchObject({ sessionId: 'conv-1', driver: 'claude', cwd: '/tmp/agent', model: 'haiku', effort: 'low', systemPrompt: 'OPERATOR', providerSessionRef: 'legacy-claude-id', metadata: { conversationId: 'conv-1' } })
    expect((open.params.policy as { mcp: { servers: unknown[]; inheritUserScope: boolean } }).mcp).toEqual({ servers: context(core).mcpServers, inheritUserScope: false })
    expect(core.requests.find((request) => request.method === 'session.send')!.params).toMatchObject({ input: { text: 'say hello', delivery: 'queue' } })
    expect(h.events.map((event) => event.kind)).toEqual(['session-started', 'text-delta', 'tool-use', 'tool-result', 'text-delta'])
    expect(h.events.filter((event) => event.kind === 'text-delta').map((event) => event.kind === 'text-delta' && event.text).join('')).toBe('Hello')
    expect(h.accepted()).toBe(1)
    expect(result).toMatchObject({ code: 0, spawnFailed: false, child: null, sessionId: 'prov-1', usage: { tokens_in: 100, tokens_out: 20, tokens_cache_read: 5, total_cost_usd: 0.012, model: 'haiku' } })
    expect(handles.map((handle) => handle === null ? 'cleared' : 'set')).toEqual(['set', 'cleared'])
  })

  it('resumes an existing session and realigns its configuration without a legacy reference', async () => {
    const core = new FakeCore()
    core.exists = true
    await createCoreSessionRunner(context(core, { legacyProviderSessionRef: 'ignored' }))(hooks().value)
    expect(core.requests.slice(0, 2).map((request) => request.method)).toEqual(['session.open', 'session.update'])
    expect(core.requests[0]!.params).toEqual({ resume: { sessionId: 'conv-1' } })
    expect(core.requests[1]!.params).toMatchObject({ sessionId: 'conv-1', model: 'haiku', effort: 'low' })
  })

  it('recovers missed live events from the journal and still completes with the authoritative text', async () => {
    const core = new FakeCore()
    core.dropLive = [5, 6, 7, 8, 9, 10]
    const h = hooks()
    const result = await createCoreSessionRunner(context(core))(h.value)
    expect(result.code).toBe(0)
    expect(h.events.filter((event) => event.kind === 'text-delta').map((event) => event.kind === 'text-delta' && event.text).join('')).toBe('Hello')
  })

  it('ignores continuation turns of the same session and other sessions', async () => {
    const core = new FakeCore()
    core.onInput = (inputId) => [
      { type: 'turn.started', turnId: 'bg', origin: 'subagent', inputIds: [] },
      { type: 'turn.output', turnId: 'bg', channel: 'text', delta: 'background' },
      { type: 'turn.completed', turnId: 'bg', status: 'completed', text: 'background', usage },
      { type: 'input.state', inputId, state: 'started' },
      { type: 'turn.started', turnId: 'mine', origin: 'user', inputIds: [inputId] },
      { type: 'turn.completed', turnId: 'mine', status: 'completed', text: 'mine', usage },
    ]
    const h = hooks()
    const result = await createCoreSessionRunner(context(core))(h.value)
    expect(result.code).toBe(0)
    expect(h.events).toEqual([{ kind: 'text-delta', text: 'mine' }])
  })

  it('steers into the open turn and refuses once it closed', async () => {
    const core = new FakeCore()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    core.onInput = (inputId, delivery) => delivery === 'steer' ? [] : [
      { type: 'input.state', inputId, state: 'started' },
      { type: 'turn.started', turnId: 't1', origin: 'user', inputIds: [inputId] },
    ]
    const h = hooks()
    const running = createCoreSessionRunner(context(core))(h.value)
    await tick()
    let accepted = false
    expect(await h.sink()!.send({ id: 'q-1', text: 'also this' }, () => { accepted = true })).toBe(true)
    expect(accepted).toBe(true)
    expect(core.requests.find((request) => (request.params.input as { delivery?: string } | undefined)?.delivery === 'steer')!.params).toMatchObject({ input: { inputId: 'q-1', text: 'also this' } })
    core.push([{ type: 'turn.completed', turnId: 't1', status: 'completed', text: 'done', usage }])
    release()
    await gate
    await running
    expect(await h.sink()!.send({ id: 'q-2', text: 'late' })).toBe(false)
  })

  it('stops through the turn handle and reports a stopped turn as killed (code null)', async () => {
    const core = new FakeCore()
    core.onInput = (inputId) => [
      { type: 'input.state', inputId, state: 'started' },
      { type: 'turn.started', turnId: 't1', origin: 'user', inputIds: [inputId] },
    ]
    let handle: TurnHandle | null = null
    const running = createCoreSessionRunner(context(core, { onHandle: (value) => { if (value) handle = value } }))(hooks().value)
    await tick()
    await handle!.interrupt()
    expect(core.requests.some((request) => request.method === 'session.interrupt')).toBe(true)
    core.push([{ type: 'turn.completed', turnId: 't1', status: 'stopped', text: 'partial', usage }])
    expect((await running).code).toBeNull()
  })

  it('fails the turn when the host stops or the input is rejected', async () => {
    const crashing = new FakeCore()
    crashing.onInput = (inputId) => [{ type: 'input.state', inputId, state: 'started' }, { type: 'turn.started', turnId: 't1', origin: 'user', inputIds: [inputId] }]
    const running = createCoreSessionRunner(context(crashing))(hooks().value)
    await tick()
    await crashing.close()
    expect(await running).toMatchObject({ code: 1, events: [expect.objectContaining({ kind: 'error', message: expect.stringContaining('session host stopped') })] })

    const rejecting = new FakeCore()
    rejecting.onInput = (inputId) => [{ type: 'input.state', inputId, state: 'interrupted', reason: 'delivery_failed' }]
    const rejected = await createCoreSessionRunner(context(rejecting))(hooks().value)
    expect(rejected.code).toBe(1)
    expect(rejected.events.at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('delivery_failed') })

    const refused = new FakeCore()
    refused.request = async () => { throw new SessionRequestError('Driver "claude" cannot disable sub-agents', { code: 'policy_unenforceable', retryable: false }) }
    expect(await createCoreSessionRunner(context(refused))(hooks().value)).toMatchObject({ code: 1, events: [expect.objectContaining({ message: expect.stringContaining('cannot disable') })] })
  })

  it('Flow: an interrupt cuts the turn, follows the correction and sums the usage of both turns', async () => {
    const core = new FakeCore()
    core.onInput = (inputId, delivery) => delivery === 'interrupt'
      ? [
          { type: 'turn.completed', turnId: 't1', status: 'interrupted', text: 'Start', usage },
          { type: 'input.state', inputId, state: 'started' },
          { type: 'turn.started', turnId: 't2', origin: 'user', inputIds: [inputId] },
          { type: 'turn.output', turnId: 't2', channel: 'text', delta: 'Corrected' },
          { type: 'turn.completed', turnId: 't2', status: 'completed', text: 'Corrected', usage: { ...usage, costUsd: 0.02, inputTokens: 50 } },
        ]
      : [
          { type: 'input.state', inputId, state: 'started' },
          { type: 'turn.started', turnId: 't1', origin: 'user', inputIds: [inputId] },
          { type: 'turn.output', turnId: 't1', channel: 'text', delta: 'Start' },
        ]
    const h = hooks()
    const running = createCoreSessionRunner(context(core, { sessionId: 'conv-1', inputDelivery: 'interrupt' }))(h.value)
    await tick()
    let accepted = false
    expect(await h.sink()!.send({ id: 'fix-1', text: 'use blue instead' }, () => { accepted = true })).toBe(true)
    expect(accepted).toBe(true)
    // Desktop never stops the turn first: the delivery itself cuts it.
    expect(core.requests.some((request) => request.method === 'session.interrupt')).toBe(false)
    expect(core.requests.find((request) => request.method === 'session.send' && (request.params.input as { inputId: string }).inputId === 'fix-1')!.params)
      .toMatchObject({ input: { inputId: 'fix-1', text: 'use blue instead', delivery: 'interrupt' } })
    const result = await running
    expect(result).toMatchObject({ code: 0, coreTurnId: 't2', usage: { tokens_in: 150, total_cost_usd: 0.032 } })
    expect(h.events.filter((event) => event.kind === 'text-delta').map((event) => (event as { text: string }).text)).toEqual(['Start', 'Corrected'])
  })

  it('Flow: a turn that finishes before the stop still hands over to the correction', async () => {
    const core = new FakeCore()
    core.onInput = (inputId, delivery) => delivery === 'interrupt'
      ? [
          { type: 'turn.completed', turnId: 't1', status: 'completed', text: 'Done early', usage },
          { type: 'turn.started', turnId: 't2', origin: 'user', inputIds: [inputId] },
          { type: 'turn.completed', turnId: 't2', status: 'completed', text: 'Then fixed', usage },
        ]
      : [{ type: 'input.state', inputId, state: 'started' }, { type: 'turn.started', turnId: 't1', origin: 'user', inputIds: [inputId] }]
    const h = hooks()
    const running = createCoreSessionRunner(context(core, { inputDelivery: 'interrupt' }))(h.value)
    await tick()
    await h.sink()!.send({ id: 'fix-2', text: 'and this' })
    expect(await running).toMatchObject({ code: 0, coreTurnId: 't2', usage: { tokens_in: 200 } })
    expect(h.events.filter((event) => event.kind === 'text-delta').map((event) => (event as { text: string }).text)).toEqual(['Done early', 'Then fixed'])
  })

  it('Flow: a rejected correction ends the turn with an explicit error and a failed send is never pending', async () => {
    const core = new FakeCore()
    core.onInput = (inputId, delivery) => delivery === 'interrupt'
      ? [
          { type: 'turn.completed', turnId: 't1', status: 'interrupted', text: '', usage },
          { type: 'input.state', inputId, state: 'rejected', reason: 'provider_refused' },
        ]
      : [{ type: 'input.state', inputId, state: 'started' }, { type: 'turn.started', turnId: 't1', origin: 'user', inputIds: [inputId] }]
    const h = hooks()
    const running = createCoreSessionRunner(context(core, { inputDelivery: 'interrupt' }))(h.value)
    await tick()
    await h.sink()!.send({ id: 'fix-3', text: 'nope' })
    const result = await running
    expect(result.code).toBe(1)
    expect(result.events.at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('provider_refused') })

    const failing = new FakeCore()
    failing.onInput = (inputId) => [{ type: 'input.state', inputId, state: 'started' }, { type: 'turn.started', turnId: 't1', origin: 'user', inputIds: [inputId] }]
    const h2 = hooks()
    const run2 = createCoreSessionRunner(context(failing, { inputDelivery: 'interrupt' }))(h2.value)
    await tick()
    const original = failing.request.bind(failing)
    failing.request = async (method, params) => { if (method === 'session.send') throw new Error('host busy'); return original(method, params) }
    await expect(h2.sink()!.send({ id: 'fix-4', text: 'x' })).rejects.toThrow('host busy')
    failing.request = original
    failing.push([{ type: 'turn.completed', turnId: 't1', status: 'completed', text: 'ok', usage }])
    expect((await run2).code).toBe(0)
  })

  it('adds per-turn usage keeping unknown values unknown and estimates flagged', () => {
    const unknown = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, costUsd: null, costEstimated: false, model: null }
    expect(addUsage(null, null)).toBeNull()
    expect(addUsage(unknown, unknown)).toEqual(unknown)
    expect(addUsage(usage, { ...unknown, costEstimated: true, model: 'sonnet' })).toMatchObject({ inputTokens: 100, costUsd: 0.012, costEstimated: true, model: 'sonnet' })
  })
})
