import { describe, expect, it, vi } from 'vitest'
import { createAsyncMemo } from './async-memo'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('createAsyncMemo', () => {
  it('shares one in-flight load between concurrent callers', async () => {
    const memo = createAsyncMemo<string, number>({ ttlMs: 1000 })
    const gate = deferred<number>()
    const load = vi.fn(() => gate.promise)
    const a = memo.get('k', load), b = memo.get('k', load)
    gate.resolve(7)
    expect(await Promise.all([a, b])).toEqual([7, 7])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reuses a settled value until the TTL expires', async () => {
    let now = 0
    const memo = createAsyncMemo<string, number>({ ttlMs: 100, now: () => now })
    const load = vi.fn(async () => now)
    expect(await memo.get('k', load)).toBe(0)
    now = 99
    expect(await memo.get('k', load)).toBe(0)
    now = 100
    expect(await memo.get('k', load)).toBe(100)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps keys isolated (one project/run never reads another)', async () => {
    const memo = createAsyncMemo<string, string>({ ttlMs: 1000 })
    expect(await memo.get('project-a', async () => 'a')).toBe('a')
    expect(await memo.get('project-b', async () => 'b')).toBe('b')
    expect(await memo.get('project-a', async () => 'other')).toBe('a')
  })

  it('never caches a rejection', async () => {
    const memo = createAsyncMemo<string, number>({ ttlMs: 1000 })
    await expect(memo.get('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await memo.get('k', async () => 2)).toBe(2)
  })

  it('invalidation drops the value and discards a load that started before it', async () => {
    const memo = createAsyncMemo<string, number>({ ttlMs: 1000 })
    expect(await memo.get('k', async () => 1)).toBe(1)
    memo.invalidate('k')
    const gate = deferred<number>()
    const stale = memo.get('k', () => gate.promise)
    memo.invalidate('k')
    // A caller after the invalidation does not join the stale load.
    const fresh = memo.get('k', async () => 3)
    gate.resolve(2)
    expect(await stale).toBe(2)
    expect(await fresh).toBe(3)
    expect(await memo.get('k', async () => 4)).toBe(3)
  })

  it('invalidate() without a key clears every entry', async () => {
    const memo = createAsyncMemo<string, number>({ ttlMs: 1000 })
    await memo.get('a', async () => 1)
    await memo.get('b', async () => 1)
    memo.invalidate()
    expect(memo.size()).toBe(0)
    expect(await memo.get('a', async () => 2)).toBe(2)
  })

  it('bounds the number of settled entries', async () => {
    const memo = createAsyncMemo<number, number>({ ttlMs: 1000, maxEntries: 2 })
    for (const key of [1, 2, 3]) await memo.get(key, async () => key)
    expect(memo.size()).toBe(2)
  })
})
