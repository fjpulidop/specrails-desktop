import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { runAiCliInvocation } from './spawn-lifecycle'
import type { ProviderAdapter, AdapterEvent } from './providers/types'

class FakeChild extends EventEmitter {
  stdout: Readable | null
  stderr: Readable | null
  killed = false
  constructor(stdoutLines: string[], stderrLines: string[] | null) {
    super()
    this.stdout = Readable.from(stdoutLines.map((l) => l + '\n'))
    this.stderr = stderrLines ? Readable.from(stderrLines.map((l) => l + '\n')) : null
  }
  kill(): boolean { this.killed = true; return true }
}

// Minimal adapter: each stdout line is a JSON-encoded AdapterEvent.
const fakeAdapter = {
  id: 'claude',
  binary: 'claude',
  buildArgs: (_action: string, opts: { prompt?: string }) => ['--built', opts?.prompt ?? ''],
  parseStreamLine: (line: string): AdapterEvent | null => {
    try { return JSON.parse(line) as AdapterEvent } catch { return null }
  },
} as unknown as ProviderAdapter

function fakeSpawn(
  lines: string[],
  code: number | null = 0,
  opts: { stderr?: string[]; delay?: number; throwOnSpawn?: boolean; emitError?: boolean } = {},
) {
  return ((_bin: string, _args: string[]) => {
    if (opts.throwOnSpawn) throw new Error('ENOENT')
    const c = new FakeChild(lines, opts.stderr ?? null)
    setTimeout(() => {
      if (opts.emitError) c.emit('error', new Error('boom'))
      else c.emit('close', code)
    }, opts.delay ?? 5)
    return c as unknown as ChildProcess
  }) as unknown as typeof import('./util/cli-prompt')['spawnAiCli']
}

