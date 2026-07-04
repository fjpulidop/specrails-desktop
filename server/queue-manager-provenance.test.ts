import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { execSync as realExecSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Mock child_process spawn but keep execSync working (used by file-provenance
// for git invocations against the real on-disk repo). The queue-manager spawn
// path uses spawn(), not execSync, so the two coexist cleanly. We also wrap
// execSync so `which/where claude` resolves on CI runners that lack the binary.
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  const wrappedExecSync = ((cmd: string, opts?: unknown) => {
    const s = String(cmd)
    if (s.includes('which claude') || s.includes('where claude')) return Buffer.from('/usr/local/bin/claude\n')
    if (s.includes('which codex') || s.includes('where codex')) return Buffer.from('/usr/local/bin/codex\n')
    return (actual.execSync as (c: string, o?: unknown) => Buffer)(cmd, opts)
  }) as typeof actual.execSync
  return {
    ...actual,
    execSync: wrappedExecSync,
    spawn: vi.fn(),
  }
})

vi.mock('./ids', () => ({ newId: vi.fn(() => 'job-1') }))
vi.mock('tree-kill', () => ({ default: vi.fn() }))
vi.mock('./hooks', () => ({ resetPhases: vi.fn(), setActivePhases: vi.fn() }))

import { spawn as mockSpawn } from 'child_process'
import { QueueManager } from './queue-manager'
import { initDb, type DbInstance } from './db'
import type { WsMessage } from './types'

function fakeChild() {
  const child = new EventEmitter() as unknown as {
    stdout: Readable
    stderr: Readable
    pid: number
    on: (ev: string, cb: (...args: unknown[]) => void) => void
    emit: (ev: string, ...args: unknown[]) => boolean
  }
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 4242
  return child
}

/** Interactive-capable fake child: piped stdin + a kill() that emits 'close'
 *  (the persistent-stdin session transport needs both). */
function fakeInteractiveChild() {
  const child = fakeChild() as ReturnType<typeof fakeChild> & {
    stdin: { write: (s: string) => boolean; destroyed: boolean }
    stdinWrites: string[]
    killed: boolean
    kill: (sig?: string) => boolean
  }
  const writes: string[] = []
  child.stdin = { write: (s: string) => { writes.push(s); return true }, destroyed: false }
  child.stdinWrites = writes
  child.killed = false
  child.kill = () => {
    child.killed = true
    queueMicrotask(() => (child as unknown as EventEmitter).emit('close', 0))
    return true
  }
  return child
}

function initGitRepo(dir: string): void {
  const opts = { cwd: dir, stdio: 'ignore' as const }
  realExecSync('git init -q -b main', opts)
  realExecSync('git config user.email test@example.com', opts)
  realExecSync('git config user.name Test', opts)
  realExecSync('git config commit.gpgsign false', opts)
}

