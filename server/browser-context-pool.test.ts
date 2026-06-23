import { describe, it, expect, vi } from 'vitest'
import { SharedBrowserContextPool } from './browser-context-pool'
import type { BrowserContextHandle, BrowserPageHandle, ContextLauncher } from './browser-capture-types'

class FakeContext implements BrowserContextHandle {
  closed = false
  newPageCalls = 0
  async newPage(): Promise<BrowserPageHandle> {
    this.newPageCalls++
    return {} as BrowserPageHandle
  }
  async close() { this.closed = true }
}

describe('SharedBrowserContextPool', () => {
  it('launches exactly once and returns the same shared context', async () => {
    const ctx = new FakeContext()
    const launcher: ContextLauncher = vi.fn(async () => ctx)
    const pool = new SharedBrowserContextPool({ launcher, profileDir: '/tmp/global-profile' })

    const a = await pool.acquire()
    const b = await pool.acquire()
    expect(a).toBe(ctx)
    expect(b).toBe(ctx)
    expect(launcher).toHaveBeenCalledTimes(1)
  })

  it('passes the GLOBAL profile dir to the launcher', async () => {
    const ctx = new FakeContext()
    const launcher = vi.fn(async () => ctx) as unknown as ContextLauncher
    const pool = new SharedBrowserContextPool({ launcher, profileDir: '/tmp/global-profile' })
    await pool.acquire()
    expect((launcher as unknown as { mock: { calls: Array<[{ userDataDir: string }]> } }).mock.calls[0][0].userDataDir).toBe('/tmp/global-profile')
  })

  it('defaults the profile dir to ~/.specrails/browser-profile (global, not per-project)', () => {
    const pool = new SharedBrowserContextPool({ launcher: vi.fn() as unknown as ContextLauncher, homeDir: '/home/u' })
    expect(pool.profileDir).toBe('/home/u/.specrails/browser-profile')
  })

  it('concurrent acquires share a single in-flight launch', async () => {
    const ctx = new FakeContext()
    const launcher: ContextLauncher = vi.fn(async () => ctx)
    const pool = new SharedBrowserContextPool({ launcher })
    const [a, b, c] = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()])
    expect(a).toBe(ctx)
    expect(b).toBe(ctx)
    expect(c).toBe(ctx)
    expect(launcher).toHaveBeenCalledTimes(1)
  })

  it('dispose closes the shared context', async () => {
    const ctx = new FakeContext()
    const pool = new SharedBrowserContextPool({ launcher: vi.fn(async () => ctx) })
    await pool.acquire()
    await pool.dispose()
    expect(ctx.closed).toBe(true)
  })

  it('dispose resolves an in-flight launch before closing (no leaked browser)', async () => {
    const ctx = new FakeContext()
    let resolveLaunch!: (c: BrowserContextHandle) => void
    const launcher: ContextLauncher = vi.fn(() => new Promise<BrowserContextHandle>((r) => { resolveLaunch = r }))
    const pool = new SharedBrowserContextPool({ launcher })
    const acquiring = pool.acquire()
    const disposing = pool.dispose()
    resolveLaunch(ctx)
    await Promise.allSettled([acquiring, disposing])
    expect(ctx.closed).toBe(true)
  })

  it('acquire after dispose throws', async () => {
    const pool = new SharedBrowserContextPool({ launcher: vi.fn(async () => new FakeContext()) })
    await pool.dispose()
    await expect(pool.acquire()).rejects.toThrow(/disposed/)
  })

  it('a failed launch is retryable (promise cleared)', async () => {
    const ctx = new FakeContext()
    const launcher = vi.fn()
      .mockRejectedValueOnce(new Error('chromium boom'))
      .mockResolvedValueOnce(ctx) as unknown as ContextLauncher
    const pool = new SharedBrowserContextPool({ launcher })
    await expect(pool.acquire()).rejects.toThrow(/failed to launch shared browser/)
    const second = await pool.acquire()
    expect(second).toBe(ctx)
  })
})
