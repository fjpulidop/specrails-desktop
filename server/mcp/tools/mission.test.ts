import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { initDesktopDb } from '../../desktop-db'
import { registerAgentSteering, notifyAgentSteering } from '../../agent-steering'
import { AGENT_CAPABILITY_HEADER } from '../../agent-tier'
import { mintAgentCapability, revokeAgentCapability, _resetAgentCapabilitiesForTest } from '../agent-capability'
import { registerTieredTool, type McpToolContext, type McpToolSpec, type ToolHandlerExtra } from './types'
import { missionTools } from './mission'
import { watchTool } from './watch'
import { MobileEventBus } from '../../mobile/mobile-event-bus'

vi.mock('../../auth', () => ({ loadOrGenerateToken: () => 'mission-tool-test-token' }))

const databases: Array<ReturnType<typeof initDesktopDb>> = []
type RegisteredHandler = (args: Record<string, unknown>, extra?: ToolHandlerExtra) => Promise<CallToolResult>
function setup(tierLevel: 0 | 3 = 3) {
  const db = initDesktopDb(':memory:')
  databases.push(db)
  const token = mintAgentCapability({ conversationId: 'mission-1', projectId: 'project-1', tierLevel })
  const extra = { requestInfo: { headers: { [AGENT_CAPABILITY_HEADER]: token } } }
  const broadcast = vi.fn()
  const ctx = { desktopDb: db, broadcast, eventBus: new MobileEventBus(), desktopPort: 4299 } as unknown as McpToolContext
  function register(spec: McpToolSpec): RegisteredHandler {
    let call!: RegisteredHandler
    const server = { registerTool: (_name: string, _config: unknown, handler: RegisteredHandler) => { call = handler } } as unknown as McpServer
    registerTieredTool(server, ctx, spec)
    return call
  }
  return { db, token, extra, ctx, broadcast, register, ack: register(missionTools()[0]) }
}
const spec = (handler: McpToolSpec['handler'], tier: 'read' | 'write' = 'write'): McpToolSpec => ({
  name: 'test_action', title: 'test', description: 'test', tier, inputSchema: {}, handler,
})
const jsonBlocks = (reply: CallToolResult) => reply.content.filter(block => block.type === 'text').flatMap(block => {
  try { return [JSON.parse(block.text)] } catch { return [] }
})
const allText = (reply: CallToolResult) => reply.content.filter(block => block.type === 'text').map(block => block.text).join('\n')

