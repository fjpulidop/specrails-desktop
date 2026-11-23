import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeStatusCache, runtimeStatusFingerprint } from './agent-runtime-status-cache'

type State = { status: string }
const settled = (state: State) => state.status !== 'running'
const fp = (key: string, kind: 'legacy' | 'v2' = 'v2') => ({ kind, key })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function runDir(runId: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-cache-'))
  dirs.push(root)
  const directory = path.join(root, runId)
  fs.mkdirSync(path.join(directory, 'agent-workflow', runId), { recursive: true })
  return path.join(directory, 'desktop-context.json')
}

describe('RuntimeStatusCache', () => {
  it('reuses a settled v2 status while the fingerprint is unchanged', async () => {
    const cache = new RuntimeStatusCache<State>()
    const load = vi.fn(async () => ({ status: 'failed' }))
    await cache.read('r1', fp('a'), settled, load)
    const second = await cache.read('r1', fp('a'), settled, load)
    expect(second).toEqual({ state: { status: 'failed' }, cached: true })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('re-reads when the workflow store changes', async () => {
    const cache = new RuntimeStatusCache<State>()
    const load = vi.fn(async () => ({ status: 'failed' }))
    await cache.read('r1', fp('a'), settled, load)
    await cache.read('r1', fp('b'), settled, load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('never serves a live v2 run from the cache', async () => {
    const cache = new RuntimeStatusCache<State>()
    const load = vi.fn(async () => ({ status: 'running' }))
    await cache.read('r1', fp('a'), settled, load)
    await cache.read('r1', fp('a'), settled, load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('re-checks settlement at read time (a resumed run stops hitting the cache)', async () => {
    const cache = new RuntimeStatusCache<State>()
    let resumed = false
    const check = (state: State) => settled(state) && !resumed
    const load = vi.fn(async () => ({ status: 'blocked' }))
    await cache.read('r1', fp('a'), check, load)
    resumed = true
    await cache.read('r1', fp('a'), check, load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('expires settled v2 entries after the TTL; legacy checkpoint hashes do not expire', async () => {
    let now = 0
    const cache = new RuntimeStatusCache<State>({ settledTtlMs: 1000, now: () => now })
    const load = vi.fn(async () => ({ status: 'running' }))
    const v2 = vi.fn(async () => ({ status: 'failed' }))
    await cache.read('legacy', fp('h', 'legacy'), settled, load)
    await cache.read('v2', fp('a'), settled, v2)
    now = 1000
    expect((await cache.read('legacy', fp('h', 'legacy'), settled, load)).cached).toBe(true)
    expect((await cache.read('v2', fp('a'), settled, v2)).cached).toBe(false)
  })

  it('does not cache without a fingerprint', async () => {
    const cache = new RuntimeStatusCache<State>()
    const load = vi.fn(async () => ({ status: 'failed' }))
    await cache.read('r1', null, settled, load)
    await cache.read('r1', null, settled, load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('shares one Core read between concurrent requests for the same run', async () => {
    const cache = new RuntimeStatusCache<State>()
    const gate = deferred<State>()
    const load = vi.fn(() => gate.promise)
    const reads = [cache.read('r1', fp('a'), settled, load), cache.read('r1', fp('a'), settled, load)]
    gate.resolve({ status: 'running' })
    expect((await Promise.all(reads)).map(read => read.state.status)).toEqual(['running', 'running'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('invalidate drops the value and keeps a pending read from being stored', async () => {
    const cache = new RuntimeStatusCache<State>()
    await cache.read('r1', fp('a'), settled, async () => ({ status: 'failed' }))
    cache.invalidate('r1')
    const gate = deferred<State>()
    const pending = cache.read('r1', fp('a'), settled, () => gate.promise)
    cache.invalidate('r1')
    gate.resolve({ status: 'failed' })
    await pending
    const load = vi.fn(async () => ({ status: 'succeeded' }))
    expect((await cache.read('r1', fp('a'), settled, load)).state.status).toBe('succeeded')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('bounds concurrent Core reads across runs', async () => {
    const cache = new RuntimeStatusCache<State>({ maxConcurrent: 2 })
    let running = 0, peak = 0
    const gates = Array.from({ length: 5 }, () => deferred<State>())
    const reads = gates.map((gate, index) => cache.read(`r${index}`, null, settled, async () => {
      running += 1; peak = Math.max(peak, running)
      try { return await gate.promise } finally { running -= 1 }
    }))
    for (const gate of gates) { await new Promise(resolve => setTimeout(resolve, 0)); gate.resolve({ status: 'failed' }) }
    await Promise.all(reads)
    expect(peak).toBe(2)
  })
})

describe('runtimeStatusFingerprint', () => {
  it('is null without any workflow state', () => {
    expect(runtimeStatusFingerprint(runDir('r1'), 'r1')).toBeNull()
  })

  it('hashes a legacy checkpoint by content', () => {
    const file = runDir('r1')
    const checkpoint = path.join(path.dirname(file), 'agent-workflow', 'r1', 'checkpoint.json')
    fs.writeFileSync(checkpoint, '{"a":1}')
    const first = runtimeStatusFingerprint(file, 'r1')
    expect(first?.kind).toBe('legacy')
    fs.writeFileSync(checkpoint, '{"a":2}')
    expect(runtimeStatusFingerprint(file, 'r1')?.key).not.toBe(first?.key)
  })

  it('tracks the v2 SQLite store and WAL, not the read-side -shm index', () => {
    const file = runDir('r1')
    const store = path.join(path.dirname(file), 'agent-workflow', 'run.sqlite')
    fs.writeFileSync(store, 'db')
    const first = runtimeStatusFingerprint(file, 'r1')
    expect(first?.kind).toBe('v2')
    fs.writeFileSync(`${store}-shm`, 'index')
    expect(runtimeStatusFingerprint(file, 'r1')?.key).toBe(first?.key)
    fs.writeFileSync(`${store}-wal`, 'frame')
    expect(runtimeStatusFingerprint(file, 'r1')?.key).not.toBe(first?.key)
  })
})
