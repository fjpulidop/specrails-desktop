import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  createLocalAdapter,
  filterLocalExtraArgs,
  isLocalAdapter,
  localConnectionRates,
  parseLocalStreamLine,
  extractLocalResult,
  resolveLocalRunnerScript,
  resolveLocalRunnerNode,
  type LocalConnection,
} from './local-adapter'
import { parseStreamEvents } from './runtime'
import { setCachedProbe, _resetForTests } from '../local-engine-detection'
import type { AdapterEvent, SpawnAction } from './types'

const conn: LocalConnection = { id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', apiKeyEnv: 'LOCAL_KEY' }

function argsOf(adapter = createLocalAdapter(conn), action: SpawnAction, extra: Record<string, unknown> = {}): string[] {
  return adapter.buildArgs(action, { prompt: 'hi', model: 'qwen', ...extra })
}

describe('createLocalAdapter — identity + capabilities', () => {
  beforeEach(() => _resetForTests())

  it('advertises the honest capability block from the spec', () => {
    const a = createLocalAdapter(conn)
    expect(a.id).toBe('local')
    expect(a.displayName).toBe('local')
    expect(createLocalAdapter({ ...conn, label: 'LAN box' }).displayName).toBe('LAN box')
    expect(a.instructionsFilename).toBe('AGENTS.md')
    expect(a.projectDirName).toBe('.specrails-local')
    expect(a.mcpRegistration).toBe('project-json')
    expect(a.minCliVersion).toBeNull()
    expect(a.projectMcpPath!('/root')).toBe(path.join('/root', '.specrails-local', 'mcp.json'))
    expect(a.capabilities).toMatchObject({
      persistentStdin: true, nativeResume: true, nativeStreamJson: true, freestyle: true,
      customModelAliases: true, toolPolicies: ['none', 'read-only'], reportsUsage: true,
      nativeCostUsd: false, nativeOtelEnv: false, structuredActions: false, profiles: false,
      customRoles: false, userMcp: false, systemPromptArg: true, profileEnvSupport: false,
      supportsImageInput: false, supportsReasoningEffort: false,
    })
    expect(a.capabilities.reasoningEfforts).toBeUndefined()
    expect(createLocalAdapter({ ...conn, supportsReasoningEffort: true }).capabilities).toMatchObject({
      supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high'],
    })
    expect(a.baselineAgents()).toEqual(['sr-architect', 'sr-developer', 'sr-reviewer'])
    expect(a.formatCoreCommand!('/specrails:implement #1')).toBe('/specrails:implement #1')
    expect(a.buildRepoAccessArgs!(['/a', '/b'])).toEqual(['--add-dir', '/a', '--add-dir', '/b'])
    expect(isLocalAdapter(a)).toBe(true)
    expect(localConnectionRates(a)).toBeNull()
    expect(localConnectionRates(createLocalAdapter({ ...conn, rates: { inputPer1M: 1, outputPer1M: 2 } }))).toEqual({ inputPer1M: 1, outputPer1M: 2 })
  })

  it('model catalog reads the detection cache, falls back to the stored default, marks the default', () => {
    const a = createLocalAdapter({ ...conn, defaultModel: 'qwen3.5-9b:latest' })
    expect(a.modelCatalog()).toEqual([{ value: 'qwen3.5-9b:latest', label: 'qwen3.5-9b:latest', default: true }])
    expect(a.defaultModel()).toBe('qwen3.5-9b:latest')
    const bare = createLocalAdapter(conn)
    expect(bare.modelCatalog()).toEqual([{ value: 'default', label: 'default', default: true }])
    expect(bare.defaultModel()).toBe('default')
    setCachedProbe('local', { reachable: true, installed: true, executable: true, authState: 'authenticated', models: ['hf.co/x/y:Q5', 'qwen3.5-9b:latest'], latencyMs: 5 })
    expect(a.modelCatalog()).toEqual([
      { value: 'hf.co/x/y:Q5', label: 'hf.co/x/y:Q5' },
      { value: 'qwen3.5-9b:latest', label: 'qwen3.5-9b:latest', default: true },
    ])
    expect(bare.modelCatalog()[0]).toMatchObject({ value: 'hf.co/x/y:Q5', default: true })
    expect(bare.defaultModel()).toBe('hf.co/x/y:Q5')
    // An unauthenticated probe contributes no models.
    setCachedProbe('local', { reachable: true, installed: true, executable: true, authState: 'unauthenticated', models: [], latencyMs: 5 })
    expect(bare.modelCatalog()).toEqual([{ value: 'default', label: 'default', default: true }])
  })

  it('detectInstalled is the HTTP probe mapped to DetectionResult (no version)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const ok = await createLocalAdapter(conn).detectInstalled()
      expect(ok).toEqual({ installed: true, executable: true })
      fetchMock.mockImplementationOnce(async () => { throw new Error('ECONNREFUSED') })
      const down = await createLocalAdapter(conn).detectInstalled()
      expect(down).toEqual({ installed: false, executable: false, error: 'ECONNREFUSED' })
    } finally { vi.unstubAllGlobals() }
  })
})

