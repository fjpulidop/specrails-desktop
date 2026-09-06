import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileEventBus } from '../../mobile/mobile-event-bus'
import type { WsMessage } from '../../types'
import { watchTool } from './watch'
import type { McpToolContext } from './types'
import type { DbInstance } from '../../db'
import { acknowledgeNativeAgentSteering, notifyAgentSteering, onAgentSteering, registerAgentSteering, runWithAgentSteering } from '../../agent-steering'
import { mintAgentCapability, revokeAgentCapability } from '../agent-capability'

vi.mock('../../auth', () => ({ loadOrGenerateToken: () => 'watch-test-token' }))

describe('MCP watch durable recovery and event isolation', () => {
  let ctx: McpToolContext
  let fetchMock: ReturnType<typeof vi.fn>
  const tool = watchTool()
  const response = (data: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) })
  const emit = (event: Record<string, unknown>) => ctx.eventBus.publish(event as unknown as WsMessage)
  const watch = (args: Record<string, unknown> = {}) => tool.handler(ctx, {
    projectId: 'p1', ref: 'run-1', kind: 'loop_run', untilMs: 12_000, ...args,
  }) as Promise<{ settled: boolean; reason: string; eventCount: number; terminalEvent: Record<string, unknown>; events: Array<Record<string, unknown>> }>

  beforeEach(() => {
    vi.useFakeTimers()
    ctx = { eventBus: new MobileEventBus(), desktopPort: 4299, requestProjectId: null } as McpToolContext
    fetchMock = vi.fn().mockResolvedValue(response({ loopRun: { status: 'running' } }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it.each(['success', 'blocked', 'failed', 'stopped', 'max-cost'])('recovers an already finished loop immediately, preserving outcome %s', async (outcome) => {
    fetchMock.mockResolvedValue(response({ loopRun: { status: 'completed', final_outcome: outcome } }))
    const result = await watch()
    expect(result).toMatchObject({ settled: true, reason: `poll:loop_run:${outcome}`, terminalEvent: { outcome } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('/projects/p1/loop-runs/run-1')
    expect(ctx.eventBus.listenerCount('message')).toBe(0)
  })

  it.each(['failed', 'completed', 'canceled', 'skipped', 'zombie_terminated'])('reads terminal job status %s before the first 5s interval', async (status) => {
    fetchMock.mockResolvedValue(response({ job: { status } }))
    expect(await watch({ ref: 'job-1', kind: 'job' })).toMatchObject({ settled: true, reason: `poll:job:${status}` })
  })

  it('auto-detects UUID loop runs when there is no job row', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '{}' })
      .mockResolvedValueOnce(response({ loopRun: { status: 'completed', final_outcome: 'success' } }))
    const result = await watch({ kind: undefined, ref: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
    expect(result.reason).toBe('poll:loop_run:success')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('subscribes before polling and does not replace an event result with a late read', async () => {
    let complete!: (value: unknown) => void
    fetchMock.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    const waiting = watch()
    emit({ type: 'loop.run_completed', projectId: 'p1', loopRunId: 'run-1', status: 'blocked' })
    const result = await waiting
    complete(response({ loopRun: { status: 'completed', final_outcome: 'success' } }))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(result).toMatchObject({ reason: 'terminal:loop.run_completed', terminalEvent: { status: 'blocked' }, eventCount: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects substring ids, prose references, foreign projects and unrelated terminal types', async () => {
    const waiting = watch({ kind: undefined, ref: 'job-1', untilMs: 1000 })
    emit({ type: 'rail.job_completed', projectId: 'p1', jobId: 'job-10' })
    emit({ type: 'rail.job_completed', projectId: 'p1', jobId: 'other', text: 'job-1' })
    emit({ type: 'rail.job_completed', projectId: 'p2', jobId: 'job-1' })
    emit({ type: 'fake.rail.job_completed', projectId: 'p1', jobId: 'job-1' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await waiting).toMatchObject({ settled: false, reason: 'timeout', eventCount: 1 })
  })

  it('loop-kind ignores the earlier job accounting terminal and waits for the loop outcome', async () => {
    const waiting = watch()
    emit({ type: 'job.finalized', projectId: 'p1', jobId: 'run-1', status: 'completed' })
    expect(ctx.eventBus.listenerCount('message')).toBe(1)
    emit({ type: 'loop.run_completed', projectId: 'p1', loopRunId: 'run-1', status: 'failed' })
    expect(await waiting).toMatchObject({ reason: 'terminal:loop.run_completed', terminalEvent: { status: 'failed' } })
  })

  it('retries transient read errors and does not treat paused as completed', async () => {
    fetchMock.mockRejectedValueOnce(new Error('database starting'))
      .mockResolvedValueOnce(response({ loopRun: { status: 'paused' } }))
      .mockResolvedValueOnce(response({ loopRun: { status: 'completed', final_outcome: 'success' } }))
    const waiting = watch()
    await vi.advanceTimersByTimeAsync(5000)
    expect(ctx.eventBus.listenerCount('message')).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await waiting).toMatchObject({ settled: true, reason: 'poll:loop_run:success' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('bounds retained event count and large payloads without losing the terminal identity', async () => {
    const waiting = watch({ kind: undefined, ref: 'req-1' })
    for (let i = 0; i < 100; i++) emit({ type: 'spec_gen_stream', requestId: 'req-1', delta: 'x'.repeat(20_000) })
    emit({ type: 'spec_gen_done', requestId: 'req-1', ticket: { description: 'x'.repeat(100_000) } })
    const result = await waiting
    expect(result.eventCount).toBe(101)
    expect(result.events.length).toBeLessThanOrEqual(50)
    expect(JSON.stringify(result).length).toBeLessThan(280_000)
    expect(result.terminalEvent).toMatchObject({ type: 'spec_gen_done', requestId: 'req-1', truncated: true })
  })

  it('cancellation removes subscription, timers and in-flight REST reads without stopping the run', async () => {
    const controller = new AbortController()
    ctx.signal = controller.signal
    let readSignal!: AbortSignal
    fetchMock.mockImplementation((_url: string, options: { signal: AbortSignal }) => {
      readSignal = options.signal
      return new Promise((_resolve, reject) => readSignal.addEventListener('abort', () => reject(new Error('aborted'))))
    })
    const waiting = watch()
    controller.abort()
    expect(await waiting).toMatchObject({ settled: false, reason: 'canceled' })
    expect(readSignal.aborted).toBe(true)
    expect(ctx.eventBus.listenerCount('message')).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')
  })

  it('an already aborted watch neither subscribes nor calls the API', async () => {
    ctx.signal = AbortSignal.abort()
    expect(await watch()).toMatchObject({ settled: false, reason: 'canceled' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(ctx.eventBus.listenerCount('message')).toBe(0)
  })

  it('a mission update ends only the read wait and disposes its notification and polling resources', async () => {
    let notify!: () => void
    const unsubscribe = vi.fn()
    ctx.onMissionInput = listener => { notify = listener; return unsubscribe }
    let readSignal!: AbortSignal
    fetchMock.mockImplementation((_url: string, options: { signal: AbortSignal }) => {
      readSignal = options.signal
      return new Promise((_resolve, reject) => readSignal.addEventListener('abort', () => reject(new Error('read aborted'))))
    })
    const waiting = watch({ untilMs: 600_000 })
    notify()
    expect(await waiting).toMatchObject({ settled: false, reason: 'user_update', operationStopped: false })
    expect(readSignal.aborted).toBe(true)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(ctx.eventBus.listenerCount('message')).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')
  })

  it('handles an input reported synchronously during subscription without starting a read or leaving listeners', async () => {
    const unsubscribe = vi.fn()
    ctx.onMissionInput = listener => { listener(); return unsubscribe }
    expect(await watch()).toMatchObject({ settled: false, reason: 'user_update', operationStopped: false })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(ctx.eventBus.listenerCount('message')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('native steering wakes a real watch without requesting an unsupported MCP acknowledgement or stopping the operation', async () => {
    const database = {} as DbInstance
    const capability = mintAgentCapability({ conversationId: 'native-watch', projectId: 'p1', tierLevel: 3 })
    const consume = vi.fn(async () => ({ content: 'Must arrive through the native channel only.' }))
    const unregister = registerAgentSteering(database, capability, consume, { native: true })
    ctx.onMissionInput = listener => onAgentSteering(database, capability, listener)
    try {
      const waiting = runWithAgentSteering(database, capability, undefined, async () => ({
        content: [{ type: 'text', text: JSON.stringify(await watch({ untilMs: 600_000 })) }],
      }))
      expect(ctx.eventBus.listenerCount('message')).toBe(1)
      const revision = notifyAgentSteering(database, capability)!
      const result = await waiting
      expect(result.content).toHaveLength(1)
      const block = result.content[0] as { type: 'text'; text: string }
      expect(JSON.parse(block.text)).toMatchObject({ settled: false, reason: 'user_update', operationStopped: false })
      expect(block.text).not.toMatch(/acknowledge|acknowledge_updates/i)
      expect(consume).not.toHaveBeenCalled()
      expect(ctx.eventBus.listenerCount('message')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)

      // After receipt, a new watch waits for the same still-running operation.
      acknowledgeNativeAgentSteering(database, capability, revision)
      const resumed = watch()
      expect(ctx.eventBus.listenerCount('message')).toBe(1)
      emit({ type: 'loop.run_completed', projectId: 'p1', loopRunId: 'run-1', status: 'success' })
      expect(await resumed).toMatchObject({ settled: true, reason: 'terminal:loop.run_completed' })
      expect(fetchMock.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
      expect(consume).not.toHaveBeenCalled()
    } finally {
      unregister()
      revokeAgentCapability(capability)
    }
  })

  it('a durable watch without a project fails immediately with actionable input guidance', () => {
    expect(() => watch({ projectId: undefined })).toThrow('requires projectId or an active project')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { type: 'plugin.installed', name: 'serena' },
    { type: 'file.summary_skipped', path: 'server/app.ts' },
    { type: 'agent_refine_cancelled', refineId: 'refine-1' },
    { type: 'setup_install_done', projectId: 'p1' },
  ])('matches exact domain reference on $type', async (event) => {
    const ref = event.name ?? event.path ?? event.refineId ?? event.projectId
    const waiting = watch({ kind: undefined, ref })
    emit(event)
    expect(await waiting).toMatchObject({ settled: true, reason: `terminal:${event.type}` })
  })
})
