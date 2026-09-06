import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import path from 'node:path'
import {
  awaitBackgroundProcessesStopped,
  getBackgroundProcess,
  getBackgroundProcessLogs,
  killOwnedBackgroundProcess,
  startBackgroundProcess,
  type BackgroundProcess,
} from './transient-children'

interface Fixture {
  directory: string
  app?: BackgroundProcess
  serverPid?: number
}
const fixtures: Fixture[] = []
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
async function until<T>(check: () => T | Promise<T>, message: string, timeoutMs = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value as NonNullable<T> } catch (error) { last = error }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`${message}${last instanceof Error ? `: ${last.message}` : ''}`)
}

afterEach(async () => {
  if (!fixtures.length) return
  for (const fixture of fixtures) {
    if (fixture.app) killOwnedBackgroundProcess(fixture.app.pid, fixture.app)
  }
  await awaitBackgroundProcessesStopped(8000)
  // A failing ownership regression must not itself leave its fixture server
  // running. These PIDs come only from the temporary server's receipt.
  for (const fixture of fixtures.splice(0)) {
    if (fixture.serverPid && alive(fixture.serverPid)) {
      try { process.kill(fixture.serverPid, 'SIGKILL') } catch { /* exited meanwhile */ }
      await until(() => !alive(fixture.serverPid!), 'Fixture server did not terminate during cleanup', 3000)
    }
    rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function runningOrphanFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'Specrails Job España '))
  const fixture: Fixture = { directory }
  fixtures.push(fixture)
  const serverFile = path.join(directory, 'persistent server.cjs')
  const wrapperFile = path.join(directory, 'fast wrapper.ps1')
  const serverReceipt = path.join(directory, 'server ready.json')
  const wrapperReceipt = path.join(directory, 'wrapper identity.json')
  writeFileSync(serverFile, `
const fs = require('node:fs');
const server = require('node:http').createServer((_request, response) => response.end('owned fixture'));
server.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(serverReceipt)}, JSON.stringify({ pid: process.pid, parentPid: process.ppid, port: server.address().port })));
setTimeout(() => process.exit(99), 60000).unref();
`)
  copyFileSync(path.resolve('scripts/fixtures/windows-orphan-wrapper.ps1'), wrapperFile)
  const exits: Array<{ process: BackgroundProcess; serverWasAlive: boolean }> = []
  const powershell = path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const command = `"${powershell}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${wrapperFile}" -NodePath "${process.execPath}" -ServerPath "${serverFile}" -ReceiptPath "${wrapperReceipt}"`
  fixture.app = startBackgroundProcess(command, directory, 'containment-chat', 'containment-project', {
    onExited(process) { exits.push({ process, serverWasAlive: fixture.serverPid ? alive(fixture.serverPid) : false }) },
  })
  try {
    const wrapper = await until(() => JSON.parse(readFileSync(wrapperReceipt, 'utf8')) as { pid: number; shellPid: number; serverPid: number }, 'Fast wrapper did not execute')
    fixture.serverPid = wrapper.serverPid
    const server = await until(() => JSON.parse(readFileSync(serverReceipt, 'utf8')) as { pid: number; parentPid: number; port: number }, 'Fixture server did not become ready')
    expect(server.pid).toBe(wrapper.serverPid)
    expect(server.parentPid).toBe(wrapper.pid)
    await until(() => !alive(wrapper.pid) && !alive(wrapper.shellPid), 'Wrapper and shell should exit before the ownership check')
    expect(alive(server.pid)).toBe(true)
    const response = await fetch(`http://127.0.0.1:${server.port}`, { signal: AbortSignal.timeout(2000) })
    expect(await response.text()).toBe('owned fixture')
    expect(exits).toEqual([])
    expect(getBackgroundProcess(fixture.app.pid, fixture.app.processId)?.status).toBe('running')
    return { fixture, server, exits }
  } catch (error) {
    const state = getBackgroundProcess(fixture.app.pid, fixture.app.processId)
    const logs = getBackgroundProcessLogs(fixture.app.pid, { processId: fixture.app.processId })?.lines.map(line => line.line).join('\n') ?? ''
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nBackground state: ${JSON.stringify(state)}\nCaptured output:\n${logs}`)
  }
}

async function portIsAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

describe.skipIf(process.platform !== 'win32')('Windows background Job Object containment (real native processes)', () => {
  it('stops an inherited-job server after its fast wrapper and shell ancestors have already exited', async () => {
    const { fixture, server, exits } = await runningOrphanFixture()

    expect(killOwnedBackgroundProcess(fixture.app!.pid, fixture.app!)).toBe(true)
    await until(() => !alive(server.pid), 'Stop did not terminate the server whose original ancestors exited')
    await until(() => getBackgroundProcess(fixture.app!.pid, fixture.app!.processId)?.status === 'killed', 'Stop was not confirmed by the contained job')
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatchObject({ process: { processId: fixture.app!.processId, status: 'killed' }, serverWasAlive: false })
    expect(await portIsAvailable(server.port)).toBe(true)
  }, 30_000)

  it('kills the remaining server and reports failure if its sole Job supervisor is terminated unexpectedly', async () => {
    const { fixture, server, exits } = await runningOrphanFixture()

    // Kill only the supervisor this test created, without taskkill /T or a
    // descendant list: the kernel Job must own the orphan independently.
    process.kill(fixture.app!.pid, 'SIGKILL')
    await until(() => !alive(server.pid), 'Closing the supervisor did not terminate its contained server')
    await until(() => getBackgroundProcess(fixture.app!.pid, fixture.app!.processId)?.status === 'failed', 'Unexpected supervisor loss left a live or successful process record')
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatchObject({ process: { processId: fixture.app!.processId, status: 'failed' }, serverWasAlive: false })
    expect(exits[0].process.error).toMatch(/supervisor/i)
    expect(await portIsAvailable(server.port)).toBe(true)
  }, 30_000)
})