describe('runAiCliInvocation', () => {
  it('spawns, accumulates events, captures sessionId, settles on close', async () => {
    const lines = [
      JSON.stringify({ kind: 'session-started', sessionId: 's1' }),
      JSON.stringify({ kind: 'text-delta', text: 'hi' }),
      JSON.stringify({ kind: 'result', payload: { session_id: 's2' } }),
    ]
    const onEvent = vi.fn()
    const onSpawn = vi.fn()
    const r = await runAiCliInvocation({
      adapter: fakeAdapter,
      action: 'chat-turn' as never,
      buildOpts: { prompt: 'p', model: 'm' } as never,
      cwd: '/x',
      spawn: fakeSpawn(lines, 0),
      onEvent,
      onSpawn,
    })
    expect(r.code).toBe(0)
    expect(r.spawnFailed).toBe(false)
    expect(r.timedOut).toBe(false)
    expect(r.events).toHaveLength(3)
    expect(r.sessionId).toBe('s2') // result.session_id wins over session-started
    expect(r.lastResultEvent?.kind).toBe('result')
    expect(onEvent).toHaveBeenCalledTimes(3)
    expect(onSpawn).toHaveBeenCalledTimes(1)
  })

  it('uses hand-rolled argv when provided (no buildArgs)', async () => {
    const spy = vi.fn(fakeSpawn([], 0))
    await runAiCliInvocation({ adapter: fakeAdapter, argv: ['--x'], cwd: '/x', spawn: spy as never })
    expect(spy).toHaveBeenCalledWith('claude', ['--x'], expect.objectContaining({ cwd: '/x' }))
  })

  it('flattens every event emitted from one provider stream line', async () => {
    const batchAdapter = {
      ...fakeAdapter,
      parseStreamLine: () => [
        { kind: 'text-delta', text: 'mixed' },
        { kind: 'tool-use', name: 'ReadFile', inputPreview: '{}' },
      ] satisfies AdapterEvent[],
    } as unknown as ProviderAdapter
    const onEvent = vi.fn()
    const result = await runAiCliInvocation({
      adapter: batchAdapter,
      argv: ['--x'],
      cwd: '/x',
      spawn: fakeSpawn(['one-line'], 0),
      onEvent,
    })
    expect(result.events).toEqual([
      { kind: 'text-delta', text: 'mixed' },
      { kind: 'tool-use', name: 'ReadFile', inputPreview: '{}' },
    ])
    expect(onEvent).toHaveBeenCalledTimes(2)
  })

  it('applies provider-scoped env overrides without mutating the supplied env', async () => {
    const envAdapter = {
      ...fakeAdapter,
      buildEnv: () => ({
        KIMI_MODEL_THINKING_EFFORT: undefined,
        PROVIDER_SCOPED: 'yes',
      }),
    } as unknown as ProviderAdapter
    const baseEnv = { PATH: '/bin', KIMI_MODEL_THINKING_EFFORT: 'stale' }
    const spy = vi.fn(fakeSpawn([], 0))
    await runAiCliInvocation({
      adapter: envAdapter,
      action: 'chat-turn',
      buildOpts: { prompt: 'p', model: 'm' },
      cwd: '/x',
      env: baseEnv,
      spawn: spy as never,
    })
    expect(spy).toHaveBeenCalledWith(
      'claude',
      ['--built', 'p'],
      expect.objectContaining({
        env: { PATH: '/bin', PROVIDER_SCOPED: 'yes' },
      }),
    )
    expect(baseEnv).toEqual({ PATH: '/bin', KIMI_MODEL_THINKING_EFFORT: 'stale' })
  })

  it('reports spawnFailed when the spawn throws (ENOENT)', async () => {
    const onSpawnError = vi.fn()
    const r = await runAiCliInvocation({
      adapter: fakeAdapter, argv: ['x'], cwd: '/x',
      spawn: fakeSpawn([], 0, { throwOnSpawn: true }), onSpawnError,
    })
    expect(r.spawnFailed).toBe(true)
    expect(r.code).toBeNull()
    expect(r.child).toBeNull()
    expect(onSpawnError).toHaveBeenCalled()
  })

  it('reports spawnFailed on a child error event', async () => {
    const onSpawnError = vi.fn()
    const r = await runAiCliInvocation({
      adapter: fakeAdapter, argv: ['x'], cwd: '/x',
      spawn: fakeSpawn([], 0, { emitError: true }), onSpawnError,
    })
    expect(r.spawnFailed).toBe(true)
    expect(onSpawnError).toHaveBeenCalled()
  })

  it('drains stderr into stderrTail when no onStderrLine hook', async () => {
    const r = await runAiCliInvocation({
      adapter: fakeAdapter, argv: ['x'], cwd: '/x',
      spawn: fakeSpawn([], 0, { stderr: ['err one', 'err two'] }),
    })
    expect(r.stderrTail).toContain('err one')
  })

  it('routes stderr line-by-line to onStderrLine when provided', async () => {
    const onStderrLine = vi.fn()
    const r = await runAiCliInvocation({
      adapter: fakeAdapter, argv: ['x'], cwd: '/x',
      spawn: fakeSpawn([], 0, { stderr: ['line A', 'line B'] }), onStderrLine,
    })
    expect(onStderrLine).toHaveBeenCalledWith('line A')
    expect(onStderrLine).toHaveBeenCalledWith('line B')
    expect(r.stderrTail).toBe('') // not drained when onStderrLine is set
  })

  it('passes raw stdout lines to onStdoutLine before adapter parse', async () => {
    const onStdoutLine = vi.fn()
    await runAiCliInvocation({
      adapter: fakeAdapter, argv: ['x'], cwd: '/x',
      spawn: fakeSpawn(['{"kind":"text-delta","text":"z"}'], 0), onStdoutLine,
    })
    expect(onStdoutLine).toHaveBeenCalledWith('{"kind":"text-delta","text":"z"}')
  })

  it('times out and settles timedOut=true, killing the child once', async () => {
    const onTimeout = vi.fn()
    const r = await runAiCliInvocation({
      adapter: fakeAdapter, argv: ['x'], cwd: '/x', timeoutMs: 20, onTimeout,
      spawn: fakeSpawn([], 0, { delay: 100000 }), // never closes on its own
    })
    expect(r.timedOut).toBe(true)
    expect(r.code).toBeNull()
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })
})
