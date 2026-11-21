import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureCoreChildRegistry, coreChildSpawnOptions, killCoreChildTree, readCommandLine, reapOrphanedCoreChildren, trackCoreChild,
} from './core-child-process'
import { treeKillSafe } from './win-spawn'

const roots: string[] = []
const started: number[] = []
const root = (): string => { const dir = mkdtempSync(path.join(tmpdir(), 'core-children-')); roots.push(dir); return dir }
afterEach(() => {
  configureCoreChildRegistry(null)
  for (const pid of started.splice(0)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
async function until(check: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return true; await new Promise((resolve) => setTimeout(resolve, 25)) }
  return check()
}
const record = (dir: string, value: Record<string, unknown>) => writeFileSync(path.join(dir, `${value.pid}.json`), JSON.stringify(value))

describe('Core child spawn options and records', () => {
  it('puts every Core child in its own process group', () => {
    expect(coreChildSpawnOptions()).toEqual({ detached: true })
  })

  it('records a tracked child while it runs and forgets it when it exits', async () => {
    const dir = root()
    configureCoreChildRegistry(dir)
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore' })
    trackCoreChild(child, 'runtime', 'cli.js run')
    const saved = JSON.parse(readFileSync(path.join(dir, `${child.pid}.json`), 'utf8'))
    expect(saved).toMatchObject({ schemaVersion: 1, pid: child.pid, ownerPid: process.pid, kind: 'runtime', marker: 'cli.js run' })
    await new Promise((resolve) => child.once('exit', resolve))
    await until(() => readdirSync(dir).length === 0)
    expect(readdirSync(dir)).toEqual([])
  })

  it('tracks nothing without a configured registry', () => {
    const child = { pid: 123, once: vi.fn() } as unknown as ChildProcess
    trackCoreChild(child, 'runtime', 'x')
    expect(child.once).not.toHaveBeenCalled()
  })
})

describe('boot sweep of orphaned Core children', () => {
  it('kills only a recorded child of another owner that still runs its Core command, and drops every other record', () => {
    const dir = root()
    record(dir, { schemaVersion: 1, pid: 101, ownerPid: 999_999, kind: 'runtime', marker: '/core/cli.js resume', startedAt: 'x' })
    record(dir, { schemaVersion: 1, pid: 102, ownerPid: 999_999, kind: 'session-host', marker: '/core/cli.js host', startedAt: 'x' })
    record(dir, { schemaVersion: 1, pid: 103, ownerPid: 999_999, kind: 'runtime', marker: '/core/cli.js run', startedAt: 'x' })
    record(dir, { schemaVersion: 1, pid: 104, ownerPid: process.pid, kind: 'runtime', marker: '/core/cli.js run', startedAt: 'x' })
    writeFileSync(path.join(dir, '105.json'), '{not json')
    const commands: Record<number, string | null> = {
      101: '/node /core/cli.js resume --context /p/desktop-context.json',
      102: '/node /core/cli.js host --stdio --scope s',
      103: '/usr/bin/vim notes.txt', // pid reused by an unrelated process
    }
    const kill = vi.fn()
    const reaped = reapOrphanedCoreChildren({ directory: dir, readCommand: (pid) => commands[pid] ?? null, kill })
    expect(reaped).toEqual([{ pid: 101, kind: 'runtime', ownerPid: 999_999 }, { pid: 102, kind: 'session-host', ownerPid: 999_999 }])
    expect(kill.mock.calls.map(([pid]) => pid)).toEqual([101, 102])
    // This server's own child stays recorded; everything else is settled.
    expect(readdirSync(dir)).toEqual(['104.json'])
  })

  it('never throws on a missing directory', () => {
    expect(reapOrphanedCoreChildren({ directory: path.join(root(), 'absent') })).toEqual([])
    expect(reapOrphanedCoreChildren({ directory: null })).toEqual([])
  })
})

// A tiny fake Core: SIGTERM is "cancel the run", which it records the way Core marks a run cancelled.
const FAKE_CORE = `const fs = require('node:fs'); const [cancelled] = process.argv.slice(2)
process.on('SIGTERM', () => { fs.writeFileSync(cancelled, 'cancelled'); process.exit(0) })
fs.writeFileSync(cancelled + '.ready', '1'); setInterval(() => {}, 1000)`
// A stand-in Desktop server: spawns the fake Core with the given options, prints its pid, then idles.
const FAKE_DESKTOP = `const { spawn } = require('node:child_process'); const [core, cancelled, options] = process.argv.slice(2)
const child = spawn(process.execPath, [core, cancelled], { stdio: 'ignore', ...JSON.parse(options) })
console.log(child.pid); setInterval(() => {}, 1000)`

describe.skipIf(process.platform === 'win32')('signals to Desktop\'s process group (integration)', () => {
  async function desktopWithCore(options: object): Promise<{ desktop: ChildProcess; core: number; cancelled: string; script: string }> {
    const dir = root()
    const script = path.join(dir, 'fake-core.cjs'), parent = path.join(dir, 'fake-desktop.cjs'), cancelled = path.join(dir, 'cancelled')
    writeFileSync(script, FAKE_CORE)
    writeFileSync(parent, FAKE_DESKTOP)
    // The stand-in Desktop leads its own group, like `npm run dev` in a terminal: the test runner is outside it.
    const desktop = spawn(process.execPath, [parent, script, cancelled, JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'inherit'], detached: true })
    started.push(desktop.pid!)
    const core = await new Promise<number>((resolve) => desktop.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim()))))
    started.push(core)
    expect(await until(() => existsSync(cancelled + '.ready'))).toBe(true)
    return { desktop, core, cancelled, script }
  }

  it('without its own group, the fake Core receives the group SIGTERM and cancels its run (the defect)', async () => {
    const { desktop, core, cancelled } = await desktopWithCore({})
    process.kill(-desktop.pid!, 'SIGTERM')
    expect(await until(() => existsSync(cancelled))).toBe(true)
    expect(await until(() => !alive(core))).toBe(true)
  })

  it('with the Core child options, a group SIGTERM stops Desktop only; the orphan is then reaped at boot, without zombies', async () => {
    const { desktop, core, cancelled, script } = await desktopWithCore(coreChildSpawnOptions())
    const registry = root()
    record(registry, { schemaVersion: 1, pid: core, ownerPid: desktop.pid, kind: 'runtime', marker: script, startedAt: new Date().toISOString() })
    process.kill(-desktop.pid!, 'SIGTERM')
    expect(await until(() => !alive(desktop.pid!))).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(alive(core)).toBe(true)
    expect(existsSync(cancelled)).toBe(false)
    expect(readCommandLine(core)).toContain(script)
    // The next Desktop on this data home: the orphan is killed (SIGKILL: no cancellation) and reaped by init.
    expect(reapOrphanedCoreChildren({ directory: registry })).toEqual([{ pid: core, kind: 'runtime', ownerPid: desktop.pid }])
    expect(await until(() => !alive(core))).toBe(true)
    expect(existsSync(cancelled)).toBe(false)
    expect(readdirSync(registry)).toEqual([])
  })

  it('an explicit Stop still reaches a Core child in its own group', async () => {
    const dir = root()
    const script = path.join(dir, 'fake-core.cjs'), cancelled = path.join(dir, 'cancelled')
    writeFileSync(script, FAKE_CORE)
    const child = spawn(process.execPath, [script, cancelled], { stdio: 'ignore', ...coreChildSpawnOptions() })
    started.push(child.pid!)
    expect(await until(() => existsSync(cancelled + '.ready'))).toBe(true)
    const exited = new Promise((resolve) => child.once('exit', resolve))
    treeKillSafe(child.pid!, 'SIGTERM')
    await exited
    expect(readFileSync(cancelled, 'utf8')).toBe('cancelled')
    expect(alive(child.pid!)).toBe(false)
  })

  it('kills the whole tree of an orphan, including what it started', async () => {
    const dir = root()
    const grandchild = path.join(dir, 'grandchild.pid')
    const script = path.join(dir, 'tree.cjs')
    writeFileSync(script, `const { spawn } = require('node:child_process'); const fs = require('node:fs')
const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(grandchild)}, String(c.pid)); setInterval(() => {}, 1000)`)
    const child = spawn(process.execPath, [script], { stdio: 'ignore', ...coreChildSpawnOptions() })
    started.push(child.pid!)
    expect(await until(() => existsSync(grandchild))).toBe(true)
    const inner = Number(readFileSync(grandchild, 'utf8'))
    started.push(inner)
    killCoreChildTree(child.pid!)
    expect(await until(() => !alive(inner))).toBe(true)
  })
})
