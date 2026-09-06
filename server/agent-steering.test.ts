import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { DbInstance } from './db'
import {
  acknowledgeAgentSteering, acknowledgeAgentInputsRead, notifyAgentSteering, onAgentSteering, registerAgentSteering, runWithAgentSteering,
  type SteeringConsumer, type SteeringConsumerContext,
} from './agent-steering'
import { _resetAgentCapabilitiesForTest, mintAgentCapability, revokeAgentCapability } from './mcp/agent-capability'

const db = () => ({}) as DbInstance
const capability = () => mintAgentCapability({ conversationId: 'mission-1', projectId: 'project-1', tierLevel: 3 })
const result = (text = 'executed'): CallToolResult => ({ content: [{ type: 'text', text }] })
const blocks = (value: CallToolResult) => value.content.filter(block => block.type === 'text').flatMap(block => {
  try { return [JSON.parse(block.text)] } catch { return [] }
})
const updates = (value: CallToolResult) => blocks(value).filter(block => block.type === 'mission_user_updates')
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
const dispatch = (database: DbInstance, token: string, operation = vi.fn(async () => result()), signal?: AbortSignal) =>
  runWithAgentSteering(database, token, signal, operation)

afterEach(() => { _resetAgentCapabilitiesForTest(); vi.restoreAllMocks() })