afterEach(() => { _resetAgentCapabilitiesForTest(); for (const db of databases.splice(0)) db.close(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('Specrails mission update MCP dispatch', () => {
  it('withholds the stale handler and activity broadcast, then dispatches after an authenticated acknowledgement', async () => {
    const { db, token, extra, register, ack, broadcast } = setup()
    const consumer = vi.fn(async () => ({ content: 'Use spec 2.' }))
    registerAgentSteering(db, token, consumer)
    notifyAgentSteering(db, token)
    const handler = vi.fn(async () => ({ jobId: 42 }))
    const action = register(spec(handler))
    const withheld = await action({}, extra)
    expect(jsonBlocks(withheld)[0]).toMatchObject({ code: 'tool_not_executed', executed: false })
    expect(withheld.isError).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(jsonBlocks(await ack({ action: 'acknowledge_updates', revision: 1 }, extra))[0]).toMatchObject({ acknowledged: true })
    expect(jsonBlocks(await action({}, extra))[0]).toEqual({ jobId: 42 })
    expect(handler).toHaveBeenCalledOnce()
    expect(broadcast).toHaveBeenCalledOnce()
    expect(allText(withheld)).not.toContain(token)
  })

  it.each([false, true])('preserves a running handler outcome (failure=%s) and appends authenticated updates and image bytes', async failure => {
    const { db, token, extra, register, broadcast } = setup()
    const image = { type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' }
    const consumer = vi.fn(async () => ({ content: 'Do the next step differently.', images: [image] }))
    registerAgentSteering(db, token, consumer)
    const action = register(spec(async () => {
      notifyAgentSteering(db, token)
      if (failure) throw new Error('original operation failed')
      return { original: 'operation result' }
    }))
    const reply = await action({}, extra)
    expect(reply.isError).toBe(failure ? true : undefined)
    expect(reply.content[0]).toEqual({ type: 'text', text: failure ? 'Error: original operation failed' : JSON.stringify({ original: 'operation result' }, null, 2) })
    expect(jsonBlocks(reply)).toContainEqual(expect.objectContaining({ type: 'mission_user_updates', content: 'Do the next step differently.' }))
    expect(reply.content).toContainEqual(image)
    expect(broadcast).toHaveBeenCalledTimes(failure ? 0 : 1)
  })

  it('rejects denied-tier, spoofed, revoked and aborted requests before consuming any queued message', async () => {
    const { db, token, extra, register } = setup(0)
    const consumer = vi.fn(async () => ({ content: 'private user update' }))
    registerAgentSteering(db, token, consumer)
    notifyAgentSteering(db, token)
    const mutation = vi.fn(async () => 'mutated')
    expect((await register(spec(mutation))({}, extra)).isError).toBe(true)
    const read = register(spec(vi.fn(async () => 'read'), 'read'))
    const abort = new AbortController(); abort.abort()
    expect((await read({}, { ...extra, signal: abort.signal })).isError).toBe(true)
    const spoofed = await read({}, { requestInfo: { headers: { 'x-specrails-agent-conversation': 'mission-1' } } })
    expect(allText(spoofed)).toBe('read')
    const invalid = await read({}, { requestInfo: { headers: { [AGENT_CAPABILITY_HEADER]: 'invalid' } } })
    expect(invalid.isError).toBe(true)
    revokeAgentCapability(token)
    expect((await read({}, extra)).isError).toBe(true)
    expect(consumer).not.toHaveBeenCalled()
    expect(mutation).not.toHaveBeenCalled()
  })

  it('does not allow external or other-turn clients to acknowledge or receive pending user messages', async () => {
    const { db, token, ack } = setup()
    const consumer = vi.fn(async () => ({ content: 'private update' }))
    registerAgentSteering(db, token, consumer)
    notifyAgentSteering(db, token)
    const otherToken = mintAgentCapability({ conversationId: 'mission-1', projectId: 'project-1', tierLevel: 3 })
    for (const extra of [undefined, { requestInfo: { headers: { [AGENT_CAPABILITY_HEADER]: otherToken } } }]) {
      const reply = await ack({ action: 'acknowledge_updates', revision: 1 }, extra)
      expect(reply.isError).toBe(true)
      expect(allText(reply)).not.toContain('private update')
    }
    expect(consumer).not.toHaveBeenCalled()
  })

  it('an early acknowledgement safely retrieves pending updates without releasing their gate', async () => {
    const { db, token, extra, ack, register } = setup()
    registerAgentSteering(db, token, async () => ({ content: 'new direction' }))
    notifyAgentSteering(db, token)
    const early = await ack({ action: 'acknowledge_updates', revision: 1 }, extra)
    expect(early.isError).toBe(true)
    expect(jsonBlocks(early)).toContainEqual(expect.objectContaining({ type: 'mission_user_updates', revision: 1 }))
    const handler = vi.fn(async () => 'ran')
    expect((await register(spec(handler))({}, extra)).isError).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    expect((await ack({ action: 'acknowledge_updates', revision: 1 }, extra)).isError).toBeUndefined()
  })

  it('acknowledging a delivered batch prunes its images but never releases a newer pending revision', async () => {
    const { db, token, extra, ack, register } = setup()
    registerAgentSteering(db, token, async context => ({
      content: `message ${context.revision}`,
      images: [{ type: 'image', data: `image-${context.revision}`, mimeType: 'image/png' }],
    }))
    const handler = vi.fn(async () => 'ran')
    const action = register(spec(handler))
    notifyAgentSteering(db, token)
    await action({}, extra)
    notifyAgentSteering(db, token)
    const acknowledged = await ack({ action: 'acknowledge_updates', revision: 1 }, extra)
    expect(jsonBlocks(acknowledged)[0]).toMatchObject({ acknowledged: true, revision: 1, pendingRevision: 2 })
    expect(jsonBlocks(acknowledged)).toContainEqual(expect.objectContaining({ type: 'mission_user_updates', revision: 2 }))
    expect(acknowledged.content.filter(block => block.type === 'image')).toEqual([{ type: 'image', data: 'image-2', mimeType: 'image/png' }])
    expect((await action({}, extra)).isError).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    expect((await ack({ action: 'acknowledge_updates', revision: 1 }, extra)).isError).toBe(true)
    await ack({ action: 'acknowledge_updates', revision: 2 }, extra)
    expect((await action({}, extra)).isError).toBeUndefined()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('uses a read-tier first-party control with a strictly bounded revision schema', () => {
    const tool = missionTools()[0]
    expect(tool.tier).toBe('read')
    const schema = z.object(tool.inputSchema)
    expect(schema.safeParse({ action: 'acknowledge_updates', revision: 2 }).success).toBe(true)
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
      expect(schema.safeParse({ action: 'acknowledge_updates', revision }).success).toBe(false)
    }
    expect(tool.description).toContain('First-party mission only')
    expect(tool.description).toContain('separate call')
  })

  it('records native read receipts through the scoped owner at read tier without creating an execution gate', async () => {
    const { db, token, extra, ack, register, broadcast } = setup(0)
    const consumer = vi.fn(async () => ({ content: 'Do not deliver native input twice.' }))
    const onInputsRead = vi.fn(), onAcknowledged = vi.fn()
    registerAgentSteering(db, token, consumer, { native: true, onInputsRead, onAcknowledged })
    notifyAgentSteering(db, token)
    const reply = await ack({ action: 'acknowledge_inputs', inputIds: ['second', 'first', 'second'] }, extra)
    expect(reply.isError).toBeUndefined()
    expect(jsonBlocks(reply)).toEqual([{ acknowledged: true, inputIds: ['second', 'first'], receipt: 'read' }])
    expect(onInputsRead).toHaveBeenCalledExactlyOnceWith(['second', 'first'])
    expect(onAcknowledged).not.toHaveBeenCalled()
    expect(consumer).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    const handler = vi.fn(async () => ({ stillAvailable: true }))
    expect(jsonBlocks(await register(spec(handler, 'read'))({}, extra))).toEqual([{ stillAvailable: true }])
    expect(handler).toHaveBeenCalledOnce()
    expect((await ack({ action: 'acknowledge_updates', revision: 1 }, extra)).isError).toBe(true)
    expect(onAcknowledged).not.toHaveBeenCalled()
    expect(allText(reply)).not.toContain(token)
  })

  it('rejects malformed native receipt batches before invoking the callback even when bypassing SDK schema parsing', async () => {
    const { db, token, extra, ack } = setup()
    const onInputsRead = vi.fn()
    registerAgentSteering(db, token, async () => null, { native: true, onInputsRead })
    for (const inputIds of [undefined, null, 'q1', [], [''], ['  '], [1], ['valid', null], ['a'.repeat(201)], Array(51).fill('q1')]) {
      const reply = await ack({ action: 'acknowledge_inputs', inputIds }, extra)
      expect(reply.isError).toBe(true)
      expect(allText(reply)).toContain('1–50 exact input IDs')
    }
    expect(onInputsRead).not.toHaveBeenCalled()
    const schema = z.object(missionTools()[0].inputSchema)
    const maximum = ['a'.repeat(200), ...Array.from({ length: 49 }, (_, index) => `q-${index}`)]
    expect(schema.safeParse({ action: 'acknowledge_inputs', inputIds: maximum }).success).toBe(true)
    for (const inputIds of [null, 'q1', [], [''], [1], ['a'.repeat(201)], [...maximum, 'extra']]) {
      expect(schema.safeParse({ action: 'acknowledge_inputs', inputIds }).success).toBe(false)
    }
    expect((await ack({ action: 'acknowledge_inputs', inputIds: maximum }, extra)).isError).toBeUndefined()
    expect(onInputsRead).toHaveBeenCalledExactlyOnceWith(maximum)
  })

  it('rejects native receipts from external, spoofed, other-turn, revoked and cancelled requests', async () => {
    const { db, token, extra, ack } = setup()
    const onInputsRead = vi.fn()
    registerAgentSteering(db, token, async () => null, { native: true, onInputsRead })
    const other = mintAgentCapability({ conversationId: 'mission-1', projectId: 'project-1', tierLevel: 3 })
    const noOwner = mintAgentCapability({ conversationId: 'mission-1', projectId: 'project-1', tierLevel: 3 })
    registerAgentSteering(db, noOwner, async () => null, { native: true })
    const controller = new AbortController(); controller.abort()
    const args = { action: 'acknowledge_inputs', inputIds: ['private-input'] }
    for (const caller of [
      undefined,
      { requestInfo: { headers: { 'x-specrails-agent-conversation': 'mission-1' } } },
      { requestInfo: { headers: { [AGENT_CAPABILITY_HEADER]: 'fabricated-token' } } },
      { requestInfo: { headers: { [AGENT_CAPABILITY_HEADER]: other } } },
      { requestInfo: { headers: { [AGENT_CAPABILITY_HEADER]: noOwner } } },
      { ...extra, signal: controller.signal },
    ]) {
      const reply = await ack(args, caller)
      expect(reply.isError).toBe(true)
      expect(jsonBlocks(reply)).not.toContainEqual(expect.objectContaining({ receipt: 'read' }))
    }
    revokeAgentCapability(token)
    expect((await ack(args, extra)).isError).toBe(true)
    expect(onInputsRead).not.toHaveBeenCalled()
    const tool = missionTools()[0]
    for (const ctx of [{ firstPartyAgent: true }, { acknowledgeAgentInputsRead: onInputsRead }]) {
      expect(() => tool.handler(ctx as unknown as McpToolContext, args)).toThrow('active first-party mission turn')
    }
    expect(onInputsRead).not.toHaveBeenCalled()
  })

  it('rejects an entire native batch when its owner rejects an input from another invocation', async () => {
    const { db, token, extra, ack, register } = setup()
    const readIds: string[] = []
    const onInputsRead = vi.fn((ids: string[]) => {
      if (ids.some(id => id !== 'delivered-here')) throw new Error('Only native user inputs delivered in this invocation can be acknowledged.')
      readIds.push(...ids)
    })
    registerAgentSteering(db, token, async () => null, { native: true, onInputsRead })
    const rejected = await ack({ action: 'acknowledge_inputs', inputIds: ['delivered-here', 'foreign-input'] }, extra)
    expect(rejected.isError).toBe(true)
    expect(allText(rejected)).toContain('delivered in this invocation')
    expect(jsonBlocks(rejected)).not.toContainEqual(expect.objectContaining({ acknowledged: true }))
    expect(readIds).toEqual([])
    const handler = vi.fn(async () => ({ unaffected: true }))
    expect((await register(spec(handler))({}, extra)).isError).toBeUndefined()
    expect(handler).toHaveBeenCalledOnce()
    const accepted = await ack({ action: 'acknowledge_inputs', inputIds: ['delivered-here'] }, extra)
    expect(jsonBlocks(accepted)).toEqual([{ acknowledged: true, inputIds: ['delivered-here'], receipt: 'read' }])
    expect(readIds).toEqual(['delivered-here'])
  })

  it('never lets acknowledge_inputs bypass the MCP revision gate or mark those updates read', async () => {
    const { db, token, extra, ack, register } = setup()
    const onInputsRead = vi.fn(), onAcknowledged = vi.fn()
    registerAgentSteering(db, token, async () => ({ content: 'MCP update requiring revision acknowledgement.' }), { onInputsRead, onAcknowledged })
    // The initial message can be acknowledged on a legacy provider while its
    // gate is open, without acknowledging any subsequent correction revision.
    expect(jsonBlocks(await ack({ action: 'acknowledge_inputs', inputIds: ['initial-input'] }, extra))).toEqual([{ acknowledged: true, inputIds: ['initial-input'], receipt: 'read' }])
    expect(onInputsRead).toHaveBeenCalledExactlyOnceWith(['initial-input'])
    onInputsRead.mockClear()
    notifyAgentSteering(db, token)
    const handler = vi.fn(async () => 'executed')
    const action = register(spec(handler))
    await action({}, extra)
    const bypass = await ack({ action: 'acknowledge_inputs', inputIds: ['q1'], revision: 1 }, extra)
    expect(bypass.isError).toBe(true)
    expect(jsonBlocks(bypass)[0]).toMatchObject({ code: 'tool_not_executed', executed: false })
    expect(jsonBlocks(bypass)).toContainEqual(expect.objectContaining({ type: 'mission_user_updates', revision: 1 }))
    expect(onInputsRead).not.toHaveBeenCalled()
    expect(onAcknowledged).not.toHaveBeenCalled()
    expect((await action({}, extra)).isError).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    expect((await ack({ action: 'acknowledge_updates', revision: 2 }, extra)).isError).toBe(true)
    expect(onAcknowledged).not.toHaveBeenCalled()
    expect((await ack({ action: 'acknowledge_updates', revision: 1 }, extra)).isError).toBeUndefined()
    expect(onAcknowledged).toHaveBeenCalledExactlyOnceWith(1)
    expect((await action({}, extra)).isError).toBeUndefined()
    expect(handler).toHaveBeenCalledOnce()
    expect(onInputsRead).not.toHaveBeenCalled()
  })

  it('a scoped new message immediately releases a long watch and delivers updates without touching the job', async () => {
    vi.useFakeTimers()
    const { db, token, extra, ctx, register } = setup()
    const consumer = vi.fn(async () => ({ content: 'Change the follow-up plan.' }))
    registerAgentSteering(db, token, consumer)
    const foreign = mintAgentCapability({ conversationId: 'other-mission', tierLevel: 3 })
    registerAgentSteering(db, foreign, async () => ({ content: 'other mission private message' }))
    let readSignal!: AbortSignal
    const fetchMock = vi.fn((_url: string, options: { signal: AbortSignal }) => {
      readSignal = options.signal
      return new Promise((_resolve, reject) => readSignal.addEventListener('abort', () => reject(new Error('read aborted'))))
    })
    vi.stubGlobal('fetch', fetchMock)
    const startedAt = Date.now()
    const waiting = register(watchTool())({ ref: 'job-1', kind: 'job', untilMs: 600_000 }, extra)
    notifyAgentSteering(db, foreign)
    expect(readSignal.aborted).toBe(false)
    expect(consumer).not.toHaveBeenCalled()
    notifyAgentSteering(db, token)
    const reply = await waiting
    expect(Date.now()).toBe(startedAt)
    expect(jsonBlocks(reply)[0]).toMatchObject({ settled: false, reason: 'user_update', operationStopped: false })
    expect(jsonBlocks(reply)).toContainEqual(expect.objectContaining({ type: 'mission_user_updates', content: 'Change the follow-up plan.' }))
    expect(allText(reply)).not.toContain('other mission private message')
    expect(readSignal.aborted).toBe(true)
    expect(consumer).toHaveBeenCalledOnce()
    expect(ctx.eventBus.listenerCount('message')).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' })
  })

  it('ending a watch leaves another already-running tool untouched and defers delivery until it settles', async () => {
    const { db, token, extra, register } = setup()
    const consumer = vi.fn(async () => ({ content: 'new direction' }))
    registerAgentSteering(db, token, consumer)
    let complete!: (value: unknown) => void
    let actionSignal: AbortSignal | undefined
    const activeController = new AbortController()
    const other = register(spec(ctx => { actionSignal = ctx.signal; return new Promise(resolve => { complete = resolve }) }))({}, { ...extra, signal: activeController.signal })
    // Event-only watch: no backing HTTP request is needed for this identity.
    const waiting = register(watchTool())({ ref: 'spec-generation-1', untilMs: 600_000 }, extra)
    notifyAgentSteering(db, token)
    const early = await waiting
    expect(jsonBlocks(early)[0]).toMatchObject({ reason: 'user_update', operationStopped: false })
    expect(consumer).not.toHaveBeenCalled()
    expect(actionSignal?.aborted).toBe(false)
    complete({ actualResult: 'saved successfully' })
    const completed = await other
    expect(jsonBlocks(completed)[0]).toEqual({ actualResult: 'saved successfully' })
    expect(jsonBlocks(completed)).toContainEqual(expect.objectContaining({ type: 'mission_user_updates', content: 'new direction' }))
    expect(consumer).toHaveBeenCalledOnce()
  })
})