describe('local adapter buildArgs', () => {
  it('prefixes the runner script and emits the connection flags for chat-turn', () => {
    const args = argsOf(undefined, 'chat-turn', { systemPrompt: 'SYS', maxTurns: 3, toolPolicy: 'read-only' })
    expect(args[0]).toMatch(/specrails-local-runner\.js$/)
    expect(args.slice(1)).toEqual([
      '--model', 'qwen', '--base-url', 'http://127.0.0.1:8080/v1', '--api-key-env', 'LOCAL_KEY',
      '--tools', 'Read,Grep,Glob', '--output-format', 'stream-json',
      '--system-prompt', 'SYS', '--max-turns', '3', '-p', 'hi',
    ])
  })

  it('maps tool policies: none → __none__, read-only → Read,Grep,Glob, default → nothing', () => {
    expect(argsOf(undefined, 'chat-turn', { toolPolicy: 'none' })).toContain('__none__')
    expect(argsOf(undefined, 'chat-turn', { toolPolicy: 'default' })).not.toContain('--tools')
    expect(argsOf(undefined, 'chat-turn')).not.toContain('--tools')
    // auto-title is always pure-output
    expect(argsOf(undefined, 'auto-title')).toEqual(expect.arrayContaining(['--tools', '__none__', '-p', 'hi']))
  })

  it('chat-resume carries --resume and throws without a session id', () => {
    const args = argsOf(undefined, 'chat-resume', { sessionId: 's1' })
    expect(args.slice(args.indexOf('--resume'))).toEqual(['--resume', 's1', '-p', 'hi'])
    expect(() => argsOf(undefined, 'chat-resume')).toThrow('chat-resume requires sessionId')
    expect(() => argsOf(undefined, 'setup-enrich-resume')).toThrow('setup-enrich-resume requires sessionId')
  })

  it('chat-stream uses stdin input, no -p, no --max-turns, optional --resume', () => {
    const fresh = argsOf(undefined, 'chat-stream', { systemPrompt: 'S', maxTurns: 9 })
    expect(fresh).toContain('--input-format')
    expect(fresh[fresh.indexOf('--input-format') + 1]).toBe('stream-json')
    expect(fresh).not.toContain('-p')
    expect(fresh).not.toContain('--max-turns')
    expect(fresh).not.toContain('--resume')
    const resumed = argsOf(undefined, 'chat-stream', { sessionId: 's2' })
    expect(resumed).toEqual(expect.arrayContaining(['--resume', 's2']))
  })

  it('rail-job appends the system prompt, spec-gen/agent-refine/setup variants keep their shape', () => {
    const rail = argsOf(undefined, 'rail-job', { systemPrompt: 'RULE' })
    expect(rail).toEqual(expect.arrayContaining(['--append-system-prompt', 'RULE', '-p', 'hi']))
    expect(rail).not.toContain('--system-prompt')
    const spec = argsOf(undefined, 'spec-gen', { systemPrompt: 'S', maxTurns: 2 })
    expect(spec.indexOf('--max-turns')).toBeLessThan(spec.indexOf('--system-prompt'))
    const refine = argsOf(undefined, 'agent-refine', { sessionId: 'r1' })
    expect(refine).toEqual(expect.arrayContaining(['--resume', 'r1', '-p', 'hi']))
    expect(argsOf(undefined, 'agent-refine')).not.toContain('--resume')
    const setup = argsOf(undefined, 'setup-enrich')
    expect(setup.slice(1, 3)).toEqual(['-p', 'hi'])
    const setupResume = argsOf(undefined, 'setup-enrich-resume', { sessionId: 'u1' })
    expect(setupResume.slice(1, 3)).toEqual(['--resume', 'u1'])
    expect(setupResume.slice(-2)).toEqual(['-p', 'hi'])
  })

  it('emits --reasoning-effort only when the connection supports it; falls back to the default model', () => {
    expect(argsOf(undefined, 'chat-turn', { reasoning_effort: 'high' })).not.toContain('--reasoning-effort')
    const capable = createLocalAdapter({ ...conn, supportsReasoningEffort: true, defaultModel: 'dflt' })
    const args = capable.buildArgs('chat-turn', { prompt: 'x', model: '', reasoning_effort: 'high' })
    expect(args).toEqual(expect.arrayContaining(['--reasoning-effort', 'high', '--model', 'dflt']))
    expect(createLocalAdapter({ id: 'l2', kind: 'openai-compatible', baseUrl: 'http://x' }).buildArgs('chat-turn', { prompt: 'x', model: '' })).toEqual(expect.arrayContaining(['--model', 'default']))
    expect(argsOf(createLocalAdapter({ id: 'nokey', kind: 'openai-compatible', baseUrl: 'http://x' }), 'chat-turn')).not.toContain('--api-key-env')
  })

  it('passes runner-known extras and strips claude/codex-only flags (with their values)', () => {
    const extra = [
      '--dangerously-skip-permissions', '--setting-sources', 'project,local', '--permission-mode', 'plan', '--safe-mode',
      '--effort', 'high', '--verbose', '--plugin-dir', '/opsx', '-c', 'sandbox=x', '--yolo',
      '--tools', 'Read,Grep,Glob', '--disallowedTools', 'Write,Edit', '--mcp-config', '/f.json', '--add-dir', '/repo',
      'stray',
    ]
    expect(filterLocalExtraArgs(extra)).toEqual([
      '--tools', 'Read,Grep,Glob', '--disallowedTools', 'Write,Edit', '--mcp-config', '/f.json', '--add-dir', '/repo',
    ])
    expect(filterLocalExtraArgs(undefined)).toEqual([])
    expect(filterLocalExtraArgs([])).toEqual([])
    // A foreign value flag at the end / followed by another flag drops only itself.
    expect(filterLocalExtraArgs(['--setting-sources'])).toEqual([])
    expect(filterLocalExtraArgs(['--effort', '--tools', 'X'])).toEqual(['--tools', 'X'])
    // A runner flag missing its value is dropped rather than emitted dangling.
    expect(filterLocalExtraArgs(['--mcp-config'])).toEqual([])
    const args = argsOf(undefined, 'chat-turn', { extraArgs: extra })
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).toEqual(expect.arrayContaining(['--disallowedTools', 'Write,Edit']))
  })
})

