import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { initDb } from './db/connection'
import { awaitBackgroundProcessesStopped, killOwnedBackgroundProcess, startBackgroundProcess } from './transient-children'
import { installWorktreeProcessReaper } from './modules/terminals/runtime/worktree-process-reaper'
import { installAppWorktreeProcessReaper, listSettledRailWorktreePaths, sweepSettledRunWorktrees } from './worktree-process-reaper'

const dirs: string[] = []
const pids: number[] = []
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}
async function until(test: () => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the process fixture.')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
function tempWorktree(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-reaper-'))
  dirs.push(root)
  const dir = path.join(root, 'worktrees', 'run-1', name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
function script(dir: string, name: string, ignoreTerm = false): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000)`)
  return file
}
/** A detached shell that backgrounds node and exits: the node child is re-parented away from this test. */
async function escaped(file: string): Promise<number> {
  const sh = spawn('/bin/sh', ['-c', `"${process.execPath}" "${file}" > /dev/null 2>&1 & echo $!`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  sh.stdout!.on('data', (chunk) => { out += String(chunk) })
  await new Promise((resolve) => sh.once('close', resolve))
  const pid = Number(out.trim())
  pids.push(pid)
  await until(() => alive(pid))
  return pid
}
const registry = { listContexts: () => [], getProjectRow: () => undefined, desktopDb: undefined, listProjects: () => [] }

afterEach(async () => {
  installWorktreeProcessReaper(null)
  for (const pid of pids.splice(0)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  await awaitBackgroundProcessesStopped(3000)
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('worktree process reaper with real processes', () => {
  it('reaps an escaped process of the worktree and keeps registered and unrelated ones', async () => {
    const worktree = tempWorktree('ticket-4')
    const other = tempWorktree('ticket-40')
    const leftover = await escaped(script(worktree, 'preview.cjs', true))
    const unrelated = await escaped(script(other, 'server.cjs'))
    const kept = startBackgroundProcess(`"${process.execPath}" "${script(worktree, 'dev.cjs')}"`, worktree, 'chat-1', 'project-1')
    await until(() => alive(kept.pid))

    const reaper = installAppWorktreeProcessReaper(registry as never, { graceMs: 300, log: () => {} })
    const result = await reaper({ worktreePaths: [worktree], reason: 'test' })

    expect(result.reaped.map((p) => p.pid)).toEqual([leftover])
    // The leftover ignores SIGTERM: the grace period escalates to SIGKILL.
    await until(() => !alive(leftover), 5000)
    expect(alive(unrelated)).toBe(true)
    expect(alive(kept.pid)).toBe(true)
    killOwnedBackgroundProcess(kept.pid, { projectId: 'project-1', chatId: 'chat-1', processId: kept.processId })
  })

  it('startup recovery reaps only worktrees whose run settled', async () => {
    const settled = tempWorktree('ticket-1')
    const running = tempWorktree('ticket-2')
    const settledLeftover = await escaped(script(settled, 'a.cjs'))
    const runningChild = await escaped(script(running, 'b.cjs'))
    const db = initDb(':memory:')
    db.prepare(`INSERT INTO loop_runs (id, project_id, loop_id, status, started_at, finished_at) VALUES ('r1','p','l','completed','2026-01-01','2026-01-01'), ('r2','p','l','running','2026-01-01',NULL)`).run()
    db.prepare(`INSERT INTO rail_worktrees (id, rail_index, ticket_id, run_id, branch, worktree_path) VALUES ('w1',0,1,'r1','b1',?), ('w2',0,2,'r2','b2',?)`).run(settled, running)
    expect(listSettledRailWorktreePaths(db)).toEqual([settled])

    installAppWorktreeProcessReaper(registry as never, { graceMs: 300, log: () => {} })
    const reaped = await sweepSettledRunWorktrees({ listContexts: () => [{ db, project: { id: 'p' } }] } as never)
    expect(reaped).toBe(1)
    await until(() => !alive(settledLeftover), 5000)
    expect(alive(runningChild)).toBe(true)
  })
})
