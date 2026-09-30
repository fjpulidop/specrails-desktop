import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { it, expect, vi, afterEach } from 'vitest'
import { createCodexReader } from './codex'
function fake(reply: (frame: { id: number; method: string; params?: unknown }, child: EventEmitter & { stdout: PassThrough }) => void) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null })
  const frames: { id: number; method: string; params?: unknown }[] = []
  child.stdin.on('data', chunk => { const frame = JSON.parse(chunk.toString()); frames.push(frame); queueMicrotask(() => reply(frame, child)) })
  return { child: child as unknown as ChildProcess, frames }
}
function respond(child: { stdout: PassThrough }, id: number, result: unknown) { child.stdout.write(JSON.stringify({ id, result }) + '\n') }
afterEach(() => vi.useRealTimers())
it('reads account and all limit groups without starting a turn, then cleans up', async () => {
  const f = fake((frame, child) => {
    if (frame.method === 'initialize') respond(child, frame.id, {})
    if (frame.method === 'account/read') respond(child, frame.id, { account: { type: 'chatgpt', planType: 'plus', email: 'private@example.test' } })
    if (frame.method === 'account/rateLimits/read') {
      const payload = JSON.stringify({ id: frame.id, result: { rateLimits: { secondary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: null } }, accountId: 'private-id' } }) + '\n'
      child.stdout.write(payload.slice(0, 20)); child.stdout.write(payload.slice(20))
    }
  })
  const stop = vi.fn().mockResolvedValue(undefined)
  const reader = createCodexReader({ spawn: () => f.child, stop })
  const result = await reader.read(new AbortController().signal)
  expect(result).toMatchObject({ plan: 'plus', windows: [expect.objectContaining({ usedPercent: 23 })] })
  expect(result.identity).not.toContain('private')
  expect(f.frames.map(f => f.method)).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read'])
  expect(f.frames.find(f => f.method === 'account/read')?.params).toEqual({ refreshToken: false })
  expect(stop).toHaveBeenCalledTimes(1); expect(f.child.listenerCount('close')).toBe(0)
})
it('signed-out accounts do not request limits', async () => {
  const f = fake((frame, child) => respond(child, frame.id, frame.method === 'account/read' ? { account: null } : {}))
  const reader = createCodexReader({ spawn: () => f.child, stop: vi.fn().mockResolvedValue(undefined) })
  expect((await reader.read(new AbortController().signal)).availability).toBe('signed-out')
  expect(f.frames.map(f => f.method)).not.toContain('account/rateLimits/read')
})
it('unsupported RPC methods produce a safe unsupported-cli outcome', async () => {
  const f = fake((frame, child) => { if (frame.id) child.stdout.write(JSON.stringify({ id: frame.id, error: { code: -32601, message: 'private auth details' } }) + '\n') })
  const reader = createCodexReader({ spawn: () => f.child, stop: vi.fn().mockResolvedValue(undefined) })
  await expect(reader.read(new AbortController().signal)).rejects.toMatchObject({ code: 'unsupported-cli', message: 'unsupported-cli' })
})
it('timeout and abort both stop only the owned process', async () => {
  vi.useFakeTimers()
  const f = fake(() => {}), stop = vi.fn().mockResolvedValue(undefined)
  const reader = createCodexReader({ spawn: () => f.child, stop, timeoutMs: 50 })
  const pending = reader.read(new AbortController().signal)
  const assertion = expect(pending).rejects.toMatchObject({ code: 'probe-timeout' })
  await vi.advanceTimersByTimeAsync(50); await assertion
  const controller = new AbortController(), aborted = reader.read(controller.signal)
  const second = expect(aborted).rejects.toMatchObject({ code: 'aborted' }); controller.abort(); await second
  expect(stop).toHaveBeenCalledTimes(2)
})
