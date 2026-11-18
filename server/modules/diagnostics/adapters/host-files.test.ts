import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHostCrashStore, hostLogDirFromEnv, readHostLogTail } from './host-files'

const dirs: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-diag-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

const marker = (atMs: number) => ({ version: 1, id: `${atMs}-7`, atMs, at: 'x', pid: 7, exitCode: 1, signal: null, uptimeMs: 5, wasReady: true, outcome: 'restarted', recentRestarts: 1, maxRestarts: 3, windowSecs: 60, stderrTail: ['e'] })

describe('host files', () => {
  it('only trusts an absolute host log folder', () => {
    expect(hostLogDirFromEnv({ SPECRAILS_HOST_LOG_DIR: '/var/log/x' })).toBe('/var/log/x')
    expect(hostLogDirFromEnv({ SPECRAILS_HOST_LOG_DIR: 'relative' })).toBeNull()
    expect(hostLogDirFromEnv({})).toBeNull()
  })

  it('reads valid markers, skips malformed ones and stores the acknowledgement atomically', () => {
    const dir = tempDir()
    const crashes = path.join(dir, 'crashes')
    fs.mkdirSync(crashes)
    fs.writeFileSync(path.join(crashes, 'crash-0000000000020-7.json'), JSON.stringify(marker(20)))
    fs.writeFileSync(path.join(crashes, 'crash-0000000000010-7.json'), JSON.stringify(marker(10)))
    fs.writeFileSync(path.join(crashes, 'crash-0000000000030-7.json'), '{not json')
    fs.writeFileSync(path.join(crashes, '.crash-0000000000040-7.json.partial'), JSON.stringify(marker(40)))
    const store = createHostCrashStore(dir)
    expect(store.available).toBe(true)
    expect(store.list().map(m => m.atMs).sort()).toEqual([10, 20])
    expect(store.acknowledgedThrough()).toBe(0)
    store.acknowledge(20)
    expect(store.acknowledgedThrough()).toBe(20)
    expect(fs.readdirSync(crashes).filter(name => name.endsWith('.partial') && !name.startsWith('.crash'))).toEqual([])
    if (process.platform !== 'win32') expect(fs.statSync(path.join(crashes, 'acknowledged.json')).mode & 0o777).toBe(0o600)
  })

  it('is inert without a host folder', () => {
    const store = createHostCrashStore(null)
    expect(store.available).toBe(false)
    expect(store.list()).toEqual([])
    store.acknowledge(5)
    expect(readHostLogTail(null, 'sidecar.log')).toBeNull()
  })

  it('reads the tail of a host log from a line boundary', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'sidecar.log'), 'first line\nsecond line\nthird line\n')
    expect(readHostLogTail(dir, 'sidecar.log', 16)).toBe('third line\n')
    expect(readHostLogTail(dir, 'sidecar.log')).toBe('first line\nsecond line\nthird line\n')
    expect(readHostLogTail(dir, 'desktop.log')).toBeNull()
  })
})