describe('local adapter parser + extractResult against the recorded runner transcript', () => {
  const lines = fs.readFileSync(path.join(__dirname, '__fixtures__', 'local-runner-transcript.jsonl'), 'utf8').trim().split('\n')
  const adapter = createLocalAdapter(conn)
  const events: AdapterEvent[] = lines.flatMap((line) => [...parseStreamEvents(adapter, line)])

  it('maps every frame to the shared AdapterEvent shape', () => {
    expect(events.map((e) => e.kind)).toEqual([
      'session-started', 'text-delta', 'tool-use', 'tool-result', 'tool-use', 'tool-result', 'text-delta', 'result',
    ])
    expect(events[0]).toEqual({ kind: 'session-started', sessionId: 'sess-local-1' })
    expect(events[2]).toMatchObject({ kind: 'tool-use', name: 'Read', toolUseId: 'toolu_1', inputPreview: '{"file_path":"/repo/README.md"}' })
    expect(events[3]).toEqual({ kind: 'tool-result', toolUseId: 'toolu_1', outputPreview: '# Project\nhello' })
    expect(events[5]).toEqual({ kind: 'tool-result', toolUseId: 'toolu_2', outputPreview: 'boom', isError: true })
    expect(events[7]).toMatchObject({ kind: 'result' })
    expect((events[7] as { isError?: boolean }).isError).toBeUndefined()
  })

  it('extractResult reads tokens from result.usage, never total_cost_usd', () => {
    const r = adapter.extractResult(events)
    expect(r).toEqual({
      tokens_in: 580, tokens_out: 49, tokens_cache_read: undefined, tokens_cache_create: undefined,
      num_turns: 3, model: 'qwen3.5-9b:latest', duration_ms: 1234, duration_api_ms: undefined, session_id: 'sess-local-1',
    })
    expect('total_cost_usd' in r).toBe(false)
    expect(r.total_cost_usd).toBeUndefined()
  })

  it('reconstructs usage per message id when the run died before its result', () => {
    const killed = events.slice(0, 7) // no `result`
    const r = extractLocalResult(killed)
    // msg_1 last snapshot (120/20) + msg_2 (200/12) + msg_3 (260/9)
    expect(r).toEqual({ tokens_in: 580, tokens_out: 41, tokens_cache_read: 0, tokens_cache_create: 0, model: 'qwen3.5-9b:latest', session_id: 'sess-local-1' })
    expect(extractLocalResult([events[0]])).toEqual({ session_id: 'sess-local-1' })
    expect(extractLocalResult([])).toEqual({ session_id: undefined })
    // A result frame WITHOUT usage still folds the assistant snapshots.
    const noUsage = [...killed, { kind: 'result', payload: { type: 'result', num_turns: 1 } } as AdapterEvent]
    expect(extractLocalResult(noUsage)).toMatchObject({ tokens_in: 580, tokens_out: 41, num_turns: 1 })
    // Anonymous usage carriers (no message id) each count once.
    const anon = [{ kind: 'text-delta', text: 'a', usage: { input_tokens: 1, output_tokens: 1 } }, { kind: 'text-delta', text: 'b', usage: { input_tokens: 2, output_tokens: 'x' } }] as unknown as AdapterEvent[]
    expect(extractLocalResult(anon)).toMatchObject({ tokens_in: 3, tokens_out: 1 })
  })

  it('parseLocalStreamLine edge cases: empty, bad JSON, missing type, error frames, notification-shaped results stay results', () => {
    expect(parseLocalStreamLine('')).toBeNull()
    expect(parseLocalStreamLine('not json')).toBeNull()
    expect(parseLocalStreamLine('{"foo":1}')).toEqual({ kind: 'other', type: '<missing>', raw: { foo: 1 } })
    expect(parseLocalStreamLine('{"type":"system","subtype":"init"}')).toMatchObject({ kind: 'other', type: 'system' })
    // An is_error result WITH text fans out to [error, result] so managers report the reason.
    expect(parseLocalStreamLine('{"type":"result","is_error":true,"result":"limit"}')).toEqual([{ kind: 'error', message: 'limit' }, { kind: 'result', payload: { type: 'result', is_error: true, result: 'limit' }, isError: true }])
    expect(parseLocalStreamLine('{"type":"result","is_error":true}')).toMatchObject({ kind: 'result', isError: true })
    // NO claude notification heuristics: an `origin` field does not demote a result.
    expect(parseLocalStreamLine('{"type":"result","origin":{"kind":"task-notification"}}')).toMatchObject({ kind: 'result' })
    expect(parseLocalStreamLine('{"type":"error","message":"boom"}')).toEqual({ kind: 'error', message: 'boom' })
    expect(parseLocalStreamLine('{"type":"error","error":"bad"}')).toEqual({ kind: 'error', message: 'bad' })
    expect(parseLocalStreamLine('{"type":"error"}')).toEqual({ kind: 'error', message: 'local runner error' })
    expect(parseLocalStreamLine('{"type":"assistant","message":{"content":[{"type":"thinking"}]}}')).toMatchObject({ kind: 'other', type: 'assistant' })
    expect(parseLocalStreamLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Grep"}],"usage":{"input_tokens":1}}}')).toMatchObject({ kind: 'tool-use', name: 'Grep', inputPreview: '{}', usage: { input_tokens: 1 } })
    expect(parseLocalStreamLine('{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}')).toMatchObject({ kind: 'other', type: 'user' })
    expect(parseLocalStreamLine('{"type":"user","message":{"content":[{"type":"tool_result","content":{"weird":1}}]}}')).toEqual({ kind: 'tool-result', outputPreview: '' })
    expect(parseLocalStreamLine('{"type":"unknown_frame"}')).toEqual({ kind: 'other', type: 'unknown_frame', raw: { type: 'unknown_frame' } })
  })
})

describe('runner script + node resolution', () => {
  let tmp: string
  const prev = process.env.SPECRAILS_BUNDLED_LOCAL_RUNNER_PATH
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runner-')) })
  afterEach(() => {
    if (prev === undefined) delete process.env.SPECRAILS_BUNDLED_LOCAL_RUNNER_PATH
    else process.env.SPECRAILS_BUNDLED_LOCAL_RUNNER_PATH = prev
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('prefers the env-provided runner path when it exists, else searches the staged layouts', () => {
    const script = path.join(tmp, 'specrails-local-runner.js')
    fs.writeFileSync(script, '// stub')
    process.env.SPECRAILS_BUNDLED_LOCAL_RUNNER_PATH = script
    expect(resolveLocalRunnerScript()).toBe(script)
    process.env.SPECRAILS_BUNDLED_LOCAL_RUNNER_PATH = path.join(tmp, 'missing.js')
    const found = resolveLocalRunnerScript()
    expect(found === null || /specrails-local-runner\.js$/.test(found)).toBe(true)
    // buildArgs stays deterministic even when nothing is built yet.
    expect(createLocalAdapter(conn).buildArgs('chat-turn', { prompt: 'x', model: 'm' })[0]).toMatch(/specrails-local-runner\.js$/)
  })

  it('finds the runner next to the packaged sidecar when no env points at it (Windows install layout)', () => {
    delete process.env.SPECRAILS_BUNDLED_LOCAL_RUNNER_PATH
    const execDir = path.join(tmp, 'app')
    fs.mkdirSync(path.join(execDir, 'binaries'), { recursive: true })
    const script = path.join(execDir, 'binaries', 'specrails-local-runner.js')
    fs.writeFileSync(script, '// stub')
    const realExecPath = process.execPath
    Object.defineProperty(process, 'execPath', { value: path.join(execDir, 'specrails-desktop.exe'), configurable: true })
    try {
      expect(resolveLocalRunnerScript()).toBe(script)
    } finally {
      Object.defineProperty(process, 'execPath', { value: realExecPath, configurable: true })
    }
  })

  it('binary is the bundled node or PATH node', () => {
    expect(['node', resolveLocalRunnerNode()]).toContain(createLocalAdapter(conn).binary)
  })
})


describe('local adapter — result errors surface as error events', () => {
  it('pairs an is_error result carrying text with an explicit error event', () => {
    const adapter = createLocalAdapter({ id: 'local-err', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const events = adapter.parseStreamLine(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, num_turns: 3, result: 'HTTP 400: context length exceeded' }))
    expect(Array.isArray(events)).toBe(true)
    const list = events as Array<{ kind: string; message?: string; isError?: boolean }>
    expect(list[0]).toEqual({ kind: 'error', message: 'HTTP 400: context length exceeded' })
    expect(list[1]).toMatchObject({ kind: 'result', isError: true })
  })
  it('keeps a successful result as a single event', () => {
    const adapter = createLocalAdapter({ id: 'local-ok', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const ev = adapter.parseStreamLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'hi' }))
    expect(Array.isArray(ev)).toBe(false)
  })
})
