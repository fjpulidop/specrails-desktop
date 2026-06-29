import { describe, it, expect, afterEach } from 'vitest'
import { withRepoLock, __resetRepoLocks } from './repo-lock'

afterEach(() => __resetRepoLocks())

const defer = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

/** Flush pending microtasks (the lock chains through `.catch().then()`). */
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('withRepoLock', () => {
  it('serialises calls on the same key (never overlapping)', async () => {
    let active = 0
    let maxActive = 0
    const order: number[] = []
    const task = (n: number, gate: Promise<void>) => async () => {
      active++; maxActive = Math.max(maxActive, active)
      order.push(n)
      await gate
      active--
    }
    const g1 = defer(); const g2 = defer()
    const p1 = withRepoLock('repo', task(1, g1.promise))
    const p2 = withRepoLock('repo', task(2, g2.promise))
    // Let the lock chains run: only task 1 should have started.
    await flush()
    expect(order).toEqual([1])
    g1.resolve(); await p1
    g2.resolve(); await p2
    expect(maxActive).toBe(1)       // never two at once
    expect(order).toEqual([1, 2])   // ran in submission order
  })

  it('runs different keys in parallel', async () => {
    let active = 0; let maxActive = 0
    const g = defer()
    const task = async () => { active++; maxActive = Math.max(maxActive, active); await g.promise; active-- }
    const a = withRepoLock('A', task)
    const b = withRepoLock('B', task)
    await flush()
    expect(maxActive).toBe(2)       // both ran concurrently
    g.resolve(); await Promise.all([a, b])
  })

  it('returns fn result and a rejection does not poison the next call', async () => {
    await expect(withRepoLock('k', async () => 42)).resolves.toBe(42)
    await expect(withRepoLock('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(withRepoLock('k', async () => 'ok')).resolves.toBe('ok')
  })
})
