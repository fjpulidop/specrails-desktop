import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'

vi.mock('tree-kill', () => ({ default: vi.fn() }))

import treeKill from 'tree-kill'
import { createFileSummaryGenerator } from './file-summary-generator'
import { getAdapter } from './providers'

function fakeChild() {
  const c = new EventEmitter() as any
  c.stdout = new Readable({ read() {} })
  c.stderr = new Readable({ read() {} })
  c.pid = 55555
  c.kill = vi.fn()
  return c
}

const INPUT = { relPath: 'a.ts', contents: 'const x = 1', language: 'en' as const }

describe('createFileSummaryGenerator', () => {
  beforeEach(() => { vi.mocked(treeKill).mockReset() })
  afterEach(() => { vi.useRealTimers() })

  it('on timeout tree-kills with SIGTERM then escalates to SIGKILL', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const gen = createFileSummaryGenerator({
      adapter: getAdapter('claude'),
      cwd: '/tmp',
      spawn: (() => child) as any,
      timeoutMs: 1000,
    })
    const settled = gen(INPUT).then(() => 'ok', (e: Error) => e.message)

    await vi.advanceTimersByTimeAsync(1000) // fire the timeout
    expect(treeKill).toHaveBeenCalledWith(55555, 'SIGTERM')
    expect(vi.mocked(treeKill).mock.calls.some((c) => c[1] === 'SIGKILL')).toBe(false)

    await vi.advanceTimersByTimeAsync(2000) // fire the SIGKILL grace
    expect(vi.mocked(treeKill).mock.calls.some((c) => c[1] === 'SIGKILL')).toBe(true)

    expect(await settled).toContain('timeout')
  })

  it('resolves with the trimmed summary on a clean exit', async () => {
    const child = fakeChild()
    const gen = createFileSummaryGenerator({
      adapter: getAdapter('claude'),
      cwd: '/tmp',
      spawn: (() => child) as any,
    })
    const p = gen(INPUT)
    child.stdout.push(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'This file declares a constant.' }] } }) + '\n',
    )
    child.stdout.push(JSON.stringify({ type: 'result', total_cost_usd: 0.0001 }) + '\n')
    child.stdout.push(null)
    await new Promise((r) => setImmediate(r))
    child.emit('close', 0)

    const out = await p
    expect(out.summary).toBe('This file declares a constant.')
    expect(out.provider).toBe('claude')
  })

  it('rejects on a non-zero exit', async () => {
    const child = fakeChild()
    const gen = createFileSummaryGenerator({
      adapter: getAdapter('claude'),
      cwd: '/tmp',
      spawn: (() => child) as any,
    })
    const p = gen(INPUT).then(() => 'ok', (e: Error) => e.message)
    child.stderr.push('boom\n')
    child.stdout.push(null)
    await new Promise((r) => setImmediate(r))
    child.emit('close', 2)
    expect(await p).toContain('exit code=2')
  })

  // ─── MED-13: failure paths must carry captured usage on the rejection ────────
  it('carries captured usage on the rejection when a non-zero exit follows billed tokens', async () => {
    const child = fakeChild()
    const gen = createFileSummaryGenerator({
      adapter: getAdapter('claude'),
      cwd: '/tmp',
      spawn: (() => child) as any,
    })
    const p = gen(INPUT).then(
      () => null,
      (e: Error & { partial?: Record<string, unknown> }) => e.partial ?? null,
    )
    // The provider streamed an assistant frame (billing tokens) then exited 1.
    child.stdout.push(
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-3-5-haiku-20241022',
          usage: { input_tokens: 40, output_tokens: 10 },
          content: [{ type: 'text', text: 'partial explanation' }],
        },
      }) + '\n',
    )
    child.stdout.push(null)
    await new Promise((r) => setImmediate(r))
    child.emit('close', 1)

    const partial = await p
    expect(partial).not.toBeNull()
    expect(partial!.provider).toBe('claude')
    expect(partial!.tokensIn).toBe(40)
    expect(partial!.tokensOut).toBe(10)
    // Haiku is priced, so the estimate is > 0 and flagged estimated.
    expect(partial!.costUsd as number).toBeGreaterThan(0)
    expect(partial!.costEstimated).toBe(true)
  })

  it('carries captured usage on the rejection when the summary text is empty', async () => {
    const child = fakeChild()
    const gen = createFileSummaryGenerator({
      adapter: getAdapter('claude'),
      cwd: '/tmp',
      spawn: (() => child) as any,
    })
    const p = gen(INPUT).then(
      () => null,
      (e: Error & { partial?: Record<string, unknown> }) => ({ message: e.message, partial: e.partial ?? null }),
    )
    // Assistant frame with usage but a tool_use block (no text) → empty summary
    // on a clean exit. The usage snapshot must still ride the rejection.
    child.stdout.push(
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-3-5-haiku-20241022',
          usage: { input_tokens: 25, output_tokens: 5 },
          content: [{ type: 'tool_use', name: 'Read', input: {} }],
        },
      }) + '\n',
    )
    child.stdout.push(null)
    await new Promise((r) => setImmediate(r))
    child.emit('close', 0)

    const res = await p
    expect(res.message).toContain('empty summary')
    expect(res.partial).not.toBeNull()
    expect((res.partial as Record<string, unknown>).tokensIn).toBe(25)
  })
})
