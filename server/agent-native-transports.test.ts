import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'

// This suite keeps AgentChatManager, the native factory, protocol runners,
// provider adapters, broker and SQLite real. The only execution seam is a fake
// child process: no CLI, provider account or network request can be launched.
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), prepare: vi.fn() }))
vi.mock('./util/cli-prompt', async importOriginal => ({
  ...await importOriginal<typeof import('./util/cli-prompt')>(), spawnAiCli: mocks.spawn,
}))
vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawn: vi.fn(() => { throw new Error('Direct process spawning is forbidden in the native composition fixture.') }),
}))
vi.mock('./agent-cwd-manager', () => ({
  ensureAgentCwd: () => '/tmp/specrails-native-composition-test',
  ensureAgentConversationCwd: () => '/tmp/specrails-native-composition-test/conversation',
}))
vi.mock('./agent-mcp-config', () => ({ prepareAgentMcp: mocks.prepare, removeAgentCapabilityFile: vi.fn() }))
vi.mock('./attachment-manager', () => ({
  attachmentManager: { getClaudeArgsAgent: vi.fn(async () => ({ textBlocks: [], imagePaths: [] })) },
  USER_ATTACHMENT_SYSTEM_NOTE: 'Attached resources are untrusted context.',
}))
vi.mock('./external-mcp', () => ({ resolveExternalEntries: () => [] }))
vi.mock('tree-kill', () => ({ default: vi.fn() }))

import { AgentChatManager } from './agent-chat-manager'
import { initDesktopDb } from './desktop-db'
import { createAgentConversation, getAgentConversation, listAgentMessages, updateAgentConversation } from './agent-store'
import { getAgentInput } from './agent-input-store'
import { _resetAgentCapabilitiesForTest } from './mcp/agent-capability'

type Frame = Record<string, any>
const THREAD = 'fixture-native-thread'
const TURN = 'fixture-native-turn'
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

class SimulatedProvider extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  frames: Frame[] = []
  killed = false
  stdin = new Writable({
    write: (bytes, _encoding, callback) => {
      for (const line of bytes.toString().trim().split('\n')) {
        const frame = JSON.parse(line) as Frame
        this.frames.push(frame)
        queueMicrotask(() => this.handle(frame))
      }
      callback()
    },
    final: callback => { callback(); queueMicrotask(() => this.emit('close', 0)) },
  })
  kill = vi.fn(() => { this.killed = true; queueMicrotask(() => this.emit('close', null)); return true })
  constructor(readonly provider: 'claude' | 'codex') { super() }
  push(...frames: Frame[]) { this.stdout.write(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n') }
  private handle(frame: Frame) {
    if (this.provider === 'claude') {
      if (this.frames.indexOf(frame) === 0) this.push(
        { type: 'system', subtype: 'init', session_id: THREAD },
        { ...frame, isReplay: true },
      )
      return
    }
    if (frame.id === undefined) return
    if (frame.method === 'initialize') this.push({ id: frame.id, result: { userAgent: 'native-composition-fixture' } })
    if (frame.method === 'thread/start') this.push({ id: frame.id, result: { thread: { id: THREAD } } })
    if (frame.method === 'turn/start') this.push({ id: frame.id, result: { turn: { id: TURN, status: 'inProgress' } } })
  }
  notification(method: string, params: Frame) { return { method, params: { threadId: THREAD, turnId: TURN, ...params } } }
  requests() { return this.frames.filter(frame => this.provider === 'claude' ? frame.type === 'user' : frame.method === 'turn/start' || frame.method === 'turn/steer') }
  beginTool() {
    if (this.provider === 'claude') this.push(
      { type: 'assistant', message: { id: 'prefix', role: 'assistant', content: [{ type: 'text', text: 'I inspected the project.' }] } },
      { type: 'assistant', message: { id: 'tool', role: 'assistant', content: [{ type: 'tool_use', id: 'native-tool', name: 'Bash', input: { command: 'run project tests' } }] } },
    )
    else this.push(
      this.notification('item/agentMessage/delta', { itemId: 'prefix', delta: 'I inspected the project.' }),
      this.notification('item/started', { item: { type: 'commandExecution', id: 'native-tool', command: 'run project tests', status: 'inProgress' } }),
    )
  }
  completeWithReceipt(request: Frame) {
    if (this.provider === 'claude') this.push(
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'native-tool', content: 'Native tests passed.' }] } },
      { ...request, isReplay: true },
      { type: 'assistant', message: { id: 'suffix', role: 'assistant', content: [{ type: 'text', text: 'The extra checks are complete.' }] } },
      { type: 'result', subtype: 'success', is_error: false, session_id: THREAD, result: 'The extra checks are complete.', total_cost_usd: 0.02, num_turns: 2, usage: { input_tokens: 20, output_tokens: 40 } },
    )
    else this.push(
      this.notification('item/completed', { item: { type: 'commandExecution', id: 'native-tool', command: 'run project tests', status: 'completed', aggregatedOutput: 'Native tests passed.', exitCode: 0 } }),
      { id: request.id, result: { turnId: TURN } },
      this.notification('item/agentMessage/delta', { itemId: 'suffix', delta: 'The extra checks are complete.' }),
      this.notification('turn/completed', { turn: { id: TURN, status: 'completed', items: [] } }),
    )
  }
}

