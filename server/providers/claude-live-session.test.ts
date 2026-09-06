import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { runClaudeLiveSession } from './claude-live-session'
import { claudeAdapter } from './claude-adapter'
import { LiveInputDeliveryError, type LiveInputSink, type LiveSessionHooks } from './live-session-types'
import type { AdapterEvent } from './types'
import type { spawnAiCli } from '../util/cli-prompt'

vi.mock('tree-kill', () => ({ default: vi.fn() }))

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const reply = (text = 'Done.') => ({ type: 'assistant', message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text }] } })
const result = (more: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-session', result: 'Done.', ...more })

describe('Claude native live input transport', () => {
  const children: ChildProcess[] = []
  let directories: string[]

  beforeEach(() => { directories = [] })
  afterEach(() => {
    for (const child of children.splice(0)) child.emit('close', 0)
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function fixture(overrides: Partial<LiveSessionHooks> = {}, ignoreEof = false) {
    const lines: string[] = []
    const stdout = new Readable({ read() {} }), stderr = new Readable({ read() {} })
    const process = new EventEmitter() as ChildProcess
    const stdin = new Writable({
      write(chunk, _encoding, callback) { lines.push(chunk.toString()); callback() },
      final(callback) { callback(); if (!ignoreEof) setImmediate(() => process.emit('close', 0)) },
    })
    Object.assign(process, { stdout, stderr, stdin, killed: false,
      kill: vi.fn(() => { Object.assign(process, { killed: true }); return true }),
    })
    children.push(process)
    const spawn = vi.fn(() => process)
    let sink: LiveInputSink | undefined
    const events: AdapterEvent[] = []
    const hooks: LiveSessionHooks = {
      adapter: claudeAdapter, action: 'chat-turn', cwd: '/tmp/specrails-claude-live-test',
      buildOpts: { prompt: 'Initial request.', model: 'sonnet', systemPrompt: 'System\npolicy', reasoning_effort: 'high', extraArgs: ['--mcp-config', '/tmp/mcp.json'] },
      env: { PATH: '/test/bin', SPECRAILS_TEST: 'present' },
      spawn: spawn as unknown as typeof spawnAiCli,
      onSpawn: vi.fn(), onEvent: event => events.push(event), onInputReady: value => { sink = value },
      ...overrides,
    }
    const run = runClaudeLiveSession(hooks)
    return {
      child: process, stdout, stderr, stdin, spawn, hooks, run, events,
      frames: () => lines.map(line => JSON.parse(line)),
      push: (...frames: unknown[]) => stdout.push(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n'),
      ready: async () => { await vi.waitFor(() => expect(sink).toBeDefined()); return sink! },
      echo: (frame: Record<string, unknown>, more: Record<string, unknown> = {}) => stdout.push(JSON.stringify({ ...frame, isReplay: true, ...more }) + '\n'),
    }
  }

  it('confirms initial input only on its matching native replay, once and before subsequent output', async () => {
    const order: string[] = [], accepted = vi.fn(() => order.push('received'))
    const f = fixture({ onInitialInputAccepted: accepted, onEvent: event => { if (event.kind === 'text-delta') order.push(event.text) } })
    const sink = await f.ready(), initial = f.frames()[0]
    expect(sink.acceptedReceipt).toBe('received')
    expect(accepted).not.toHaveBeenCalled()
    f.push(
      initial,
      { ...initial, isReplay: true, uuid: 'another-input' },
      { ...initial, isReplay: true, parent_tool_use_id: 'a-tool' },
      { ...initial, isReplay: true, message: { role: 'assistant', content: 'Not a user echo.' } },
    )
    await tick()
    expect(accepted).not.toHaveBeenCalled()
    f.push({ ...initial, isReplay: true }, reply('Processing.'))
    await tick()
    expect(order).toEqual(['received', 'Processing.'])
    f.echo(initial)
    f.push(result())
    await f.run
    expect(accepted).toHaveBeenCalledOnce()
  })

  it('does not confirm initial input when the process ends after writing but before native replay', async () => {
    const accepted = vi.fn(), f = fixture({ onInitialInputAccepted: accepted })
    await f.ready()
    f.child.emit('close', 1)
    await f.run
    expect(accepted).not.toHaveBeenCalled()
  })

  it('preserves model, effort, permissions, MCP, cwd and env while sending the initial prompt over open stdin', async () => {
    const f = fixture()
    await f.ready()
    expect(f.spawn).toHaveBeenCalledOnce()
    const [binary, args, options] = f.spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
    expect(binary).toBe('claude')
    expect(args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--effort', 'high', '--dangerously-skip-permissions', '--mcp-config', '/tmp/mcp.json', '--input-format', 'stream-json', '--replay-user-messages']))
    expect(args).not.toContain('Initial request.')
    expect(options).toMatchObject({ cwd: '/tmp/specrails-claude-live-test', env: { SPECRAILS_TEST: 'present' }, stdio: ['pipe', 'pipe', 'pipe'] })
    expect(f.frames()).toMatchObject([{ type: 'user', uuid: expect.any(String), priority: 'next', message: { role: 'user', content: 'Initial request.' } }])
    expect(f.stdin.writableEnded).toBe(false)
    f.push(reply(), result())
    expect(await f.run).toMatchObject({ code: 0, timedOut: false, spawnFailed: false, sessionId: 'native-session' })
  })

  it('accepts updates while native tools run, preserves tool results, and checkpoints on matching replay before the next text in the same chunk', async () => {
    const order: string[] = []
    const f = fixture({ onEvent: event => { if (event.kind === 'text-delta') order.push(event.text); if (event.kind === 'tool-result') order.push(event.outputPreview) } })
    const sink = await f.ready()
    f.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'native-bash', name: 'Bash', input: { command: 'run existing build' } }] } })
    const accepted = vi.fn(() => order.push('user checkpoint'))
    const send = sink.send({ id: 'update', text: 'Now focus on the tests.' }, accepted)
    await tick()
    expect(f.frames()).toHaveLength(2)
    expect(accepted).not.toHaveBeenCalled()
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.frames().some(frame => frame.type === 'control_request')).toBe(false)
    const frame = f.frames()[1]
    f.push(
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'native-bash', content: 'Build completed.' }] } },
      { ...frame, isReplay: true },
      reply('Tests inspected.'),
      result(),
    )
    expect(await send).toBe(true)
    await f.run
    expect(order).toEqual(['Build completed.', 'user checkpoint', 'Tests inspected.'])
    expect(accepted).toHaveBeenCalledOnce()
    expect(f.spawn).toHaveBeenCalledOnce()
  })

  it('does not acknowledge buffered writes, unrelated echoes, subagent echoes or ordinary tool-result frames', async () => {
    const f = fixture(), sink = await f.ready(), accepted = vi.fn()
    const send = sink.send({ id: 'update', text: 'Correction.' }, accepted)
    await tick()
    const frame = f.frames()[1]
    f.push({ ...frame, isReplay: false }, { ...frame, isReplay: true, uuid: 'foreign-uuid' }, { ...frame, isReplay: true, parent_tool_use_id: 'child-tool' })
    await tick()
    expect(accepted).not.toHaveBeenCalled()
    f.echo(frame)
    expect(await send).toBe(true)
    f.push(result())
    await f.run
  })

  it('waits through a native result when a written update has not yet been absorbed', async () => {
    const f = fixture(), sink = await f.ready()
    const send = sink.send({ id: 'update', text: 'Late next step.' })
    await tick()
    f.push(result({ result: 'Initial native turn complete.', total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 20 }, num_turns: 1 }))
    await tick()
    expect(f.stdin.writableEnded).toBe(false)
    f.echo(f.frames()[1])
    expect(await send).toBe(true)
    expect(f.stdin.writableEnded).toBe(false)
    // Claude's resident stream reports cumulative process totals, as used by
    // InteractiveJobSession. The last result must stay intact, never be added
    // to the earlier total again or replaced by its per-turn difference.
    f.push(reply('Late next step finished.'), result({ result: 'Final native turn complete.', total_cost_usd: 0.31, usage: { input_tokens: 30, output_tokens: 50 }, num_turns: 2 }))
    const outcome = await f.run
    expect(outcome.events.filter(event => event.kind === 'result')).toHaveLength(2)
    expect(outcome.lastResultEvent).toMatchObject({ kind: 'result', payload: { result: 'Final native turn complete.' } })
    expect(claudeAdapter.extractResult(outcome.events)).toMatchObject({ total_cost_usd: 0.31, tokens_in: 30, tokens_out: 50, num_turns: 2 })
    expect(f.spawn).toHaveBeenCalledOnce()
    expect(await sink.send({ id: 'after-close', text: 'Next request.' })).toBe(false)
    expect(f.frames()).toHaveLength(2)
  })

  it('ignores internal notification results while waiting for the real request', async () => {
    const f = fixture()
    await f.ready()
    f.push(result({ origin: { kind: 'task-notification' }, num_turns: 0, result: '' }))
    await tick()
    expect(f.stdin.writableEnded).toBe(false)
    f.push(reply(), result())
    expect((await f.run).events.filter(event => event.kind === 'result')).toHaveLength(1)
  })

  it('deduplicates sends with the same ID and rejects conflicting content without another write', async () => {
    const f = fixture(), sink = await f.ready(), accepted = vi.fn()
    const original = sink.send({ id: 'stable', text: 'Correction.' }, accepted)
    const repeated = sink.send({ id: 'stable', text: 'Correction.' }, accepted)
    expect(repeated).toBe(original)
    await tick()
    await expect(sink.send({ id: 'stable', text: 'Different.' })).rejects.toMatchObject({ ambiguous: true })
    f.echo(f.frames()[1])
    expect(await original).toBe(true)
    expect(await sink.send({ id: 'stable', text: 'Correction.' }, accepted)).toBe(true)
    expect(accepted).toHaveBeenCalledOnce()
    expect(f.frames()).toHaveLength(2)
    f.push(result())
    await f.run
  })

  it('marks a close after write but before echo as ambiguous rather than safely retryable', async () => {
    const f = fixture(), sink = await f.ready()
    const send = sink.send({ id: 'uncertain', text: 'May have been read.' })
    const rejected = expect(send).rejects.toMatchObject({ name: 'LiveInputDeliveryError', ambiguous: true })
    await tick()
    f.child.emit('close', 1)
    await rejected
    expect(await f.run).toMatchObject({ code: 1 })
    expect(await sink.send({ id: 'new', text: 'Not written.' })).toBe(false)
  })

  it('keeps an accepted-but-unpersisted callback failure ambiguous and cannot replay it', async () => {
    const f = fixture(), sink = await f.ready()
    const send = sink.send({ id: 'accepted', text: 'Already delivered.' }, () => { throw new Error('DB unavailable') })
    const rejected = expect(send).rejects.toMatchObject({ ambiguous: true, message: expect.stringContaining('local acknowledgement failed') })
    await tick()
    f.echo(f.frames()[1])
    await rejected
    await expect(sink.send({ id: 'accepted', text: 'Already delivered.' })).rejects.toBeInstanceOf(LiveInputDeliveryError)
    expect(f.frames()).toHaveLength(2)
    f.push(result())
    await f.run
  })

  it('sends bounded image content natively and preserves the text with explicit notes for inaccessible or oversized images', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'claude-live-input-test-')); directories.push(directory)
    const file = path.join(directory, 'image.png'), bytes = Buffer.from('native image bytes')
    writeFileSync(file, bytes)
    const f = fixture(), sink = await f.ready()
    const send = sink.send({ id: 'image', text: 'Inspect this.', imagePaths: [file] })
    await vi.waitFor(() => expect(f.frames()).toHaveLength(2))
    expect(f.frames()[1].message.content).toEqual([
      { type: 'text', text: 'Inspect this.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } },
    ])
    f.echo(f.frames()[1]); expect(await send).toBe(true)
    const large = path.join(directory, 'large.png'); writeFileSync(large, Buffer.alloc(8 * 1024 * 1024 + 1))
    const missing = sink.send({ id: 'missing', text: 'Keep this request.', imagePaths: [path.join(directory, 'missing.png'), large] })
    await vi.waitFor(() => expect(f.frames()).toHaveLength(3))
    expect(f.frames()[2].message.content[0]).toEqual({ type: 'text', text: 'Keep this request.' })
    expect(f.frames()[2].message.content[1].text).toContain('was not delivered')
    expect(f.frames()[2].message.content[2].text).toContain('8 MiB')
    expect(f.frames()[2].message.content.filter((block: { type: string }) => block.type === 'image')).toEqual([])
    f.echo(f.frames()[2]); expect(await missing).toBe(true)
    f.push(result()); await f.run
  })

  it('preserves resume and writes Windows system prompts to a private file, leaving JSON stdin open', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const f = fixture({ buildOpts: { prompt: 'Initial\nmessage.', model: 'sonnet', systemPrompt: 'Policy\nwith Unicode ñ', sessionId: 'resume-session' } })
    await f.ready()
    const args = (f.spawn.mock.calls[0] as unknown as [string, string[]])[1]
    expect(args).toEqual(expect.arrayContaining(['--resume', 'resume-session', '--system-prompt-file']))
    expect(args).not.toContain('--system-prompt')
    const file = args[args.indexOf('--system-prompt-file') + 1]
    expect(readFileSync(file, 'utf8')).toBe('Policy\nwith Unicode ñ')
    expect(f.stdin.writableEnded).toBe(false)
    expect(f.frames()[0].message.content).toBe('Initial\nmessage.')
    f.push(result()); await f.run
    expect(existsSync(file)).toBe(false)
  })

  it('preserves input order when image preparation overlaps a later text-only update', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'claude-live-order-test-')); directories.push(directory)
    const file = path.join(directory, 'first.png'); writeFileSync(file, 'first image')
    const f = fixture(), sink = await f.ready()
    const first = sink.send({ id: 'first', text: 'First update.', imagePaths: [file] })
    const second = sink.send({ id: 'second', text: 'Second update.' })
    await vi.waitFor(() => expect(f.frames()).toHaveLength(3))
    expect(f.frames()[1].message.content[0].text).toBe('First update.')
    expect(f.frames()[2].message.content).toBe('Second update.')
    f.echo(f.frames()[1]); f.echo(f.frames()[2])
    expect(await Promise.all([first, second])).toEqual([true, true])
    f.push(result()); await f.run
  })

  it('contains EPIPE, rejects unacknowledged input as uncertain and releases the invocation', async () => {
    const f = fixture(), sink = await f.ready()
    const send = sink.send({ id: 'update', text: 'Unconfirmed.' })
    const rejected = expect(send).rejects.toMatchObject({ ambiguous: true })
    await tick()
    f.stdin.emit('error', new Error('EPIPE'))
    await rejected
    expect(await f.run).toMatchObject({ code: null, spawnFailed: false })
    expect(f.events).toContainEqual({ kind: 'error', message: 'Claude stdin failed: EPIPE' })
    expect(f.stdin.destroyed).toBe(true)
    expect(f.stdout.destroyed).toBe(true)
    expect(f.stderr.destroyed).toBe(true)
  })

  it('reaps a resident process that ignores EOF after its result, with SIGKILL fallback and pipe cleanup', async () => {
    const f = fixture({}, true)
    await f.ready()
    vi.useFakeTimers()
    f.push(reply(), result())
    await vi.advanceTimersByTimeAsync(2001)
    expect(await f.run).toMatchObject({ code: 0, timedOut: false })
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(f.stdout.destroyed).toBe(true)
    await vi.advanceTimersByTimeAsync(2001)
    expect(f.child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('retains an initial request when its image disappears before launch input is prepared', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'claude-live-missing-test-')); directories.push(directory)
    const f = fixture({ buildOpts: { prompt: 'Do not lose this request.', model: 'sonnet', imagePaths: [path.join(directory, 'missing.png')] } })
    await f.ready()
    expect(f.frames()[0].message.content[0]).toEqual({ type: 'text', text: 'Do not lose this request.' })
    expect(f.frames()[0].message.content[1].text).toContain('Do not infer its contents.')
    f.push(reply(), result()); expect(await f.run).toMatchObject({ code: 0 })
  })

  it('surfaces provider error results even when the CLI exits zero, settling waiting input as uncertain', async () => {
    const f = fixture(), sink = await f.ready()
    const send = sink.send({ id: 'update', text: 'Pending.' })
    const rejected = expect(send).rejects.toMatchObject({ ambiguous: true })
    await tick()
    f.push(result({ is_error: true, subtype: 'error_during_execution', errors: ['Provider limit reached.'], result: '' }))
    await rejected
    expect((await f.run).events).toContainEqual({ kind: 'error', message: 'Provider limit reached.' })
  })

  it('settles spawn failure and inactivity without leaving pending acknowledgement promises', async () => {
    const fail = vi.fn(() => { throw new Error('ENOENT') })
    expect(await runClaudeLiveSession({ adapter: claudeAdapter, cwd: '/tmp', buildOpts: { prompt: 'Hello.', model: 'sonnet' }, spawn: fail as unknown as typeof spawnAiCli })).toMatchObject({ spawnFailed: true, child: null })
    const f = fixture({ inactivityTimeoutMs: 1000 })
    const sink = await f.ready()
    vi.useFakeTimers()
    const send = sink.send({ id: 'pending', text: 'Pending input.' })
    const rejected = expect(send).rejects.toMatchObject({ ambiguous: true })
    await Promise.resolve()
    // Output resets inactivity using the fake clock after it is enabled.
    f.push({ type: 'system', subtype: 'init', session_id: 'native-session' })
    await vi.advanceTimersByTimeAsync(1001)
    await rejected
    expect(await f.run).toMatchObject({ timedOut: true })
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
