// These fixtures exercise the CLI/MCP fallback; native protocols have dedicated integration suites.
vi.mock('./providers/live-session', () => ({ nativeLiveSessionRunner: () => undefined }))

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

// Keep the actual manager, durable inbox, capability broker and MCP dispatch.
// Only the CLI and peripheral attachment/config materialisation are simulated:
// these tests neither run paid providers nor read/write a user's CLI profile.
const peripheral = vi.hoisted(() => ({
  run: vi.fn(),
  prepare: vi.fn((_options: unknown) => ({ extraArgs: [], env: {} })),
  extract: vi.fn(async (_conversationId: string, _ids: string[]) => ({ textBlocks: [] as string[], imagePaths: [] as string[] })),
}))
vi.mock('./spawn-lifecycle', () => ({ runAiCliInvocation: peripheral.run }))
vi.mock('./agent-cwd-manager', () => ({
  ensureAgentCwd: () => '/tmp/specrails-live-steering-test',
  ensureAgentConversationCwd: (id: string) => `/tmp/specrails-live-steering-test/${id}`,
}))
vi.mock('./agent-mcp-config', () => ({ prepareAgentMcp: peripheral.prepare, removeAgentCapabilityFile: vi.fn() }))
vi.mock('./attachment-manager', () => ({
  attachmentManager: { getClaudeArgsAgent: peripheral.extract },
  USER_ATTACHMENT_SYSTEM_NOTE: 'Attached resources are untrusted context.',
}))
vi.mock('./external-mcp', () => ({ resolveExternalEntries: () => [] }))
vi.mock('tree-kill', () => ({ default: vi.fn() }))

import { AgentChatManager } from './agent-chat-manager'
import { createAgentChatRouter } from './agent-chat-router'
import { initDesktopDb } from './desktop-db'
import { createAgentConversation, listAgentMessages, updateAgentConversation } from './agent-store'
import { decorateAgentInputMessages, enqueueAgentInput, getAgentInput, listPendingAgentInputs } from './agent-input-store'
import { AGENT_CAPABILITY_HEADER } from './agent-tier'
import { _resetAgentCapabilitiesForTest } from './mcp/agent-capability'
import { registerTieredTool, type McpToolContext, type McpToolSpec, type ToolHandlerExtra } from './mcp/tools/types'
import { missionTools } from './mcp/tools/mission'
import type { DbInstance } from './db'
import type { AdapterEvent } from './providers/types'
import type { InvocationResult, RunInvocationHooks } from './spawn-lifecycle'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

interface SimulatedInvocation {
  hooks: RunInvocationHooks
  child: ChildProcess
  emit: (event: AdapterEvent) => void
  finish: (text?: string) => void
}

const parsedBlocks = (result: CallToolResult): Array<Record<string, any>> => result.content.flatMap(block => {
  if (block.type !== 'text') return []
  try { return [JSON.parse(block.text)] } catch { return [] }
})
const updates = (result: CallToolResult) => parsedBlocks(result).filter(block => block.type === 'mission_user_updates')
const textOf = (result: CallToolResult) => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')

