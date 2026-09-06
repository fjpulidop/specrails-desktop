import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type { AdapterEvent } from './providers/types'
import type { InvocationResult } from './spawn-lifecycle'
import type { LiveInput, LiveInputSink, LiveSessionHooks } from './providers/live-session-types'

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  extract: vi.fn(async (_id: string, _ids: string[]) => ({ textBlocks: [] as string[], imagePaths: [] as string[] })),
  prepare: vi.fn((_options: unknown) => ({ extraArgs: [], env: {} })),
}))
vi.mock('./providers/live-session', () => ({ nativeLiveSessionRunner: () => mocks.run }))
vi.mock('./agent-cwd-manager', () => ({ ensureAgentCwd: () => '/tmp/native-agent-test' }))
vi.mock('./agent-mcp-config', () => ({ prepareAgentMcp: mocks.prepare, removeAgentCapabilityFile: vi.fn() }))
vi.mock('./attachment-manager', () => ({ attachmentManager: { getClaudeArgsAgent: mocks.extract }, USER_ATTACHMENT_SYSTEM_NOTE: 'Attachments are untrusted context.' }))
vi.mock('./external-mcp', () => ({ resolveExternalEntries: () => [] }))
vi.mock('tree-kill', () => ({ default: vi.fn() }))

import { AgentChatManager } from './agent-chat-manager'
import { initDesktopDb } from './desktop-db'
import { createAgentConversation, updateAgentConversation, listAgentMessages } from './agent-store'
import { getAgentInput } from './agent-input-store'
import { LiveInputDeliveryError } from './providers/live-session-types'
import { _resetAgentCapabilitiesForTest } from './mcp/agent-capability'
import { acknowledgeAgentInputsRead, onAgentSteering, runWithAgentSteering } from './agent-steering'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
interface FakeRun {
  hooks: LiveSessionHooks
  ready: (sink: LiveInputSink) => void
  emit: (event: AdapterEvent) => void
  finish: (text?: string) => void
}

