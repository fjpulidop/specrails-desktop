import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createListenerReader, readDarwinListeners, readLinuxListeners } from './listening-ports'
import { attributeListeners } from '../domain/run-ports'

const supported = process.platform === 'darwin' || process.platform === 'linux'
let child: ChildProcess | null = null
let dir: string | null = null

afterEach(() => {
  child?.kill('SIGKILL')
  child = null
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = null
})

/** A real server listening on an ephemeral port, started with `cwd` in a temp "worktree". */
async function listenFrom(cwd: string): Promise<{ pid: number; port: number }> {
  child = spawn(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port))"], { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise<number>((resolve, reject) => {
    child!.stdout!.once('data', (chunk: Buffer) => resolve(Number(String(chunk).trim())))
    child!.once('error', reject)
  })
  return { pid: child.pid!, port }
}

describe.skipIf(!supported)('listening ports (real listener)', () => {
  it('reads the listener with its pid and cwd, and attributes it to the worktree by cwd', async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'listen-wt-')))
    const { pid, port } = await listenFrom(dir)
    const listeners = process.platform === 'darwin' ? await readDarwinListeners() : await readLinuxListeners()
    const mine = listeners.find((l) => l.port === port && l.pid === pid)
    expect(mine).toBeTruthy()
    expect(mine!.cwd).toBe(dir)
    const [attributed] = attributeListeners([mine!], null, [{ worktreePath: dir, lease: null }])
    expect(attributed).toMatchObject({ port, confidence: 'cwd', squatting: false })
  }, 20_000)

  it('shares scans and rescans after an invalidation', async () => {
    let reads = 0
    let now = 0
    const reader = createListenerReader({ platform: 'linux', readLinux: async () => { reads++; return [] }, now: () => now, ttlMs: 1000 })
    await Promise.all([reader.read(), reader.read()])
    await reader.read()
    expect(reads).toBe(1)
    reader.invalidate()
    await reader.read()
    expect(reads).toBe(2)
    now = 5000
    await reader.read()
    expect(reads).toBe(3)
    const unsupported = createListenerReader({ platform: 'win32' })
    expect(await unsupported.read()).toMatchObject({ supported: false, listeners: [] })
  })
})