describe('authenticated mission steering boundary', () => {
  it('starts an ungated handler synchronously and preserves its result', async () => {
    const database = db(), token = capability(), operation = vi.fn(async () => result())
    const consume = vi.fn<SteeringConsumer>(async () => null)
    registerAgentSteering(database, token, consume)
    const request = dispatch(database, token, operation)
    expect(operation).toHaveBeenCalledOnce()
    expect(await request).toEqual(result())
    expect(consume).not.toHaveBeenCalled()
  })

  it('serializes parallel delivery, keeps all stale calls gated, and releases only after acknowledgement', async () => {
    const database = db(), token = capability(), ready = deferred(), entered = deferred()
    const consume = vi.fn<SteeringConsumer>(async () => { entered.resolve(); await ready.promise; return { content: 'Use #2 instead.' } })
    registerAgentSteering(database, token, consume)
    expect(notifyAgentSteering(database, token)).toBe(1)
    const operation = vi.fn(async () => result())
    const first = dispatch(database, token, operation)
    const parallel = dispatch(database, token, operation)
    await entered.promise
    expect(consume).toHaveBeenCalledOnce()
    ready.resolve()
    const replies = await Promise.all([first, parallel])
    for (const reply of replies) {
      expect(reply.isError).toBe(true)
      expect(blocks(reply)[0]).toMatchObject({ code: 'tool_not_executed', executed: false })
      expect(updates(reply)).toMatchObject([{ revision: 1, content: 'Use #2 instead.' }])
    }
    await dispatch(database, token, operation)
    expect(operation).not.toHaveBeenCalled()
    expect(consume).toHaveBeenCalledOnce()
    expect(acknowledgeAgentSteering(database, token, 1)).toMatchObject({ acknowledged: true })
    expect(await dispatch(database, token, operation)).toEqual(result())
    expect(operation).toHaveBeenCalledOnce()
  })

  it('lets all running actions settle before consuming and preserves success and error evidence', async () => {
    const database = db(), token = capability(), firstDone = deferred<CallToolResult>(), secondDone = deferred<CallToolResult>()
    const consume = vi.fn<SteeringConsumer>(async () => ({ content: 'Stop after the existing operation.' }))
    const onAcknowledged = vi.fn()
    registerAgentSteering(database, token, consume, { onAcknowledged })
    const first = dispatch(database, token, vi.fn(() => firstDone.promise))
    const second = dispatch(database, token, vi.fn(() => secondDone.promise))
    notifyAgentSteering(database, token)
    const staleOperation = vi.fn(async () => result())
    const withheld = await dispatch(database, token, staleOperation)
    expect(blocks(withheld)[0].reason).toBe('waiting_for_running_tools')
    expect(consume).not.toHaveBeenCalled()
    firstDone.resolve(result('Already created job 42'))
    const firstReply = await first
    expect(firstReply.content[0]).toEqual(result('Already created job 42').content[0])
    expect(updates(firstReply)).toEqual([])
    expect(consume).not.toHaveBeenCalled()
    expect(() => acknowledgeAgentSteering(database, token, 1)).toThrow()
    expect(onAcknowledged).not.toHaveBeenCalled()
    const failure = { ...result('Error: integration blocked by conflict'), isError: true, _meta: { evidence: 'preserved' } }
    secondDone.resolve(failure)
    const lastReply = await second
    expect(lastReply).toMatchObject({ isError: true, _meta: failure._meta })
    expect(lastReply.content[0]).toEqual(failure.content[0])
    expect(updates(lastReply)).toHaveLength(1)
    expect(staleOperation).not.toHaveBeenCalled()
    expect(consume).toHaveBeenCalledOnce()
    expect(onAcknowledged).not.toHaveBeenCalled()
    acknowledgeAgentSteering(database, token, 1)
    expect(onAcknowledged).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('never lets an acknowledgement of an older revision release a newer input', async () => {
    const database = db(), token = capability(), ready = deferred(), entered = deferred()
    const consume = vi.fn<SteeringConsumer>(async context => {
      if (context.revision === 1) { entered.resolve(); await ready.promise }
      return { content: `message ${context.revision}` }
    })
    registerAgentSteering(database, token, consume)
    notifyAgentSteering(database, token)
    const first = dispatch(database, token)
    await entered.promise
    expect(notifyAgentSteering(database, token)).toBe(2)
    ready.resolve()
    expect(updates(await first)).toMatchObject([{ revision: 1 }])
    const stillGated = await dispatch(database, token)
    expect(updates(stillGated)).toMatchObject([{ revision: 1 }])
    expect(consume).toHaveBeenCalledOnce()
    expect(acknowledgeAgentSteering(database, token, 1)).toMatchObject({ acknowledged: true, pendingRevision: 2 })
    const newer = await dispatch(database, token)
    expect(newer.isError).toBe(true)
    expect(updates(newer)).toMatchObject([{ revision: 2 }])
    expect(consume.mock.calls.map(([context]) => context.revision)).toEqual([1, 2])
    expect(() => acknowledgeAgentSteering(database, token, 1)).toThrow()
    expect(acknowledgeAgentSteering(database, token, 2)).toMatchObject({ acknowledged: true })
  })

  it('keeps unavailable or failed preparation gated without exposing internal errors', async () => {
    const database = db(), token = capability(), operation = vi.fn(async () => result())
    const consume = vi.fn<SteeringConsumer>().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('private-secret-path'))
      .mockResolvedValueOnce({ content: 'ready' })
    registerAgentSteering(database, token, consume)
    notifyAgentSteering(database, token)
    const notReady = await dispatch(database, token, operation)
    expect(blocks(notReady)[0].reason).toBe('updates_preparing')
    const failed = await dispatch(database, token, operation)
    expect(JSON.stringify(failed)).not.toContain('private-secret-path')
    expect(updates(failed)).toEqual([])
    expect(updates(await dispatch(database, token, operation))).toMatchObject([{ content: 'ready' }])
    expect(operation).not.toHaveBeenCalled()
  })

  it('never consumes or executes for an already cancelled request', async () => {
    const database = db(), token = capability(), controller = new AbortController()
    const consume = vi.fn<SteeringConsumer>(async () => ({ content: 'new instruction' }))
    const operation = vi.fn(async () => result())
    registerAgentSteering(database, token, consume)
    notifyAgentSteering(database, token)
    controller.abort()
    expect((await dispatch(database, token, operation, controller.signal)).isError).toBe(true)
    expect(consume).not.toHaveBeenCalled()
    expect(operation).not.toHaveBeenCalled()
  })

  it('retains input when cancellation happens while preparing, then retries on a live request', async () => {
    const database = db(), token = capability(), controller = new AbortController(), ready = deferred(), entered = deferred()
    const consume = vi.fn<SteeringConsumer>(async context => {
      entered.resolve(); await ready.promise
      return context.isCurrent() ? { content: 'claim after preparation' } : null
    })
    registerAgentSteering(database, token, consume)
    notifyAgentSteering(database, token)
    const cancelled = dispatch(database, token, undefined, controller.signal)
    await entered.promise
    controller.abort(); ready.resolve()
    expect(updates(await cancelled)).toEqual([])
    expect(updates(await dispatch(database, token))).toMatchObject([{ content: 'claim after preparation' }])
    expect(consume).toHaveBeenCalledTimes(2)
  })

  it('caches an already claimed delivery if cancellation races immediately after its commit', async () => {
    const database = db(), token = capability(), controller = new AbortController()
    const consume = vi.fn<SteeringConsumer>(async context => {
      expect(context.isCurrent()).toBe(true)
      controller.abort()
      return { content: 'already persisted' }
    })
    registerAgentSteering(database, token, consume)
    notifyAgentSteering(database, token)
    expect(updates(await dispatch(database, token, undefined, controller.signal))).toEqual([])
    expect(updates(await dispatch(database, token))).toMatchObject([{ content: 'already persisted' }])
    expect(consume).toHaveBeenCalledOnce()
  })

  it.each(['revoke', 'dispose'] as const)('invalidates the consumer identity on %s without consuming late input', async mode => {
    const database = db(), token = capability(), ready = deferred(), entered = deferred()
    let received!: SteeringConsumerContext
    const consume = vi.fn<SteeringConsumer>(async context => {
      received = context; entered.resolve(); await ready.promise
      return context.isCurrent() ? { content: 'must not arrive' } : null
    })
    const dispose = registerAgentSteering(database, token, consume)
    notifyAgentSteering(database, token)
    const request = dispatch(database, token)
    await entered.promise
    if (mode === 'revoke') revokeAgentCapability(token)
    else dispose()
    expect(received.signal.aborted).toBe(true)
    expect(received.isCurrent()).toBe(false)
    ready.resolve()
    expect(updates(await request)).toEqual([])
    expect(notifyAgentSteering(database, token)).toBeNull()
  })

  it('isolates the same conversation across capabilities, databases and unregistered turns', async () => {
    const database = db(), foreignDb = db(), token = capability(), otherTurn = capability()
    const consume = vi.fn<SteeringConsumer>(async () => ({ content: 'private user message' }))
    registerAgentSteering(database, token, consume)
    notifyAgentSteering(database, token)
    const operation = vi.fn(async () => result())
    expect(await dispatch(foreignDb, token, operation)).toEqual(result())
    expect(await dispatch(database, otherTurn, operation)).toEqual(result())
    expect(consume).not.toHaveBeenCalled()
    expect(notifyAgentSteering(foreignDb, token)).toBeNull()
    expect(() => acknowledgeAgentSteering(foreignDb, token, 1)).toThrow()
    expect(() => acknowledgeAgentSteering(database, otherTurn, 1)).toThrow()
    const invalid = 'fabricated-capability-that-is-not-a-real-turn'
    expect((await dispatch(database, invalid, operation)).isError).toBe(true)
    expect(operation).toHaveBeenCalledTimes(2)
    expect(() => registerAgentSteering(database, invalid, consume)).toThrow()
  })

  it('keeps image attachments as native MCP image blocks and releases them after acknowledgement', async () => {
    const database = db(), token = capability()
    const image = { type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' }
    const consume = vi.fn<SteeringConsumer>(async () => ({ content: 'Use this screenshot.', images: [image] }))
    registerAgentSteering(database, token, consume)
    notifyAgentSteering(database, token)
    const first = await dispatch(database, token)
    expect(first.content).toContainEqual(image)
    expect((await dispatch(database, token)).content).toContainEqual(image)
    acknowledgeAgentSteering(database, token, 1)
    expect((await dispatch(database, token)).content).not.toContainEqual(image)
    expect(consume).toHaveBeenCalledOnce()
  })

  it('rejects invalid or undelivered revisions and permits only idempotent current acknowledgement', async () => {
    const database = db(), token = capability()
    const onAcknowledged = vi.fn()
    registerAgentSteering(database, token, async () => ({ content: 'ready' }), { onAcknowledged })
    notifyAgentSteering(database, token)
    expect(() => acknowledgeAgentSteering(database, token, 1)).toThrow()
    expect(onAcknowledged).not.toHaveBeenCalled()
    await dispatch(database, token)
    for (const revision of [0, -1, 2, NaN, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => acknowledgeAgentSteering(database, token, revision)).toThrow()
    }
    expect(onAcknowledged).not.toHaveBeenCalled()
    expect(acknowledgeAgentSteering(database, token, 1)).toMatchObject({ acknowledged: true })
    expect(acknowledgeAgentSteering(database, token, 1)).toMatchObject({ acknowledged: true })
    expect(onAcknowledged).toHaveBeenCalledExactlyOnceWith(1)
    notifyAgentSteering(database, token)
    expect(acknowledgeAgentSteering(database, token, 1)).toMatchObject({ pendingRevision: 2 })
    expect(onAcknowledged).toHaveBeenCalledOnce()
    await dispatch(database, token)
    expect(() => acknowledgeAgentSteering(database, token, 1)).toThrow()
    expect(onAcknowledged).toHaveBeenCalledOnce()
    expect(acknowledgeAgentSteering(database, token, 2)).toMatchObject({ acknowledged: true })
    expect(onAcknowledged.mock.calls).toEqual([[1], [2]])
  })

  it('retains the delivered revision and its gate if persisting a read acknowledgement fails', async () => {
    const database = db(), token = capability(), operation = vi.fn(async () => result())
    const onAcknowledged = vi.fn().mockImplementationOnce(() => { throw new Error('receipt persistence failed') })
    const consume = vi.fn<SteeringConsumer>(async () => ({ content: 'Keep this update available.' }))
    registerAgentSteering(database, token, consume, { onAcknowledged })
    notifyAgentSteering(database, token)
    await dispatch(database, token, operation)
    expect(() => acknowledgeAgentSteering(database, token, 1)).toThrow('receipt persistence failed')
    const withheld = await dispatch(database, token, operation)
    expect(withheld.isError).toBe(true)
    expect(updates(withheld)).toMatchObject([{ revision: 1, content: 'Keep this update available.' }])
    expect(consume).toHaveBeenCalledOnce()
    expect(operation).not.toHaveBeenCalled()
    expect(acknowledgeAgentSteering(database, token, 1)).toMatchObject({ acknowledged: true })
    expect(await dispatch(database, token, operation)).toEqual(result())
    expect(operation).toHaveBeenCalledOnce()
    expect(onAcknowledged.mock.calls).toEqual([[1], [1]])
  })

  it('acknowledges exact native input identities without acknowledging an MCP revision or consuming input', async () => {
    const database = db(), token = capability(), onInputsRead = vi.fn(), onAcknowledged = vi.fn()
    const consume = vi.fn<SteeringConsumer>(async () => ({ content: 'Must use native transport.' }))
    registerAgentSteering(database, token, consume, { native: true, onInputsRead, onAcknowledged })
    notifyAgentSteering(database, token)
    expect(acknowledgeAgentInputsRead(database, token, ['q2', 'q1', 'q2'])).toEqual({ acknowledged: true, inputIds: ['q2', 'q1'], receipt: 'read' })
    expect(onInputsRead).toHaveBeenCalledExactlyOnceWith(['q2', 'q1'])
    expect(onAcknowledged).not.toHaveBeenCalled()
    expect(() => acknowledgeAgentSteering(database, token, 1)).toThrow('native provider input channel')
    const listener = vi.fn()
    const removeListener = onAgentSteering(database, token, listener)
    // Read receipts do not consume the native transport notification revision.
    expect(listener).toHaveBeenCalledOnce()
    removeListener()
    expect(await dispatch(database, token)).toEqual(result())
    expect(consume).not.toHaveBeenCalled()
  })

  it('bounds and validates the whole native receipt batch before invoking its owner', () => {
    const database = db(), token = capability(), onInputsRead = vi.fn()
    registerAgentSteering(database, token, async () => null, { native: true, onInputsRead })
    for (const inputIds of [undefined, null, 'q1', {}, [], [''], ['  '], [1], ['valid', null], ['a'.repeat(201)], Array(51).fill('q1')]) {
      expect(() => acknowledgeAgentInputsRead(database, token, inputIds as string[])).toThrow('1–50 exact input IDs')
    }
    expect(onInputsRead).not.toHaveBeenCalled()
    const ids = ['a'.repeat(200), ...Array.from({ length: 49 }, (_, index) => `q-${index}`)]
    expect(acknowledgeAgentInputsRead(database, token, ids)).toMatchObject({ acknowledged: true, inputIds: ids })
    expect(onInputsRead).toHaveBeenCalledExactlyOnceWith(ids)
  })

  it.each([false, true])('accepts an explicit initial input receipt before steering for native=%s', async native => {
    const database = db(), token = capability(), onInputsRead = vi.fn(), onAcknowledged = vi.fn()
    const consume = vi.fn<SteeringConsumer>(async () => null)
    registerAgentSteering(database, token, consume, { native, onInputsRead, onAcknowledged })
    expect(acknowledgeAgentInputsRead(database, token, ['initial-input'])).toEqual({ acknowledged: true, inputIds: ['initial-input'], receipt: 'read' })
    expect(onInputsRead).toHaveBeenCalledExactlyOnceWith(['initial-input'])
    expect(onAcknowledged).not.toHaveBeenCalled()
    expect(await dispatch(database, token)).toEqual(result())
    expect(consume).not.toHaveBeenCalled()
  })

  it('requires a registered receipt owner on the same live capability and database', () => {
    const database = db(), foreignDb = db(), token = capability(), otherToken = capability()
    const onInputsRead = vi.fn()
    const dispose = registerAgentSteering(database, token, async () => null, { native: true, onInputsRead })
    for (const [targetDb, targetToken] of [[foreignDb, token], [database, otherToken], [database, 'fabricated-token']] as const) {
      expect(() => acknowledgeAgentInputsRead(targetDb, targetToken, ['q1'])).toThrow(/active first-party.*mission turn/)
    }
    registerAgentSteering(database, otherToken, async () => null)
    expect(() => acknowledgeAgentInputsRead(database, otherToken, ['q1'])).toThrow(/active first-party.*mission turn/)
    const noCallback = capability()
    registerAgentSteering(database, noCallback, async () => null, { native: true })
    expect(() => acknowledgeAgentInputsRead(database, noCallback, ['q1'])).toThrow(/active first-party.*mission turn/)
    dispose()
    expect(() => acknowledgeAgentInputsRead(database, token, ['q1'])).toThrow(/active first-party.*mission turn/)
    registerAgentSteering(database, token, async () => null, { native: true, onInputsRead })
    revokeAgentCapability(token)
    expect(() => acknowledgeAgentInputsRead(database, token, ['q1'])).toThrow(/active first-party.*mission turn/)
    expect(onInputsRead).not.toHaveBeenCalled()
  })

  it('propagates native owner rejection of a foreign ID without reporting a successful receipt', () => {
    const database = db(), token = capability(), readIds: string[] = []
    const onInputsRead = vi.fn((ids: string[]) => {
      if (ids.some(id => id !== 'delivered-here')) throw new Error('Input was not delivered in this invocation.')
      readIds.push(...ids)
    })
    registerAgentSteering(database, token, async () => null, { native: true, onInputsRead })
    expect(() => acknowledgeAgentInputsRead(database, token, ['delivered-here', 'other-turn'])).toThrow('not delivered in this invocation')
    expect(readIds).toEqual([])
    expect(acknowledgeAgentInputsRead(database, token, ['delivered-here'])).toMatchObject({ acknowledged: true, receipt: 'read' })
    expect(readIds).toEqual(['delivered-here'])
  })

  it('does not replace an active registration or let an old disposer delete a replacement', () => {
    const database = db(), token = capability(), consume = vi.fn<SteeringConsumer>(async () => null)
    const dispose = registerAgentSteering(database, token, consume)
    expect(() => registerAgentSteering(database, token, consume)).toThrow()
    dispose()
    registerAgentSteering(database, token, consume)
    dispose()
    expect(notifyAgentSteering(database, token)).toBe(1)
  })
})