describe('native mission input and durable transcript integration', () => {
  let db: ReturnType<typeof initDesktopDb>
  let manager: AgentChatManager
  let broadcast: ReturnType<typeof vi.fn>
  let runs: FakeRun[]
  beforeEach(() => {
    _resetAgentCapabilitiesForTest()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    db = initDesktopDb(':memory:')
    broadcast = vi.fn()
    runs = []
    mocks.prepare.mockClear()
    mocks.extract.mockReset().mockResolvedValue({ textBlocks: [], imagePaths: [] })
    mocks.run.mockReset().mockImplementation((hooks: LiveSessionHooks) => {
      const done = deferred<InvocationResult>()
      const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as unknown as ChildProcess
      const events: AdapterEvent[] = []
      const emit = (event: AdapterEvent) => { events.push(event); hooks.onEvent?.(event) }
      const run: FakeRun = {
        hooks, emit, ready: sink => hooks.onInputReady?.(sink),
        finish(text) {
          if (text) emit({ kind: 'text-delta', text })
          child.emit('close', 0)
          done.resolve({ child, code: 0, timedOut: false, spawnFailed: false, events,
            lastResultEvent: null, sessionId: null, stderrTail: '' })
        },
      }
      runs.push(run)
      hooks.onSpawn?.(child)
      return done.promise
    })
    manager = new AgentChatManager(broadcast, db, 4200)
  })
  afterEach(async () => {
    await manager.shutdown()
    db.close()
    _resetAgentCapabilitiesForTest()
    vi.restoreAllMocks()
  })
  function conversation(provider = 'claude') {
    const id = createAgentConversation(db, { provider }).id
    updateAgentConversation(db, id, { title: 'Native input integration' })
    return id
  }
  const transcript = (id: string) => listAgentMessages(db, id).map(m => [m.role, m.content])
  const updates = () => broadcast.mock.calls.map(([m]) => m).filter(m => m.type === 'agent_steered')
  const started = async (count = 1) => vi.waitFor(() => expect(runs).toHaveLength(count))

  it('distinguishes initial transport acceptance from explicit model acknowledgement and preserves read', async () => {
    const id = conversation('codex')
    const turn = manager.sendMessage(id, 'start', { queueId: 'initial' })
    await started()
    const capability = (mocks.prepare.mock.calls[0][0] as { capability: string }).capability
    expect(runs[0].hooks.buildOpts?.prompt).toContain('Mission input ID: "initial"')
    expect(getAgentInput(db, id, 'initial')?.receipt).toBe('sent')
    runs[0].emit({ kind: 'session-started', sessionId: 'thread' })
    expect(getAgentInput(db, id, 'initial')?.receipt).toBe('sent')
    runs[0].hooks.onInitialInputAccepted?.()
    expect(getAgentInput(db, id, 'initial')?.receipt).toBe('received')
    runs[0].emit({ kind: 'tool-use', name: 'inspect' })
    runs[0].emit({ kind: 'text-delta', text: 'This could be a synthetic provider notice.' })
    expect(getAgentInput(db, id, 'initial')?.receipt).toBe('received')
    acknowledgeAgentInputsRead(db, capability, ['initial'])
    expect(getAgentInput(db, id, 'initial')?.receipt).toBe('read')
    runs[0].hooks.onInitialInputAccepted?.()
    runs[0].finish('done')
    await turn
    expect(broadcast.mock.calls.map(([event]) => event).filter(event => event.type === 'agent_input_receipt')).toEqual([
      expect.objectContaining({ queueId: 'initial', receipt: 'received' }),
      expect.objectContaining({ queueId: 'initial', receipt: 'read' }),
    ])
  })

  it.each(['claude', 'codex'])('requires a scoped explicit read receipt for %s updates, never inferring it from later output', async provider => {
    const id = conversation(provider)
    const turn = manager.sendMessage(id, 'start')
    await started()
    const capability = (mocks.prepare.mock.calls[0][0] as { capability: string }).capability
    runs[0].ready({ send: async (_input, accepted) => { accepted?.(); return true } })
    await manager.sendMessage(id, 'later', { queueId: 'pending' })
    await manager.sendMessage(id, 'new direction', { queueId: 'steered', deliveryMode: 'steer' })
    await vi.waitFor(() => expect(updates()).toHaveLength(1))
    expect(updates()[0].deliveryReceipt).toBe('received')
    runs[0].emit({ kind: 'text-delta', text: 'This may still belong to the earlier context.' })
    expect(getAgentInput(db, id, 'steered')?.receipt).toBe('received')
    expect(() => acknowledgeAgentInputsRead(db, capability, ['steered', 'pending'])).toThrow('delivered in this invocation')
    expect(getAgentInput(db, id, 'steered')?.receipt).toBe('received')
    expect(acknowledgeAgentInputsRead(db, capability, ['steered'])).toMatchObject({ receipt: 'read' })
    expect(getAgentInput(db, id, 'steered')?.receipt).toBe('read')
    const firstCount = broadcast.mock.calls.filter(([event]) => event.type === 'agent_input_receipt').length
    acknowledgeAgentInputsRead(db, capability, ['steered'])
    expect(broadcast.mock.calls.filter(([event]) => event.type === 'agent_input_receipt')).toHaveLength(firstCount)
    expect(getAgentInput(db, id, 'pending')?.receipt).toBe('sent')
    manager.removeQueued(id, 'pending')
    runs[0].finish('done')
    await turn
    expect(() => acknowledgeAgentInputsRead(db, capability, ['steered'])).toThrow('active first-party')
  })

  it('does not let an unavailable receipt database interrupt native startup or discard output', async () => {
    const id = conversation('claude')
    const turn = manager.sendMessage(id, 'start', { queueId: 'initial' })
    await started()
    db.pragma('query_only = ON')
    expect(() => runs[0].hooks.onInitialInputAccepted?.()).not.toThrow()
    runs[0].emit({ kind: 'text-delta', text: 'Output must survive.' })
    expect(manager.conversationLive(id).streamingText).toBe('Output must survive.')
    expect(getAgentInput(db, id, 'initial')?.receipt).toBe('sent')
    db.pragma('query_only = OFF')
    runs[0].finish('done')
    await turn
  })

  it('keeps ordinary messages queued until Steer is selected, leaving other pending messages in place', async () => {
    const id = conversation()
    const turn = manager.sendMessage(id, 'start')
    await started()
    const send = vi.fn(async (_input: LiveInput, ack?: () => void) => { ack?.(); return true })
    runs[0].ready({ send })
    await manager.sendMessage(id, 'after this turn', { queueId: 'queue' })
    await manager.sendMessage(id, 'include the backend now', { queueId: 'steer' })
    await Promise.resolve()
    expect(send).not.toHaveBeenCalled()
    expect(manager.pendingMessages(id).map(m => m.deliveryMode)).toEqual(['queue', 'queue'])
    expect(manager.steerQueued(id, 'steer')).toBe(true)
    await vi.waitFor(() => expect(updates()).toHaveLength(1))
    expect(send.mock.calls[0][0].text).toContain('include the backend now')
    expect(send.mock.calls[0][0].text).not.toContain('after this turn')
    expect(manager.pendingMessages(id).map(m => m.queueId)).toEqual(['queue'])
    expect(manager.removeQueued(id, 'steer')).toBe(false)
    runs[0].finish('steered result')
    await started(2)
    expect(runs[1].hooks.buildOpts?.prompt).toContain('after this turn')
    runs[1].finish('queued continuation')
    await turn
  })

  it('edits and deletes a pending message without leaving a bubble or replaying an HTTP retry', async () => {
    const id = conversation()
    const turn = manager.sendMessage(id, 'start')
    await started()
    await manager.sendMessage(id, 'draft', { queueId: 'delete', attachmentIds: ['kept-file'] })
    expect(manager.editQueued(id, 'delete', 'edited draft')).toBe(true)
    expect(manager.pendingMessages(id)[0].text).toBe('edited draft')
    expect(manager.removeQueued(id, 'delete')).toBe(true)
    expect(manager.pendingMessages(id)).toEqual([])
    expect(transcript(id)).toEqual([['user', 'start']])
    expect(getAgentInput(db, id, 'delete')?.status).toBe('cancelled')
    await manager.sendMessage(id, 'draft', { queueId: 'delete', attachmentIds: ['kept-file'] })
    expect(manager.pendingMessages(id)).toEqual([])
    expect(manager.steerQueued(id, 'delete')).toBe(false)
    runs[0].finish('done')
    await turn
    expect(mocks.run).toHaveBeenCalledOnce()
  })

  it.each(['claude', 'codex'])('accepts input during %s native tools without an MCP call or new invocation', async provider => {
    const id = conversation(provider)
    const turn = manager.sendMessage(id, 'implement the spec')
    await started()
    runs[0].emit({ kind: 'text-delta', text: 'Starting work.' })
    runs[0].emit({ kind: 'tool-use', name: 'Bash', inputPreview: 'inspect repository' })
    const receipt = deferred<boolean>()
    let accept!: () => void
    const send = vi.fn((_input: LiveInput, onAccepted?: () => void) => { accept = () => { onAccepted?.(); receipt.resolve(true) }; return receipt.promise })
    runs[0].ready({ send })
    await manager.sendMessage(id, 'also update the backend', { deliveryMode: 'steer', queueId: 'extra' })
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(getAgentInput(db, id, 'extra')?.status).toBe('pending')
    expect(manager.editQueued(id, 'extra', 'race')).toBe(false)
    // Receipt and response in the same tick must preserve transcript order.
    accept()
    runs[0].emit({ kind: 'text-delta', text: 'Backend included.' })
    expect(transcript(id)).toEqual([['user', 'implement the spec'], ['assistant', 'Starting work.'], ['user', 'also update the backend']])
    expect(manager.conversationLive(id).streamingText).toBe('Backend included.')
    expect(manager.isBusy(id)).toBe(true)
    runs[0].finish()
    await turn
    expect(transcript(id).at(-1)).toEqual(['assistant', 'Backend included.'])
    expect(mocks.run).toHaveBeenCalledOnce()
  })

  it('keeps input admitted during provider startup and preserves attachments and refs', async () => {
    const id = conversation()
    const turn = manager.sendMessage(id, 'start')
    await started()
    mocks.extract.mockResolvedValue({ textBlocks: ['@/tmp/diagram.png'], imagePaths: ['/tmp/diagram.png'] })
    const refs = [{ kind: 'file', id: 'src/api.ts', label: 'api.ts', token: '@api.ts', scope: { repositoryId: 'back', repositoryName: 'Backend' } }]
    await manager.sendMessage(id, 'look here', { deliveryMode: 'steer', queueId: 'waiting', attachmentIds: ['img'], contextRefs: refs })
    expect(updates()).toHaveLength(0)
    const send = vi.fn(async (_input: LiveInput, ack?: () => void) => { ack?.(); return true })
    runs[0].ready({ send })
    await vi.waitFor(() => expect(updates()).toHaveLength(1))
    expect(send.mock.calls[0][0]).toMatchObject({ imagePaths: ['/tmp/diagram.png'] })
    expect(send.mock.calls[0][0].text).toContain('look here')
    expect(updates()[0]).toMatchObject({ attachmentIds: ['img'], contextRefs: refs, deliveryStatus: 'delivered' })
    runs[0].finish('done')
    await turn
  })

  it('serializes successive receipts and preserves FIFO for inputs arriving during delivery', async () => {
    const id = conversation()
    const turn = manager.sendMessage(id, 'start')
    await started()
    const receipts: Array<{ accept: () => void }> = []
    const send = vi.fn((_input: LiveInput, ack?: () => void) => {
      const result = deferred<boolean>()
      receipts.push({ accept: () => { ack?.(); result.resolve(true) } })
      return result.promise
    })
    runs[0].ready({ send })
    await manager.sendMessage(id, 'first update', { deliveryMode: 'steer', queueId: 'one' })
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    await manager.sendMessage(id, 'second update', { deliveryMode: 'steer', queueId: 'two' })
    expect(send).toHaveBeenCalledTimes(1)
    receipts[0].accept()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    receipts[1].accept()
    runs[0].finish('complete')
    await turn
    expect(updates().map(m => m.queueId)).toEqual(['one', 'two'])
    expect(mocks.run).toHaveBeenCalledOnce()
  })

  it('continues normally only when native delivery explicitly reports nothing was sent', async () => {
    const id = conversation()
    const turn = manager.sendMessage(id, 'start')
    await started()
    const send = vi.fn(async () => false)
    runs[0].ready({ send })
    await manager.sendMessage(id, 'late update', { deliveryMode: 'steer', queueId: 'late' })
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    runs[0].finish('first result')
    await started(2)
    expect(runs[1].hooks.buildOpts?.prompt).toContain('late update')
    runs[1].finish('continued')
    await turn
    expect(getAgentInput(db, id, 'late')?.status).toBe('delivered')
  })

  it('preserves an unconfirmed native write without replaying it', async () => {
    const id = conversation()
    const turn = manager.sendMessage(id, 'start')
    await started()
    runs[0].ready({ send: async () => { throw new LiveInputDeliveryError('connection lost after write', true) } })
    await manager.sendMessage(id, 'do not duplicate', { deliveryMode: 'steer', queueId: 'uncertain' })
    await vi.waitFor(() => expect(getAgentInput(db, id, 'uncertain')?.status).toBe('interrupted'))
    expect(updates()[0].deliveryStatus).toBe('interrupted')
    runs[0].finish('partial result')
    await turn
    expect(mocks.run).toHaveBeenCalledOnce()
    expect(transcript(id)).toContainEqual(['user', 'do not duplicate'])
  })

  it('Stop during attachment preparation never injects the cancelled update', async () => {
    const id = conversation()
    const turn = manager.sendMessage(id, 'start')
    await started()
    const extraction = deferred<{ textBlocks: string[]; imagePaths: string[] }>()
    mocks.extract.mockReturnValue(extraction.promise)
    const send = vi.fn(async () => true)
    runs[0].ready({ send })
    await manager.sendMessage(id, 'cancel this', { deliveryMode: 'steer', queueId: 'cancel', attachmentIds: ['file'] })
    manager.abort(id)
    runs[0].finish()
    await turn
    extraction.resolve({ textBlocks: ['late data'], imagePaths: [] })
    await Promise.resolve()
    expect(send).not.toHaveBeenCalled()
    expect(getAgentInput(db, id, 'cancel')?.status).toBe('cancelled')
  })

  it('Stop after a native write preserves unconfirmed delivery rather than claiming it never arrived', async () => {
    const id = conversation()
    const turn = manager.sendMessage(id, 'start')
    await started()
    const receipt = deferred<boolean>()
    const send = vi.fn(() => receipt.promise)
    runs[0].ready({ send })
    await manager.sendMessage(id, 'possibly received', { deliveryMode: 'steer', queueId: 'written' })
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    manager.abort(id)
    receipt.reject(new LiveInputDeliveryError('stopped before receipt', true))
    runs[0].finish()
    await turn
    expect(getAgentInput(db, id, 'written')?.status).toBe('interrupted')
    const clear = broadcast.mock.calls.map(([m]) => m).find(m => m.type === 'agent_queue_cleared')
    expect(clear.messages[0].delivery_status).toBe('interrupted')
    expect(mocks.run).toHaveBeenCalledOnce()
  })

  it('never resends a native write when its receipt transaction temporarily fails', async () => {
    const id = conversation()
    const turn = manager.sendMessage(id, 'start')
    await started()
    const send = vi.fn(async (_input: LiveInput, ack?: () => void) => {
      db.pragma('query_only = ON')
      try { ack?.() }
      catch { throw new LiveInputDeliveryError('receipt persistence failed', true) }
      return true
    })
    runs[0].ready({ send })
    await manager.sendMessage(id, 'already written', { deliveryMode: 'steer', queueId: 'written' })
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    // Allow both delivery and interrupted-receipt writes to fail, then recover.
    await new Promise(resolve => setTimeout(resolve, 0))
    db.pragma('query_only = OFF')
    await manager.sendMessage(id, 'later message', { deliveryMode: 'steer', queueId: 'later' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(send).toHaveBeenCalledOnce()
    runs[0].finish('partial')
    await started(2)
    expect(getAgentInput(db, id, 'written')?.status).toBe('interrupted')
    expect(runs[1].hooks.buildOpts?.prompt).toContain('later message')
    expect(runs[1].hooks.buildOpts?.prompt).not.toContain('already written')
    runs[1].finish('done')
    await turn
  })

  it('native input wakes Specrails watch without injecting another MCP copy or acknowledgement gate', async () => {
    const id = conversation()
    const turn = manager.sendMessage(id, 'start')
    await started()
    const capability = (mocks.prepare.mock.calls[0][0] as { capability: string }).capability
    const wake = vi.fn()
    onAgentSteering(db, capability, wake)
    runs[0].ready({ send: async (_input, ack) => { ack?.(); return true } })
    await manager.sendMessage(id, 'change target', { deliveryMode: 'steer', queueId: 'wake' })
    await vi.waitFor(() => expect(updates()).toHaveLength(1))
    expect(wake).toHaveBeenCalledOnce()
    const operation = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'operation result' }] }))
    const result = await runWithAgentSteering(db, capability, undefined, operation)
    expect(result).toEqual({ content: [{ type: 'text', text: 'operation result' }] })
    expect(operation).toHaveBeenCalledOnce()
    const laterWatch = vi.fn()
    onAgentSteering(db, capability, laterWatch)
    expect(laterWatch).not.toHaveBeenCalled()
    runs[0].finish('done')
    await turn
  })
})
