import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  startBackgroundProcess, killOwnedBackgroundProcess, getBackgroundProcess,
  awaitBackgroundProcessesStopped, type BackgroundProcess,
} from './transient-children'

const fixtures: Array<{ directory: string; process?: BackgroundProcess }> = []
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}
async function until(test: () => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for owned background process fixture.')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-background-group-'))
  const childFile = path.join(directory, 'stubborn.cjs'), ready = path.join(directory, 'child-ready.json')
  fs.writeFileSync(childFile, `const fs = require('fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid})); setInterval(() => {}, 1000);`)
  const entry = { directory } as { directory: string; process?: BackgroundProcess }
  fixtures.push(entry)
  return { entry, childFile, ready }
}

afterEach(async () => {
  for (const entry of fixtures) if (entry.process) {
    // Cleanup only the detached group created by this fixture, never a lookup
    // by command or a port belonging to another local application.
    try { process.kill(-entry.process.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  await awaitBackgroundProcessesStopped(2000)
  for (const entry of fixtures.splice(0)) fs.rmSync(entry.directory, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('real isolated POSIX background process groups', () => {
  it('keeps SIGKILL armed after the shell closes while its child ignores SIGTERM', async () => {
    const { entry, childFile, ready } = fixture()
    const closed = path.join(entry.directory, 'shell-closed')
    const command = `trap 'echo closed > ${quote(closed)}; exit 0' TERM; ${quote(process.execPath)} ${quote(childFile)} > /dev/null 2>&1 & wait`
    const exits: BackgroundProcess[] = []
    entry.process = startBackgroundProcess(command, entry.directory, 'fixture-chat', 'fixture-project', { onExited: process => exits.push(process) })
    await until(() => fs.existsSync(ready))
    const childPid = JSON.parse(fs.readFileSync(ready, 'utf8')).pid as number
    expect(alive(childPid)).toBe(true)
    const requestedAt = Date.now()
    expect(killOwnedBackgroundProcess(entry.process.pid, { projectId: 'fixture-project', chatId: 'fixture-chat', processId: entry.process.processId })).toBe(true)
    await until(() => fs.existsSync(closed), 2000)
    expect(alive(childPid)).toBe(true)
    expect(getBackgroundProcess(entry.process.pid)?.status).toBe('stopping')
    expect(exits).toEqual([])
    expect(await awaitBackgroundProcessesStopped(6000)).toEqual([])
    expect(Date.now() - requestedAt).toBeGreaterThanOrEqual(2400)
    expect(alive(childPid)).toBe(false)
    expect(alive(-entry.process.pid)).toBe(false)
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatchObject({ status: 'killed', processId: entry.process.processId, endedAt: expect.any(Number) })
  })

  it('automatically reaps a resistant descendant after a failing wrapper exits, retaining the original failure', async () => {
    const { entry, childFile, ready } = fixture()
    const parentFile = path.join(entry.directory, 'wrapper.cjs')
    fs.writeFileSync(parentFile, `require('child_process').spawn(process.execPath, [${JSON.stringify(childFile)}], {stdio:'ignore'}); setTimeout(() => process.exit(7), 400);`)
    const exits: BackgroundProcess[] = []
    entry.process = startBackgroundProcess(`${quote(process.execPath)} ${quote(parentFile)}`, entry.directory, 'fixture-chat', 'fixture-project', { onExited: process => exits.push(process) })
    await until(() => fs.existsSync(ready))
    const childPid = JSON.parse(fs.readFileSync(ready, 'utf8')).pid as number
    await until(() => getBackgroundProcess(entry.process!.pid)?.status === 'stopping', 2000)
    expect(alive(childPid)).toBe(true)
    expect(exits).toEqual([])
    await until(() => getBackgroundProcess(entry.process!.pid)?.status === 'failed')
    expect(alive(childPid)).toBe(false)
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatchObject({ status: 'failed', exitCode: 7 })
  })
})