describe('mission live steering across manager, durable inbox and MCP dispatch', () => {
  let db: DbInstance
  let manager: AgentChatManager
  let broadcast: ReturnType<typeof vi.fn>
  let invocations: SimulatedInvocation[]
  let callbacks: Map<string, (args: Record<string, unknown>, extra?: ToolHandlerExtra) => Promise<CallToolResult>>
  let server: McpServer
  let ctx: McpToolContext

  beforeEach(() => {
    _resetAgentCapabilitiesForTest()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    db = initDesktopDb(':memory:')
    broadcast = vi.fn()
    invocations = []
    callbacks = new Map()
    peripheral.prepare.mockClear()
    peripheral.extract.mockReset().mockResolvedValue({ textBlocks: [], imagePaths: [] })
    peripheral.run.mockReset().mockImplementation((hooks: RunInvocationHooks) => {
      const done = deferred<InvocationResult>()
      const child = Object.assign(new EventEmitter(), {
        stdout: new Readable({ read() {} }), stderr: new Readable({ read() {} }), kill: vi.fn(),
      }) as unknown as ChildProcess
      const events: AdapterEvent[] = []
      const emit = (event: AdapterEvent) => { events.push(event); hooks.onEvent?.(event) }
      const invocation = {
        hooks, child, emit,
        finish(text?: string) {
          if (text) emit({ kind: 'text-delta', text })
          emit({ kind: 'session-started', sessionId: 'simulated-native-session' })
          child.emit('close', 0)
          done.resolve({ code: 0, timedOut: false, spawnFailed: false, events, lastResultEvent: null,
            sessionId: 'simulated-native-session', stderrTail: '', child })
        },
      }
      invocations.push(invocation)
      hooks.onSpawn?.(child)
      return done.promise
    })
    manager = new AgentChatManager(broadcast, db, 4200)
    server = { registerTool: (name: string, _config: unknown, callback: typeof callbacks extends Map<string, infer T> ? T : never) => {
      callbacks.set(name, callback)
    } } as unknown as McpServer
    ctx = { desktopDb: db, broadcast, desktopPort: 4200, registry: {} } as McpToolContext
    for (const spec of missionTools()) registerTieredTool(server, ctx, spec)
  })

  afterEach(() => {
    manager.shutdown()
    _resetAgentCapabilitiesForTest()
    db.close()
    vi.restoreAllMocks()
  })

  function conversation(provider = 'claude') {
    const conv = createAgentConversation(db, { provider, tierLevel: 3 })
    // A manually chosen title prevents the unrelated auxiliary AI title pass.
    updateAgentConversation(db, conv.id, { title: 'Live steering integration' })
    return conv.id
  }

  function tool(name: string, handler: McpToolSpec['handler']) {
    registerTieredTool(server, ctx, { name, title: name, description: name, tier: 'write', inputSchema: {}, handler })
  }

  function call(conversationId: string, name: string, args: Record<string, unknown> = {}) {
    const config = peripheral.prepare.mock.calls.map(([options]) => options as { conversationId: string; capability: string })
      .filter(options => options.conversationId === conversationId).at(-1)
    expect(config?.capability).toBeTruthy()
    return callbacks.get(name)!(args, { requestInfo: { headers: { [AGENT_CAPABILITY_HEADER]: config!.capability } } })
  }

  const ack = (id: string, revision: number) => call(id, 'specrails_mission', { action: 'acknowledge_updates', revision })
  const events = (type: string) => broadcast.mock.calls.map(([event]) => event).filter(event => event.type === type)
  const transcript = (id: string) => listAgentMessages(db, id).map(message => [message.role, message.content])
  it('records an explicit initial-message read receipt in a provider with MCP delivery', async () => {
    const id = conversation('gemini')
    const running = manager.sendMessage(id, 'Start the task.', { queueId: 'initial' })
    await vi.waitFor(() => expect(invocations).toHaveLength(1))
    expect(invocations[0].hooks.buildOpts?.prompt).toContain('Mission input ID: "initial"')
    expect(getAgentInput(db, id, 'initial')?.receipt).toBe('sent')
    expect((await call(id, 'specrails_mission', { action: 'acknowledge_inputs', inputIds: ['initial'] })).isError).toBeUndefined()
    expect(getAgentInput(db, id, 'initial')?.receipt).toBe('read')
    invocations[0].finish('done')
    await running
  })
  it('leaves an ordinary queued input out of MCP actions until the user explicitly selects Steer', async () => {
    const id = conversation('gemini')
    const action = vi.fn(() => 'current action result')
    tool('test_read', action)
    const running = manager.sendMessage(id, 'Start the task.')
    await vi.waitFor(() => expect(invocations).toHaveLength(1))
    await manager.sendMessage(id, 'New direction.', { queueId: 'manual' })
    expect(updates(await call(id, 'test_read'))).toEqual([])
    expect(action).toHaveBeenCalledOnce()
    expect(manager.steerQueued(id, 'manual')).toBe(true)
    expect(updates(await call(id, 'test_read'))).toHaveLength(1)
    expect(getAgentInput(db, id, 'manual')?.receipt).toBe('received')
    await ack(id, 1)
    expect(getAgentInput(db, id, 'manual')?.receipt).toBe('read')
    expect(events('agent_input_receipt')).toContainEqual(expect.objectContaining({ queueId: 'manual', receipt: 'read' }))
    expect(action).toHaveBeenCalledOnce()
    await ack(id, 1)
    invocations[0].finish('Updated task complete.')
    await running
    expect(invocations).toHaveLength(1)
  })
  it('reports a deleted input explicitly on a delayed HTTP retry without resurrecting a message', async () => {
    const id = conversation()
    const running = manager.sendMessage(id, 'Start the task.')
    await vi.waitFor(() => expect(invocations).toHaveLength(1))
    await manager.sendMessage(id, 'Delete this instruction.', { queueId: 'removed' })
    expect(manager.removeQueued(id, 'removed')).toBe(true)
    const retry = route('post', '/conversations/:id/send', { id }, { text: 'Delete this instruction.', queueId: 'removed' })
    expect(retry.status).toBe(202)
    expect(retry.body).toEqual({ accepted: true, queued: false, duplicate: true, removed: true })
    expect(manager.pendingMessages(id)).toEqual([])
    expect(transcript(id)).toEqual([['user', 'Start the task.']])
    invocations[0].finish('Done.')
    await running
    expect(invocations).toHaveLength(1)
  })
  async function started(count = 1) { await vi.waitFor(() => expect(invocations).toHaveLength(count)) }
  function route(method: 'post' | 'patch', routePath: string, params: Record<string, string>, body: unknown) {
    // Dispatch the real route handler in memory; a sandboxed test must not
    // require opening a listening socket to verify HTTP admission semantics.
    const router = createAgentChatRouter({ manager, desktopDb: db })
    const layer = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method])
    expect(layer).toBeDefined()
    const result = { status: 200, body: undefined as any }
    const response = {
      status(code: number) { result.status = code; return response },
      json(value: unknown) { result.body = value; return response },
    }
    layer!.route.stack.at(-1)!.handle({ params, body }, response, (error?: unknown) => { if (error) throw error })
    return result
  }

  it.each(['claude', 'codex', 'gemini', 'kimi'])('steers %s within the same invocation and gates stale actions until acknowledgement', async provider => {
    const id = conversation(provider)
    const action = vi.fn(() => ({ changed: 'revised target' }))
    tool('test_write', action)
    const running = manager.sendMessage(id, 'Implement the requested feature.', { deliveryMode: 'steer', queueId: 'initial' })
    await started()
    invocations[0].emit({ kind: 'text-delta', text: 'I inspected the original target.' })
    await manager.sendMessage(id, 'Use the revised target instead.', { deliveryMode: 'steer', queueId: 'revision' })
    expect(getAgentInput(db, id, 'revision')?.status).toBe('pending')
    expect(manager.activeTurns().turns[0].pendingMessages).toMatchObject([{ queueId: 'revision', deliveryMode: 'steer' }])
    const gated = await call(id, 'test_write')
    expect(parsedBlocks(gated)[0]).toMatchObject({ code: 'tool_not_executed', executed: false })
    expect(updates(gated)).toMatchObject([{ revision: 1 }])
    expect(updates(gated)[0].content).toContain('Use the revised target instead.')
    expect(action).not.toHaveBeenCalled()
    expect(invocations).toHaveLength(1)
    expect(manager.conversationLive(id).streamingText).toBe('')
    expect(manager.pendingMessages(id)).toEqual([])
    const delivery = events('agent_steered')[0]
    expect(delivery).toMatchObject({ queueId: 'revision', assistantSegment: { content: 'I inspected the original target.' } })
    const stored = getAgentInput(db, id, 'revision')!
    expect(stored).toMatchObject({ status: 'delivered', messageId: delivery.messageId })
    await call(id, 'test_write')
    expect(action).not.toHaveBeenCalled()
    expect(events('agent_steered')).toHaveLength(1)
    expect(await ack(id, 1)).not.toHaveProperty('isError', true)
    expect(parsedBlocks(await call(id, 'test_write'))[0]).toEqual({ changed: 'revised target' })
    expect(action).toHaveBeenCalledOnce()
    invocations[0].finish('The revised target is complete.')
    await running
    expect(transcript(id)).toEqual([
      ['user', 'Implement the requested feature.'], ['assistant', 'I inspected the original target.'],
      ['user', 'Use the revised target instead.'], ['assistant', 'The revised target is complete.'],
    ])
    expect(listAgentMessages(db, id).find(message => message.id === delivery.messageId)?.created_at).toBe(delivery.timestamp)
    expect(events('agent_done')[0]).toMatchObject({ fullText: 'The revised target is complete.' })
    expect(events('agent_dequeued')).toEqual([])
    expect(events('agent_error')).toEqual([])
    expect(manager.activeTurns().turns).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_invocations').get()).toEqual({ n: 1 })
  })

  it.each([false, true])('preserves an already running tool result (failure=%s), then delivers the user update', async failure => {
    const id = conversation(), done = deferred()
    const action = vi.fn(async () => {
      await done.promise
      if (failure) throw new Error('Existing work encountered a merge conflict.')
      return { jobId: 'existing-job-42', committed: true }
    })
    tool('test_running', action)
    const stale = vi.fn(() => ({ shouldNotRun: true }))
    tool('test_stale', stale)
    const running = manager.sendMessage(id, 'Start work.', { deliveryMode: 'steer', queueId: 'initial' })
    await started()
    const inFlight = call(id, 'test_running')
    expect(action).toHaveBeenCalledOnce()
    await manager.sendMessage(id, 'After that operation, inspect the conflict.', { deliveryMode: 'steer', queueId: 'update' })
    const held = await call(id, 'test_stale')
    expect(parsedBlocks(held)[0].reason).toBe('waiting_for_running_tools')
    expect(events('agent_steered')).toEqual([])
    expect(await ack(id, 1)).toHaveProperty('isError', true)
    done.resolve()
    const result = await inFlight
    if (failure) {
      expect(result.isError).toBe(true)
      expect(result.content[0]).toMatchObject({ text: 'Error: Existing work encountered a merge conflict.' })
    } else expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ jobId: 'existing-job-42', committed: true })
    expect(updates(result)[0].content).toContain('After that operation, inspect the conflict.')
    expect(stale).not.toHaveBeenCalled()
    expect(events('agent_steered')).toHaveLength(1)
    await ack(id, 1)
    invocations[0].finish('I inspected the result.')
    await running
    expect(invocations).toHaveLength(1)
  })

  it('claims a delivery before extraction, rejects claimed edits, and keeps later messages behind a newer revision', async () => {
    const id = conversation(), extraction = deferred<{ textBlocks: string[]; imagePaths: string[] }>()
    const action = vi.fn(() => 'done')
    tool('test_write', action)
    const running = manager.sendMessage(id, 'Begin.', { deliveryMode: 'steer', queueId: 'initial' })
    await started()
    peripheral.extract.mockReturnValueOnce(extraction.promise)
    await manager.sendMessage(id, 'Original correction.', { deliveryMode: 'steer', queueId: 'first', attachmentIds: ['resource-1'] })
    expect(manager.editQueued(id, 'first', 'Edited correction.')).toBe(true)
    const firstBoundary = call(id, 'test_write')
    await vi.waitFor(() => expect(peripheral.extract).toHaveBeenCalledOnce())
    expect(manager.editQueued(id, 'first', 'Too late.')).toBe(false)
    expect(route('patch', '/conversations/:id/queue/:queueId', { id, queueId: 'first' }, { text: 'Late HTTP edit.' })).toMatchObject({ status: 409 })
    expect(getAgentInput(db, id, 'first')?.text).toBe('Edited correction.')
    await manager.sendMessage(id, 'Another correction.', { deliveryMode: 'steer', queueId: 'second' })
    extraction.resolve({ textBlocks: ['Extracted evidence.'], imagePaths: [] })
    const firstResult = await firstBoundary
    expect(textOf(firstResult)).toContain('Edited correction.')
    expect(textOf(firstResult)).toContain('Extracted evidence.')
    expect(textOf(firstResult)).not.toContain('Too late.')
    expect(getAgentInput(db, id, 'second')?.status).toBe('pending')
    const secondResult = await ack(id, 1)
    expect(parsedBlocks(secondResult)[0]).toMatchObject({ acknowledged: true, revision: 1, pendingRevision: 2 })
    expect(updates(secondResult).at(-1)).toMatchObject({ revision: 2 })
    expect(textOf(secondResult)).toContain('Another correction.')
    expect(await call(id, 'test_write')).toHaveProperty('isError', true)
    expect(action).not.toHaveBeenCalled()
    await ack(id, 2)
    await call(id, 'test_write')
    expect(action).toHaveBeenCalledOnce()
    invocations[0].finish('Both corrections incorporated.')
    await running
    expect(transcript(id)).toEqual([
      ['user', 'Begin.'], ['user', 'Edited correction.'], ['user', 'Another correction.'],
      ['assistant', 'Both corrections incorporated.'],
    ])
    expect(events('agent_steered')).toHaveLength(2)
    expect(invocations).toHaveLength(1)
  })

  it('keeps attachments and resolved references when no MCP boundary occurs and falls back to a resumed turn', async () => {
    const id = conversation(), referenceId = conversation()
    updateAgentConversation(db, referenceId, { title: 'Deployment discussion' })
    const refs = [{ kind: 'conversation', id: referenceId, label: 'Deployment discussion', token: '@deployment' }]
    const running = manager.sendMessage(id, 'Prepare the original work.', { deliveryMode: 'steer', queueId: 'initial' })
    await started()
    peripheral.extract.mockResolvedValue({ textBlocks: ['Attached deployment checklist.'], imagePaths: [] })
    await manager.sendMessage(id, 'Include deployment details.', { deliveryMode: 'steer', queueId: 'update', attachmentIds: ['checklist'], contextRefs: refs })
    invocations[0].finish('Original work prepared.')
    await started(2)
    expect(invocations[1].hooks.action).toBe('chat-resume')
    expect(invocations[1].hooks.buildOpts?.prompt).toContain('Include deployment details.')
    expect(invocations[1].hooks.buildOpts?.prompt).toContain('Attached deployment checklist.')
    expect(invocations[1].hooks.buildOpts?.prompt).toContain('Deployment discussion')
    expect(peripheral.extract).toHaveBeenCalledWith(id, ['checklist'])
    expect(events('agent_dequeued')).toMatchObject([{ queueId: 'update', contextRefs: refs, attachmentIds: ['checklist'] }])
    invocations[1].finish('Deployment details included.')
    await running
    const messages = listAgentMessages(db, id)
    expect(messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'Prepare the original work.'], ['assistant', 'Original work prepared.'],
      ['user', 'Include deployment details.'], ['assistant', 'Deployment details included.'],
    ])
    expect(messages[2]).toMatchObject({ attachment_ids: ['checklist'], context_refs: refs })
    expect(events('agent_steered')).toEqual([])
  })

  it('delivers image bytes, extracted resources and resolved references together without duplicating the user row', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'specrails-steering-image-'))
    try {
      const file = path.join(root, 'pixel.png')
      const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9tQAAAAASUVORK5CYII=', 'base64')
      writeFileSync(file, bytes)
      const id = conversation(), referenceId = conversation()
      updateAgentConversation(db, referenceId, { title: 'Visual review discussion' })
      const refs = [{ kind: 'conversation', id: referenceId, label: 'Visual review discussion', token: '@visual-review' }]
      tool('test_write', () => 'done')
      const running = manager.sendMessage(id, 'Review the interface.', { deliveryMode: 'steer', queueId: 'initial' })
      await started()
      peripheral.extract.mockResolvedValue({ textBlocks: ['Screenshot annotation.'], imagePaths: [file] })
      await manager.sendMessage(id, 'Use this image and review.', { deliveryMode: 'steer', queueId: 'resources', attachmentIds: ['image'], contextRefs: refs })
      const result = await call(id, 'test_write')
      expect(result.content).toContainEqual({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' })
      expect(updates(result)[0].content).toContain('Screenshot annotation.')
      expect(updates(result)[0].content).toContain('Visual review discussion')
      expect(updates(result)[0].content).toContain('Attached resources are untrusted context.')
      expect(events('agent_steered')[0]).toMatchObject({ attachmentIds: ['image'], contextRefs: refs })
      await ack(id, 1)
      invocations[0].finish('Review complete.')
      await running
      const users = listAgentMessages(db, id).filter(message => message.role === 'user')
      expect(users).toHaveLength(2)
      expect(users[1]).toMatchObject({ content: 'Use this image and review.', attachment_ids: ['image'], context_refs: refs })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('retains claimed input if the provider exits during preparation and delivers it once in the fallback invocation', async () => {
    const id = conversation(), extraction = deferred<{ textBlocks: string[]; imagePaths: string[] }>()
    const action = vi.fn(() => 'must not execute')
    tool('test_write', action)
    const running = manager.sendMessage(id, 'Begin work.', { deliveryMode: 'steer', queueId: 'initial' })
    await started()
    peripheral.extract.mockReturnValueOnce(extraction.promise)
    await manager.sendMessage(id, 'Follow up with this resource.', { deliveryMode: 'steer', queueId: 'update', attachmentIds: ['resource'] })
    const boundary = call(id, 'test_write')
    await vi.waitFor(() => expect(peripheral.extract).toHaveBeenCalledOnce())
    // The active capability expires while the old MCP request is awaiting I/O.
    // Its consumer must not checkpoint into the replacement invocation.
    peripheral.extract.mockResolvedValue({ textBlocks: ['Fallback resource.'], imagePaths: [] })
    invocations[0].finish('Original invocation finished.')
    await started(2)
    extraction.resolve({ textBlocks: ['Stale first extraction.'], imagePaths: [] })
    expect(await boundary).toHaveProperty('isError', true)
    expect(invocations[1].hooks.buildOpts?.prompt).toContain('Fallback resource.')
    expect(invocations[1].hooks.buildOpts?.prompt).not.toContain('Stale first extraction.')
    invocations[1].finish('Follow-up complete.')
    await running
    expect(action).not.toHaveBeenCalled()
    expect(events('agent_steered')).toEqual([])
    expect(events('agent_dequeued')).toHaveLength(1)
    expect(transcript(id)).toEqual([
      ['user', 'Begin work.'], ['assistant', 'Original invocation finished.'],
      ['user', 'Follow up with this resource.'], ['assistant', 'Follow-up complete.'],
    ])
  })

  it('settles a turn that ends immediately after a checkpoint without an empty or repeated assistant row', async () => {
    const id = conversation()
    tool('test_write', () => 'done')
    const running = manager.sendMessage(id, 'Begin.', { deliveryMode: 'steer', queueId: 'initial' })
    await started()
    invocations[0].emit({ kind: 'text-delta', text: 'Existing explanation.' })
    await manager.sendMessage(id, 'That is enough.', { deliveryMode: 'steer', queueId: 'update' })
    await call(id, 'test_write')
    await ack(id, 1)
    invocations[0].finish()
    await running
    expect(transcript(id)).toEqual([
      ['user', 'Begin.'], ['assistant', 'Existing explanation.'], ['user', 'That is enough.'],
    ])
    expect(events('agent_done')).toHaveLength(1)
    expect(events('agent_error')).toEqual([])
    expect(invocations).toHaveLength(1)
    expect(manager.isBusy(id)).toBe(false)
  })

  it('rotates the capability on stale-session retry, revokes the old bridge, and keeps pending updates in the fresh invocation', async () => {
    const id = conversation('codex')
    updateAgentConversation(db, id, { session_id: 'expired-native-session' })
    const action = vi.fn(() => 'replanned operation')
    tool('test_write', action)
    const running = manager.sendMessage(id, 'Resume the work.', { deliveryMode: 'steer', queueId: 'initial' })
    await started()
    expect(invocations[0].hooks.action).toBe('chat-resume')
    const oldConfig = peripheral.prepare.mock.calls[0][0] as { capability: string; invocationId: string }
    await manager.sendMessage(id, 'Use the new plan.', { deliveryMode: 'steer', queueId: 'update' })
    invocations[0].emit({ kind: 'error', message: 'No rollout found for thread id expired-native-session' })
    invocations[0].finish()
    await started(2)
    const newConfig = peripheral.prepare.mock.calls[1][0] as { capability: string; invocationId: string }
    expect(newConfig.capability).not.toBe(oldConfig.capability)
    expect(newConfig.invocationId).not.toBe(oldConfig.invocationId)
    expect(invocations[1].hooks.action).toBe('chat-turn')
    const stale = await callbacks.get('test_write')!({}, { requestInfo: { headers: { [AGENT_CAPABILITY_HEADER]: oldConfig.capability } } })
    expect(stale.isError).toBe(true)
    expect(textOf(stale)).toContain('revoked')
    expect(action).not.toHaveBeenCalled()
    expect(textOf(await call(id, 'test_write'))).toContain('Use the new plan.')
    expect(action).not.toHaveBeenCalled()
    await ack(id, 1)
    await call(id, 'test_write')
    expect(action).toHaveBeenCalledOnce()
    invocations[1].finish('New plan completed.')
    await running
    expect(events('agent_error')).toEqual([])
    expect(transcript(id)).toEqual([
      ['user', 'Resume the work.'], ['user', 'Use the new plan.'], ['assistant', 'New plan completed.'],
    ])
  })

  it('deduplicates initial and queued HTTP retries, retains edits, and exposes stable pending snapshots', async () => {
    const id = conversation()
    tool('test_read', () => 'read')
    const running = manager.sendMessage(id, 'Original task.', { deliveryMode: 'steer', queueId: 'initial' })
    await started()
    await manager.sendMessage(id, 'Original task.', { deliveryMode: 'steer', queueId: 'initial' })
    await manager.sendMessage(id, 'Pending correction.', { deliveryMode: 'steer', queueId: 'update' })
    const before = manager.activeTurns()
    expect(manager.editQueued(id, 'update', 'Edited correction.')).toBe(true)
    await manager.sendMessage(id, 'Pending correction.', { deliveryMode: 'steer', queueId: 'update' })
    expect(() => manager.sendMessage(id, 'Different payload.', { deliveryMode: 'steer', queueId: 'update' })).toThrow(/different|conflict|already/i)
    const after = manager.activeTurns()
    expect(after.snapshotVersion).toBeGreaterThan(before.snapshotVersion)
    expect(after.turns[0].pendingMessages).toMatchObject([{ queueId: 'update', text: 'Edited correction.' }])
    expect(after.turns[0].pendingMessages[0].timestamp).toBe(before.turns[0].pendingMessages[0].timestamp)
    expect(events('agent_queued')).toHaveLength(1)
    await call(id, 'test_read')
    await manager.sendMessage(id, 'Pending correction.', { deliveryMode: 'steer', queueId: 'update' })
    const retry = route('post', '/conversations/:id/send', { id }, { text: 'Pending correction.', deliveryMode: 'steer', queueId: 'update' })
    expect(retry.status).toBe(202)
    expect(retry.body).toMatchObject({ accepted: true, queued: false, duplicate: true, message: { content: 'Edited correction.', delivery_status: 'delivered' } })
    expect(route('post', '/conversations/:id/send', { id }, { text: 'Conflicting retry.', queueId: 'update' }).status).toBe(409)
    expect(manager.pendingMessages(id)).toEqual([])
    await ack(id, 1)
    invocations[0].finish('Done.')
    await running
    await manager.sendMessage(id, 'Original task.', { deliveryMode: 'steer', queueId: 'initial' })
    expect(transcript(id)).toEqual([['user', 'Original task.'], ['user', 'Edited correction.'], ['assistant', 'Done.']])
    expect(invocations).toHaveLength(1)
  })

  it('stops a reserved attachment turn without spawning it and still accepts deliberate new input before extraction settles', async () => {
    const id = conversation(), extraction = deferred<{ textBlocks: string[]; imagePaths: string[] }>()
    peripheral.extract.mockReturnValueOnce(extraction.promise)
    const running = manager.sendMessage(id, 'Cancelled initial request.', { deliveryMode: 'steer', queueId: 'old', attachmentIds: ['slow-file'] })
    expect(manager.isBusy(id)).toBe(true)
    expect(invocations).toEqual([])
    manager.abort(id)
    expect(getAgentInput(db, id, 'old')?.status).toBe('cancelled')
    await manager.sendMessage(id, 'New deliberate request.', { deliveryMode: 'steer', queueId: 'new' })
    extraction.resolve({ textBlocks: ['Old attachment.'], imagePaths: [] })
    await started()
    expect(invocations[0].hooks.buildOpts?.prompt).toContain('New deliberate request.')
    expect(invocations[0].hooks.buildOpts?.prompt).not.toContain('Cancelled initial request.')
    expect(invocations[0].hooks.buildOpts?.prompt).not.toContain('Old attachment.')
    invocations[0].finish('New request completed.')
    await running
    expect(decorateAgentInputMessages(db, listAgentMessages(db, id))).toMatchObject([
      { role: 'user', content: 'Cancelled initial request.', delivery_status: 'cancelled' },
      { role: 'user', content: 'New deliberate request.', delivery_status: 'delivered' },
      { role: 'assistant', content: 'New request completed.' },
    ])
    expect(events('agent_steered')).toEqual([])
    expect(events('agent_error')).toEqual([])
    expect(manager.isBusy(id)).toBe(false)
  })

  it('revokes a claimed steering delivery on Stop and persists its original resources as cancelled', async () => {
    const id = conversation(), extraction = deferred<{ textBlocks: string[]; imagePaths: string[] }>()
    const action = vi.fn(() => 'must not run')
    tool('test_write', action)
    const running = manager.sendMessage(id, 'Begin.', { deliveryMode: 'steer', queueId: 'initial' })
    await started()
    invocations[0].emit({ kind: 'text-delta', text: 'Partial work.' })
    peripheral.extract.mockReturnValueOnce(extraction.promise)
    await manager.sendMessage(id, 'Pending resource.', { deliveryMode: 'steer', queueId: 'update', attachmentIds: ['slow-resource'] })
    const boundary = call(id, 'test_write')
    await vi.waitFor(() => expect(peripheral.extract).toHaveBeenCalledOnce())
    manager.abort(id)
    extraction.resolve({ textBlocks: ['Late extracted evidence.'], imagePaths: [] })
    expect(await boundary).toHaveProperty('isError', true)
    invocations[0].finish()
    await running
    expect(action).not.toHaveBeenCalled()
    expect(events('agent_steered')).toEqual([])
    expect(decorateAgentInputMessages(db, listAgentMessages(db, id))).toContainEqual(expect.objectContaining({
      content: 'Pending resource.', attachment_ids: ['slow-resource'], delivery_status: 'cancelled',
    }))
    expect(listAgentMessages(db, id).filter(message => message.content === 'Partial work.')).toHaveLength(1)
    expect(invocations).toHaveLength(1)
    expect(listPendingAgentInputs(db, id)).toEqual([])
  })

  it('recovers pending inputs at startup as interrupted without replay, with duplicate submission still idempotent', async () => {
    const id = conversation()
    manager.shutdown()
    const refs = [{ kind: 'action', id: 'review', label: 'Review', token: '/review' }]
    const options = { attachmentIds: ['resource'], contextRefs: refs }
    enqueueAgentInput(db, { conversationId: id, queueId: 'orphan', text: 'Survive the restart.', options })
    manager = new AgentChatManager(broadcast, db, 4200)
    expect(decorateAgentInputMessages(db, listAgentMessages(db, id))).toMatchObject([
      { content: 'Survive the restart.', attachment_ids: ['resource'], context_refs: refs, delivery_status: 'interrupted' },
    ])
    const messageId = getAgentInput(db, id, 'orphan')?.messageId
    await manager.sendMessage(id, 'Survive the restart.', { ...options, queueId: 'orphan' })
    expect(getAgentInput(db, id, 'orphan')?.messageId).toBe(messageId)
    expect(manager.pendingMessages(id)).toEqual([])
    expect(manager.activeTurns().turns).toEqual([])
    expect(invocations).toEqual([])
    expect(peripheral.extract).not.toHaveBeenCalled()
  })
})