describe('QueueManager — code-explorer provenance hook', () => {
  let projectDir: string
  let db: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  let qm: QueueManager

  const savedInteractiveFlag = process.env.SPECRAILS_INTERACTIVE_JOBS

  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.SPECRAILS_CODE_EXPLORER
    // Pin the legacy one-shot spawn path (the interactive-by-default flip is
    // covered by its own test below, which re-enables the default).
    process.env.SPECRAILS_INTERACTIVE_JOBS = 'false'
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-provenance-'))
    initGitRepo(projectDir)
    fs.writeFileSync(path.join(projectDir, 'committed.ts'), 'export const a = 1\n')
    fs.writeFileSync(path.join(projectDir, 'will-modify.ts'), 'export const b = 1\n')
    fs.writeFileSync(path.join(projectDir, 'will-delete.ts'), 'export const c = 1\n')
    realExecSync('git add -A && git commit -q -m init', { cwd: projectDir, stdio: 'ignore' })

    db = initDb(':memory:')
    broadcast = vi.fn()
    qm = new QueueManager(broadcast, db, [], projectDir, {
      projectId: 'proj-test',
      projectSlug: 'proj-test',
      desktopPort: 4200,
    })
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
    db.close()
    delete process.env.SPECRAILS_CODE_EXPLORER
    if (savedInteractiveFlag === undefined) delete process.env.SPECRAILS_INTERACTIVE_JOBS
    else process.env.SPECRAILS_INTERACTIVE_JOBS = savedInteractiveFlag
  })

  it('records provenance rows for created, modified, and deleted files', async () => {
    const child = fakeChild()
    vi.mocked(mockSpawn).mockReturnValue(child as never)

    // Enqueue triggers _startJob which captures the snapshot.
    qm.enqueue('/specrails:implement #42')

    // Mutate working tree as if the rail did the work. `git add` the new
    // file so it shows up in the diff against the stash blob — untracked
    // working-tree files are not picked up by `git diff <ref>`.
    fs.writeFileSync(path.join(projectDir, 'new-file.ts'), 'export const n = 1\n')
    fs.appendFileSync(path.join(projectDir, 'will-modify.ts'), '\nexport const more = 2\n')
    fs.unlinkSync(path.join(projectDir, 'will-delete.ts'))
    realExecSync('git add -A', { cwd: projectDir, stdio: 'ignore' })

    // Emit the close event so _onJobExit runs.
    ;(child as unknown as EventEmitter).emit('close', 0)

    // Allow the synchronous hook to finish.
    await new Promise((r) => setImmediate(r))

    const rows = db.prepare(
      `SELECT file_path, kind, ticket_id, job_id FROM file_provenance ORDER BY file_path`,
    ).all() as Array<{ file_path: string; kind: string; ticket_id: number | null; job_id: string }>

    const byPath = new Map(rows.map((r) => [r.file_path, r]))
    expect(byPath.get('new-file.ts')?.kind).toBe('created')
    expect(byPath.get('will-modify.ts')?.kind).toBe('modified')
    expect(byPath.get('will-delete.ts')?.kind).toBe('deleted')
    for (const r of rows) {
      expect(r.job_id).toBe('job-1')
      expect(r.ticket_id).toBe(42)
    }

    // Verify broadcast contains one file.provenance_updated per row.
    const provenanceMsgs = (broadcast.mock.calls as Array<[WsMessage]>)
      .map((c) => c[0])
      .filter((m) => m.type === 'file.provenance_updated')
    expect(provenanceMsgs.length).toBe(rows.length)
    for (const m of provenanceMsgs) {
      expect((m as { projectId: string }).projectId).toBe('proj-test')
    }
  })

  it('inserts no rows when the working tree is untouched', async () => {
    const child = fakeChild()
    vi.mocked(mockSpawn).mockReturnValue(child as never)
    qm.enqueue('/specrails:implement #1')
    ;(child as unknown as EventEmitter).emit('close', 0)
    await new Promise((r) => setImmediate(r))
    const count = (db.prepare(`SELECT COUNT(*) as n FROM file_provenance`).get() as { n: number }).n
    expect(count).toBe(0)
  })

  it('skips the hook entirely when SPECRAILS_CODE_EXPLORER=false', async () => {
    process.env.SPECRAILS_CODE_EXPLORER = 'false'
    const child = fakeChild()
    vi.mocked(mockSpawn).mockReturnValue(child as never)
    qm.enqueue('/specrails:implement #1')
    fs.writeFileSync(path.join(projectDir, 'new-file.ts'), 'x\n')
    ;(child as unknown as EventEmitter).emit('close', 0)
    await new Promise((r) => setImmediate(r))
    const count = (db.prepare(`SELECT COUNT(*) as n FROM file_provenance`).get() as { n: number }).n
    expect(count).toBe(0)
  })

  it('records provenance around the INTERACTIVE session lifecycle (default-interactive flip)', async () => {
    // Re-enable the interactive-by-default gate: the claude implement job now
    // spawns a persistent-stdin AUTO session; the pre-spawn snapshot is taken
    // before the session starts and the diff runs at settle.
    delete process.env.SPECRAILS_INTERACTIVE_JOBS
    const child = fakeInteractiveChild()
    vi.mocked(mockSpawn).mockReturnValue(child as never)

    qm.enqueue('/specrails:implement #42')
    // This manager has projectId+slug+cwd, so _startJob awaits plugin
    // resolution before spawning — wait for the session child.
    await vi.waitFor(() => expect(vi.mocked(mockSpawn)).toHaveBeenCalled())
    expect(child.stdinWrites[0]).toContain('/specrails:implement #42')

    // The rail does its work while the turn streams.
    fs.writeFileSync(path.join(projectDir, 'new-file.ts'), 'export const n = 1\n')
    fs.appendFileSync(path.join(projectDir, 'will-modify.ts'), '\nexport const more = 2\n')
    realExecSync('git add -A', { cwd: projectDir, stdio: 'ignore' })

    // The turn result lands with nothing queued → the session auto-settles
    // (job completed) and the provenance diff runs against the snapshot.
    child.stdout.push(JSON.stringify({
      type: 'result',
      total_cost_usd: 0.01,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 20 },
    }) + '\n')
    await vi.waitFor(() => {
      expect(qm.getJobs().find((j) => j.id === 'job-1')?.status).toBe('completed')
    })

    const rows = db.prepare(
      `SELECT file_path, kind, ticket_id, job_id FROM file_provenance ORDER BY file_path`,
    ).all() as Array<{ file_path: string; kind: string; ticket_id: number | null; job_id: string }>
    const byPath = new Map(rows.map((r) => [r.file_path, r]))
    expect(byPath.get('new-file.ts')?.kind).toBe('created')
    expect(byPath.get('will-modify.ts')?.kind).toBe('modified')
    for (const r of rows) {
      expect(r.job_id).toBe('job-1')
      expect(r.ticket_id).toBe(42)
    }
    const provenanceMsgs = (broadcast.mock.calls as Array<[WsMessage]>)
      .map((c) => c[0])
      .filter((m) => m.type === 'file.provenance_updated')
    expect(provenanceMsgs.length).toBe(rows.length)
  })
})