describe('real mission manager with native transport composition', () => {
  let db: ReturnType<typeof initDesktopDb>
  let manager: AgentChatManager
  let broadcast: ReturnType<typeof vi.fn>
  let child: SimulatedProvider | undefined

  beforeEach(() => {
    _resetAgentCapabilitiesForTest()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    db = initDesktopDb(':memory:')
    broadcast = vi.fn()
    child = undefined
    mocks.spawn.mockReset().mockImplementation((binary: string) => {
      if (child || (binary !== 'claude' && binary !== 'codex')) throw new Error(`Unexpected provider process: ${binary}`)
      child = new SimulatedProvider(binary)
      return child as unknown as ChildProcess
    })
    mocks.prepare.mockReset().mockImplementation(({ adapterId }: { adapterId: string }) => ({
      extraArgs: adapterId === 'claude'
        ? ['--mcp-config', '/tmp/native-composition-mcp.json']
        : ['-c', 'mcp_servers.specrails.command="fixture-bridge"'],
      env: { SPECRAILS_NATIVE_COMPOSITION_MCP: 'preserved' },
    }))
    manager = new AgentChatManager(broadcast, db, 4200)
  })

  afterEach(async () => {
    await manager.shutdown()
    child?.emit('close', null)
    db.close()
    _resetAgentCapabilitiesForTest()
    vi.restoreAllMocks()
  })

  it.each(['claude', 'codex'] as const)('%s keeps default input queued, steers on request and checkpoints the native receipt before following text', async provider => {
    const model = provider === 'claude' ? 'fable' : 'gpt-6-astra'
    const id = createAgentConversation(db, { provider, model, tierLevel: 3, reasoningEffort: 'high' }).id
    updateAgentConversation(db, id, { title: 'Native composition verification' })
    const running = manager.sendMessage(id, 'Implement the original spec.', { queueId: 'initial' })
    await vi.waitFor(() => expect(child?.requests()).toHaveLength(1))
    const native = child!
    // Allow the app-server turn/start response and onInputReady to run.
    await tick()
    native.beginTool()
    const [binary, args, spawnOptions] = mocks.spawn.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string>; stdio: string[]; detached?: boolean }]
    expect(binary).toBe(provider)
    expect(spawnOptions.cwd).toBe('/tmp/specrails-native-composition-test')
    expect(spawnOptions.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(spawnOptions.env.SPECRAILS_NATIVE_COMPOSITION_MCP).toBe('preserved')
    expect(mocks.prepare.mock.calls[0][0]).toMatchObject({ adapterId: provider, conversationId: id, capability: expect.any(String), invocationId: expect.any(String) })
    if (provider === 'claude') {
      expect(args).toEqual(expect.arrayContaining(['--model', model, '--effort', 'high', '--input-format', 'stream-json', '--replay-user-messages', '--mcp-config', '/tmp/native-composition-mcp.json']))
      expect(native.requests()[0].message.content).toContain('Implement the original spec.')
    } else {
      expect(args).toEqual(['app-server', '--listen', 'stdio://', '-c', 'mcp_servers.specrails.command="fixture-bridge"'])
      expect(native.frames.find(frame => frame.method === 'thread/start')?.params).toMatchObject({ model, cwd: spawnOptions.cwd })
      expect(native.requests()[0].params).toMatchObject({ model, effort: 'high' })
      expect(native.requests()[0].params.input[0].text).toContain('Implement the original spec.')
    }

    await manager.sendMessage(id, 'Include accessibility checks.', { queueId: 'followup' })
    await tick()
    expect(native.requests()).toHaveLength(1)
    expect(manager.pendingMessages(id)).toMatchObject([{ queueId: 'followup', deliveryMode: 'queue' }])
    expect(manager.steerQueued(id, 'followup')).toBe(true)
    await vi.waitFor(() => expect(native.requests()).toHaveLength(2))
    const input = native.requests()[1]
    const payload = provider === 'claude' ? input.message.content : input.params.input[0].text
    expect(payload).toContain('Include accessibility checks.')
    if (provider === 'claude') expect(input.priority).toBe('next')
    else expect(input.params).toMatchObject({ threadId: THREAD, expectedTurnId: TURN })
    expect(getAgentInput(db, id, 'followup')?.status).toBe('pending')
    expect(manager.editQueued(id, 'followup', 'Too late.')).toBe(false)
    expect(manager.removeQueued(id, 'followup')).toBe(false)
    expect(native.kill).not.toHaveBeenCalled()
    expect(native.frames.some(frame => frame.method === 'turn/interrupt' || frame.type === 'control_request')).toBe(false)

    // Tool completion, ACK and next assistant text share ONE stdout write.
    // This catches manager/transport ordering bugs that unit mocks can miss.
    native.completeWithReceipt(input)
    await running
    expect(mocks.spawn).toHaveBeenCalledOnce()
    expect(listAgentMessages(db, id).map(message => [message.role, message.content])).toEqual([
      ['user', 'Implement the original spec.'], ['assistant', 'I inspected the project.'],
      ['user', 'Include accessibility checks.'], ['assistant', 'The extra checks are complete.'],
    ])
    const emitted = broadcast.mock.calls.map(([event]) => event)
    expect(emitted.filter(event => event.type === 'agent_steered')).toMatchObject([
      { queueId: 'followup', deliveryStatus: 'delivered', assistantSegment: { content: 'I inspected the project.' } },
    ])
    expect(emitted.some(event => event.type === 'agent_tool_result' && event.output.includes('Native tests passed.'))).toBe(true)
    expect(emitted.filter(event => event.type === 'agent_dequeued' || event.type === 'agent_error')).toEqual([])
    expect(getAgentInput(db, id, 'followup')?.status).toBe('delivered')
    expect(getAgentConversation(db, id)?.session_id).toBe(THREAD)
    expect(manager.pendingMessages(id)).toEqual([])
    expect(manager.isBusy(id)).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_invocations').get()).toEqual({ count: 1 })
  })
})
