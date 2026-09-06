import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { runCodexLiveSession } from './codex-live-session'
import { getAdapter } from './index'
import type { AdapterEvent } from './types'
import { LiveInputDeliveryError, type LiveInputSink, type LiveSessionHooks } from './live-session-types'
import { appendCodexHeadroomRelayOverride, transformCodexArgsForWindows } from '../util/cli-prompt'
import { finaliseInvocationResult } from '../result-event'

type Frame = { id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: any }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
class FakeCodex extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  frames: Frame[] = []
  killed = false
  autoClose = true
  autoSteer = false
  handle: (frame: Frame) => void = frame => {
    if (!frame.method || frame.id === undefined) return
    if (frame.method === 'initialize') this.reply(frame, { userAgent: 'fixture' })
    if (frame.method === 'thread/start' || frame.method === 'thread/resume') this.reply(frame, { thread: { id: frame.params?.threadId ?? 'thread-1' } })
    if (frame.method === 'turn/start') this.reply(frame, { turn: { id: 'turn-1', status: 'inProgress' } })
    if (frame.method === 'turn/steer' && this.autoSteer) this.reply(frame, { turnId: 'turn-1' })
  }
  stdin = new Writable({
    write: (data, _encoding, callback) => {
      for (const line of data.toString().trim().split('\n')) {
        const frame = JSON.parse(line) as Frame
        this.frames.push(frame)
        queueMicrotask(() => this.handle(frame))
      }
      callback()
    },
    final: callback => { callback(); if (this.autoClose) queueMicrotask(() => this.emit('close', 0)) },
  })
  kill = vi.fn((_signal?: string) => { this.killed = true; if (this.autoClose) queueMicrotask(() => this.emit('close', null)); return true })
  send(...frames: Frame[]) { this.stdout.write(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n') }
  reply(request: Frame, result: unknown) { this.send({ id: request.id, result }) }
  notify(method: string, params: Record<string, unknown> = {}) { this.send({ method, params: { threadId: 'thread-1', turnId: 'turn-1', ...params } }) }
  complete(status = 'completed', extra: Record<string, unknown> = {}) { this.notify('turn/completed', { turn: { id: 'turn-1', status, items: [], ...extra } }) }
}
function launch(child = new FakeCodex(), overrides: Partial<LiveSessionHooks> = {}) {
  const ready = deferred<LiveInputSink>()
  const event = vi.fn<(event: AdapterEvent) => void>()
  const spawn = vi.fn(() => child as unknown as ChildProcess)
  const onSpawn = vi.fn()
  const hooks: LiveSessionHooks = {
    adapter: getAdapter('codex'), action: 'chat-turn', buildOpts: { prompt: 'Original request', model: 'gpt-6-astra', reasoning_effort: 'high' },
    cwd: '/fixture/agent', env: { PATH: '/fixture/bin', SENTINEL: 'preserved' }, spawn: spawn as LiveSessionHooks['spawn'],
    onSpawn, onEvent: event, onInputReady: sink => ready.resolve(sink), ...overrides,
  }
  const done = runCodexLiveSession(hooks)
  return { child, ready: ready.promise, event, spawn, onSpawn, done, hooks }
}
async function request(child: FakeCodex, method: string, occurrence = 1): Promise<Frame> {
  for (let i = 0; i < 30; i++) {
    const frame = child.frames.filter(frame => frame.method === method)[occurrence - 1]
    if (frame) return frame
    await Promise.resolve()
  }
  throw new Error(`Missing fixture request ${method} #${occurrence}`)
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('native Codex app-server live session', () => {
  it('confirms the initial prompt only on its turn/start ACK, before subsequent output, and classifies steering ACKs as received', async () => {
    const order: string[] = [], accepted = vi.fn(() => order.push('received'))
    const child = new FakeCodex(), ordinary = child.handle
    child.handle = frame => { if (frame.method !== 'turn/start') ordinary(frame) }
    const test = launch(child, { onInitialInputAccepted: accepted, onEvent: event => { if (event.kind === 'text-delta') order.push(event.text) } })
    const start = await request(child, 'turn/start')
    expect(accepted).not.toHaveBeenCalled()
    child.notify('turn/started', { turn: { id: 'turn-1', status: 'inProgress' } })
    child.notify('item/completed', { item: { type: 'userMessage', id: 'user-1', clientId: 'unrelated', content: [] } })
    expect(accepted).not.toHaveBeenCalled()
    child.send(
      { id: start.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'text-1', delta: 'Processing.' } },
    )
    const sink = await test.ready
    expect(sink.acceptedReceipt).toBe('received')
    expect(order).toEqual(['received', 'Processing.'])
    child.reply(start, { turn: { id: 'turn-1', status: 'inProgress' } })
    expect(accepted).toHaveBeenCalledOnce()
    child.complete(); await test.done
  })

  it.each(['rejected', 'closed'] as const)('does not confirm an initial prompt when its turn/start is %s', async ending => {
    const accepted = vi.fn(), child = new FakeCodex(), ordinary = child.handle
    child.handle = frame => { if (frame.method !== 'turn/start') ordinary(frame) }
    const test = launch(child, { onInitialInputAccepted: accepted })
    const start = await request(child, 'turn/start')
    if (ending === 'rejected') child.send({ id: start.id, error: { code: -32602, message: 'Cannot start a turn.' } })
    else child.emit('close', 1)
    await test.done
    expect(accepted).not.toHaveBeenCalled()
  })

  it('preserves admission spawn seam, environment, MCP overrides, model, effort and native images', async () => {
    const buildOpts = { prompt: 'Original\nrequest', model: 'gpt-6-astra', reasoning_effort: 'ultra' as const, imagePaths: ['/fixture/image.png'], extraArgs: ['-c', 'mcp_servers.specrails.env.SPECRAILS_AGENT_CAPABILITY_FILE="/fixture/cap"'] }
    const test = launch(undefined, { buildOpts })
    expect(test.onSpawn).toHaveBeenCalledOnce()
    expect(test.spawn).toHaveBeenCalledWith('codex', ['app-server', '--listen', 'stdio://', ...buildOpts.extraArgs], expect.objectContaining({
      cwd: '/fixture/agent', stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/fixture/bin', SENTINEL: 'preserved' },
    }))
    await test.ready
    expect(test.child.frames.slice(0, 4).map(frame => frame.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start'])
    expect((await request(test.child, 'thread/start')).params).toMatchObject({ model: 'gpt-6-astra', cwd: '/fixture/agent', approvalPolicy: 'never', sandbox: 'workspace-write' })
    expect((await request(test.child, 'turn/start')).params).toMatchObject({ model: 'gpt-6-astra', effort: 'ultra', input: [{ type: 'text', text: 'Original\nrequest', text_elements: [] }, { type: 'localImage', path: '/fixture/image.png' }] })
    test.child.notify('item/agentMessage/delta', { itemId: 'reply', delta: 'Done' })
    test.child.complete()
    const result = await test.done
    expect(result).toMatchObject({ code: 0, spawnFailed: false, sessionId: 'thread-1' })
    expect(result.events.filter(event => event.kind === 'text-delta')).toEqual([{ kind: 'text-delta', text: 'Done' }])
    expect(result.lastResultEvent).toMatchObject({ kind: 'result', payload: { session_id: 'thread-1', status: 'completed' } })
    expect(test.child.kill).not.toHaveBeenCalled()
  })

  it('honors the spawn binary override and preserves a read-only thread boundary', async () => {
    const test = launch(undefined, { binary: '/fixture/codex', buildOpts: { prompt: 'inspect only', model: 'gpt-6-astra', toolPolicy: 'read-only' } })
    await test.ready
    expect(test.spawn.mock.calls[0][0]).toBe('/fixture/codex')
    expect((await request(test.child, 'thread/start')).params?.sandbox).toBe('read-only')
    test.child.complete(); await test.done
  })

  it('steers within the same active turn and commits acknowledgement before text from the same stdout chunk', async () => {
    const ordered: string[] = []
    const test = launch(undefined, { onEvent: event => { if (event.kind === 'text-delta') ordered.push(event.text) } })
    const sink = await test.ready
    test.child.notify('item/started', { item: { type: 'commandExecution', id: 'tool-1', command: 'slow test', status: 'inProgress' } })
    const delivered = sink.send({ id: 'user-input-1', text: 'Also check accessibility', imagePaths: ['/fixture/a.png'] }, () => { ordered.push('committed user') })
    const steer = await request(test.child, 'turn/steer')
    expect(steer.params).toEqual({ threadId: 'thread-1', expectedTurnId: 'turn-1', clientUserMessageId: 'user-input-1', input: [{ type: 'text', text: 'Also check accessibility', text_elements: [] }, { type: 'localImage', path: '/fixture/a.png' }] })
    expect(ordered).toEqual([])
    test.child.send({ id: steer.id, result: { turnId: 'turn-1' } }, { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reply', delta: 'Including accessibility.' } })
    expect(ordered).toEqual(['committed user', 'Including accessibility.'])
    expect(await delivered).toBe(true)
    expect(test.child.frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1)
    expect(test.child.frames.some(frame => frame.method === 'turn/interrupt')).toBe(false)
    expect(test.child.kill).not.toHaveBeenCalled()
    test.child.complete(); await test.done
  })

  it('deduplicates input IDs and serializes distinct inputs without replay', async () => {
    const test = launch(), sink = await test.ready
    const ack = vi.fn()
    const one = sink.send({ id: 'one', text: 'first' }, ack)
    expect(sink.send({ id: 'one', text: 'first' }, ack)).toBe(one)
    await expect(sink.send({ id: 'one', text: 'different' })).rejects.toMatchObject({ ambiguous: false })
    const two = sink.send({ id: 'two', text: 'second' })
    const first = await request(test.child, 'turn/steer')
    expect(test.child.frames.filter(frame => frame.method === 'turn/steer')).toHaveLength(1)
    test.child.reply(first, { turnId: 'turn-1' }); expect(await one).toBe(true)
    const second = await request(test.child, 'turn/steer', 2)
    test.child.reply(second, { turnId: 'turn-1' }); expect(await two).toBe(true)
    expect(ack).toHaveBeenCalledOnce()
    test.child.complete(); await test.done
    expect(await sink.send({ id: 'after', text: 'next turn' })).toBe(false)
  })

  it('waits for an outstanding steering acknowledgement even when completion arrives first', async () => {
    const test = launch(), sink = await test.ready
    const delivered = sink.send({ id: 'one', text: 'follow-up' })
    const next = sink.send({ id: 'two', text: 'later' })
    const steer = await request(test.child, 'turn/steer')
    test.child.complete()
    expect(test.child.stdin.writableEnded).toBe(false)
    test.child.reply(steer, { turnId: 'turn-1' })
    expect(await delivered).toBe(true)
    expect(await next).toBe(false)
    expect(test.child.frames.filter(frame => frame.method === 'turn/steer')).toHaveLength(1)
    expect((await test.done).code).toBe(0)
  })

  it('keeps follow-up input unsent when turn/start already returns a completed turn', async () => {
    const child = new FakeCodex(), defaultHandle = child.handle
    child.handle = frame => frame.method === 'turn/start'
      ? child.reply(frame, { turn: { id: 'turn-1', status: 'completed', items: [] } }) : defaultHandle(frame)
    let sent: Promise<boolean> | undefined
    const test = launch(child, { onInputReady: sink => { sent = sink.send({ id: 'late', text: 'next turn' }) } })
    expect((await test.done).code).toBe(0)
    expect(await sent).toBe(false)
    expect(child.frames.some(frame => frame.method === 'turn/steer')).toBe(false)
  })

  it('returns false only for explicit no-active-turn rejection and surfaces other protocol rejections', async () => {
    const test = launch(), sink = await test.ready
    const stale = sink.send({ id: 'stale', text: 'follow-up' })
    const first = await request(test.child, 'turn/steer')
    test.child.send({ id: first.id, error: { code: -32602, message: 'no active turn' } })
    expect(await stale).toBe(false)
    const rejected = sink.send({ id: 'bad', text: 'follow-up' })
    const second = await request(test.child, 'turn/steer', 2)
    test.child.send({ id: second.id, error: { code: -32602, message: 'unsupported input type' } })
    await expect(rejected).rejects.toMatchObject({ ambiguous: false })
    test.child.complete(); await test.done
  })

  it('retains ambiguous acknowledgement loss as an error and never writes that ID twice', async () => {
    const test = launch(), sink = await test.ready
    const delivered = sink.send({ id: 'uncertain', text: 'follow-up' })
    const asserted = expect(delivered).rejects.toMatchObject({ ambiguous: true })
    await request(test.child, 'turn/steer')
    test.child.emit('close', 1)
    await asserted
    await expect(sink.send({ id: 'uncertain', text: 'follow-up' })).rejects.toMatchObject({ ambiguous: true })
    expect(test.child.frames.filter(frame => frame.method === 'turn/steer')).toHaveLength(1)
    expect((await test.done).code).toBe(1)
  })

  it('does not stream past a failed local acceptance callback or wrong-turn acknowledgement', async () => {
    for (const wrongTurn of [false, true]) {
      const test = launch(), sink = await test.ready
      const delivered = sink.send({ id: 'one', text: 'follow-up' }, () => { if (!wrongTurn) throw new Error('database unavailable') })
      const asserted = expect(delivered).rejects.toMatchObject({ ambiguous: true })
      const steer = await request(test.child, 'turn/steer')
      test.child.send({ id: steer.id, result: { turnId: wrongTurn ? 'different-turn' : 'turn-1' } }, { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'late', delta: 'Must not be shown out of order' } })
      await asserted
      const result = await test.done
      expect(result.events.some(event => event.kind === 'text-delta')).toBe(false)
      expect(test.child.kill).toHaveBeenCalledOnce()
    }
  })

  it('resumes the native thread and accounts only the current turn rather than historical thread totals', async () => {
    const test = launch(undefined, { action: 'chat-resume', buildOpts: { prompt: 'continue', model: 'gpt-6-astra', sessionId: 'thread-1' } })
    await test.ready
    expect((await request(test.child, 'thread/resume')).params?.threadId).toBe('thread-1')
    expect(test.child.frames.some(frame => frame.method === 'thread/start')).toBe(false)
    const tokenUsage = (input: number, output: number, lastInput: number, lastOutput: number) => ({ total: { inputTokens: input, outputTokens: output, cachedInputTokens: input / 10, reasoningOutputTokens: output / 2 }, last: { inputTokens: lastInput, outputTokens: lastOutput, cachedInputTokens: lastInput / 10, reasoningOutputTokens: lastOutput / 2 } })
    test.child.notify('thread/tokenUsage/updated', { tokenUsage: tokenUsage(1100, 220, 100, 20) })
    test.child.notify('thread/tokenUsage/updated', { tokenUsage: tokenUsage(1150, 240, 50, 20) })
    test.child.notify('thread/tokenUsage/updated', { tokenUsage: tokenUsage(1150, 240, 50, 20) })
    test.child.complete()
    const result = await test.done
    expect(getAdapter('codex').extractResult(result.events)).toMatchObject({ tokens_in: 150, tokens_out: 40, tokens_cache_read: 15, num_turns: 1 })
  })

  it.each(['stop', 'disconnect', 'unexpected-zero-exit', 'timeout'] as const)('preserves observed partial usage after %s without a terminal notification', async (ending) => {
    vi.useFakeTimers()
    const test = launch(undefined, ending === 'timeout' ? { inactivityTimeoutMs: 100 } : {})
    await vi.advanceTimersByTimeAsync(0); await test.ready
    test.child.notify('thread/tokenUsage/updated', { tokenUsage: {
      total: { inputTokens: 1120, cachedInputTokens: 212, outputTokens: 430, reasoningOutputTokens: 110 },
      last: { inputTokens: 120, cachedInputTokens: 12, outputTokens: 30, reasoningOutputTokens: 10 },
    } })
    if (ending === 'stop') test.child.kill('SIGTERM')
    else if (ending === 'timeout') await vi.advanceTimersByTimeAsync(100)
    else test.child.emit('close', ending === 'disconnect' ? 1 : 0)
    await vi.advanceTimersByTimeAsync(0)
    const invocation = await test.done
    expect(invocation.lastResultEvent).toMatchObject({ kind: 'result', payload: {
      session_id: 'thread-1', status: ending === 'stop' ? 'interrupted' : 'failed',
    } })
    expect(invocation.events.filter(event => event.kind === 'result')).toHaveLength(1)
    expect(finaliseInvocationResult(getAdapter('codex'), invocation.events, { fallbackModel: 'gpt-6-astra' }).result)
      .toMatchObject({ tokens_in: 120, tokens_out: 30, tokens_cache_read: 12, num_turns: 1 })
    expect(invocation.timedOut).toBe(ending === 'timeout')
  })

  it('does not invent usage when the process closes before reporting tokens', async () => {
    const test = launch(); await test.ready
    test.child.emit('close', 1)
    const invocation = await test.done
    expect(invocation.lastResultEvent).toBeNull()
    const result = finaliseInvocationResult(getAdapter('codex'), invocation.events, { fallbackModel: 'gpt-6-astra' }).result
    expect(result.tokens_in).toBeUndefined()
    expect(result.tokens_out).toBeUndefined()
  })

  it('streams tool results and final-only text once, ignores foreign events and tolerates transient provider errors', async () => {
    const test = launch(); await test.ready
    test.child.notify('item/agentMessage/delta', { threadId: 'foreign', itemId: 'wrong', delta: 'wrong thread' })
    test.child.notify('error', { error: { message: 'retrying connection' }, willRetry: true })
    const tool = { type: 'mcpToolCall', id: 'tool-1', server: 'specrails', tool: 'specrails_specs', arguments: { action: 'list' }, status: 'completed', result: { content: [{ type: 'text', text: 'real result' }] } }
    test.child.notify('item/completed', { item: tool })
    test.child.notify('item/completed', { item: tool })
    test.child.notify('item/agentMessage/delta', { itemId: 'reply', delta: 'Hel' })
    test.child.notify('item/completed', { item: { type: 'agentMessage', id: 'reply', text: 'Hello' } })
    test.child.complete('completed', { items: [{ type: 'agentMessage', id: 'reply', text: 'Hello' }, { type: 'agentMessage', id: 'final', text: 'Finished.' }] })
    const result = await test.done
    expect(result.events.filter(event => event.kind === 'text-delta').map(event => event.text).join('')).toBe('HelloFinished.')
    expect(result.events.filter(event => event.kind === 'tool-use')).toHaveLength(1)
    expect(result.events.filter(event => event.kind === 'tool-result')).toHaveLength(1)
    expect(result.events.some(event => event.kind === 'error')).toBe(false)
  })

  it('preserves a terminal failure even if app-server exits zero', async () => {
    const test = launch(); await test.ready
    test.child.complete('failed', { error: { message: 'usage limit reached' } })
    const result = await test.done
    expect(result.code).toBe(1)
    expect(result.events).toContainEqual({ kind: 'error', message: 'usage limit reached' })
    expect(result.lastResultEvent).toMatchObject({ isError: true })
  })

  it('never grants requested permission escalation or executes unknown server requests', async () => {
    const test = launch(); await test.ready
    test.child.send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {} }, { id: 'approval-2', method: 'item/fileChange/requestApproval', params: {} }, { id: 'unknown', method: 'item/tool/call', params: { name: 'delete everything' } })
    expect(test.child.frames.filter(frame => frame.id === 'approval-1' || frame.id === 'approval-2').map(frame => frame.result)).toEqual([{ decision: 'decline' }, { decision: 'decline' }])
    expect(test.child.frames.find(frame => frame.id === 'unknown')?.error.code).toBe(-32601)
    test.child.complete(); await test.done
  })

  it('handles UTF-8 and JSON frames split across OS reads without truncating user-visible text', async () => {
    const test = launch(); await test.ready
    const bytes = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reply', delta: 'á 🚀' } }) + '\n')
    for (const byte of bytes) test.child.stdout.write(Buffer.from([byte]))
    test.child.complete()
    expect((await test.done).events).toContainEqual({ kind: 'text-delta', text: 'á 🚀' })
  })

  it('times out an unacknowledged steering request without stopping active work or replaying the input', async () => {
    vi.useFakeTimers()
    const test = launch()
    await vi.advanceTimersByTimeAsync(0)
    const sink = await test.ready
    const delivered = sink.send({ id: 'slow-ack', text: 'more context' })
    const assertion = expect(delivered).rejects.toMatchObject({ ambiguous: true })
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
    expect(test.child.kill).not.toHaveBeenCalled()
    test.child.complete(); await vi.advanceTimersByTimeAsync(0); await test.done
  })

  it('bounds handshake, inactivity, shutdown and broken protocol lifetimes', async () => {
    vi.useFakeTimers()
    const stalled = new FakeCodex(); stalled.handle = () => {}
    const first = launch(stalled)
    await vi.advanceTimersByTimeAsync(60_000)
    expect((await first.done).events).toContainEqual(expect.objectContaining({ kind: 'error', message: expect.stringContaining('initialize') }))
    const idle = launch(undefined, { inactivityTimeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(0); await idle.ready
    await vi.advanceTimersByTimeAsync(100)
    expect((await idle.done).timedOut).toBe(true)
    const hanging = new FakeCodex(); hanging.autoClose = false
    const third = launch(hanging)
    await vi.advanceTimersByTimeAsync(0); await third.ready
    hanging.complete()
    await vi.advanceTimersByTimeAsync(3500)
    expect((await third.done).code).toBe(0)
    expect(hanging.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
    const malformed = launch()
    await vi.advanceTimersByTimeAsync(0); await malformed.ready
    malformed.child.stdout.write('invalid JSON\n')
    expect((await malformed.done).events).toContainEqual({ kind: 'error', message: 'Codex app-server returned an invalid protocol frame.' })
    expect(malformed.child.stdin.destroyed).toBe(true)
    expect(malformed.child.stdout.destroyed).toBe(true)
    expect(malformed.child.stderr.destroyed).toBe(true)
  })

  it('reports spawn/admission failures and missing native resume identity without running a paid turn', async () => {
    const denied = launch(undefined, { spawn: () => { throw new Error('Process admission is closed') } })
    expect(await denied.done).toMatchObject({ spawnFailed: true, child: null })
    const noSession = launch(undefined, { action: 'chat-resume' })
    expect((await noSession.done).spawnFailed).toBe(true)
    expect(noSession.spawn).not.toHaveBeenCalled()
  })

  it('keeps app-server relay overrides authoritative and leaves Windows stdin available for JSON-RPC', () => {
    const args = appendCodexHeadroomRelayOverride(['app-server', '--listen', 'stdio://', '-c', 'model_provider="custom"'], 'http://127.0.0.1:4200/relay-token')
    expect(args.slice(-4)).toEqual(['-c', 'model_provider="openai"', '-c', 'openai_base_url="http://127.0.0.1:4200/relay-token/v1"'])
    expect(transformCodexArgsForWindows(args)).toEqual({ args, stdinPayload: null })
  })
})
