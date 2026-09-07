import { describe, it, expect, beforeEach, vi } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync, appendFileSync, unlinkSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import type { DbInstance } from './db'
import { gitExecEnv } from './file-provenance'
import {
  snapshotWorkingTree,
  resolveHeadSha,
  diffAgainstSnapshot,
  collectDiffPatches,
  recordProvenanceForJob,
  getProvenanceDiff,
  listProvenanceByTicket,
  listProvenanceByPath,
  listUntracked,
  broadcastProvenanceUpdated,
  type DiffEntry,
  type ProvenanceRow,
} from './file-provenance'

function initTestDb(): DbInstance {
  const db = new Database(':memory:') as unknown as DbInstance
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_provenance (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path   TEXT    NOT NULL,
      ticket_id   INTEGER,
      job_id      TEXT,
      kind        TEXT    NOT NULL CHECK(kind IN ('created','modified','deleted')),
      at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fp_path   ON file_provenance(file_path);
    CREATE INDEX IF NOT EXISTS idx_fp_ticket ON file_provenance(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_fp_at     ON file_provenance(at DESC);
    CREATE TABLE IF NOT EXISTS file_provenance_diffs (
      provenance_id INTEGER PRIMARY KEY REFERENCES file_provenance(id) ON DELETE CASCADE,
      patch         TEXT NOT NULL,
      truncated     INTEGER NOT NULL DEFAULT 0
    );
  `)
  return db
}

function initGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fp-test-'))
  execSync('git init -q', { cwd: dir })
  execSync('git config user.email "test@test.local"', { cwd: dir })
  execSync('git config user.name "Test"', { cwd: dir })
  execSync('git config commit.gpgsign false', { cwd: dir })
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  execSync('git add -A', { cwd: dir })
  execSync('git commit -q -m "init"', { cwd: dir })
  return dir
}

describe('snapshotWorkingTree', () => {
  it('returns a sha for a dirty repo and captures untracked files', () => {
    const dir = initGitRepo()
    try {
      appendFileSync(join(dir, 'a.txt'), 'change\n')
      writeFileSync(join(dir, 'b.txt'), 'new\n')
      const snap = snapshotWorkingTree(dir)
      expect(snap.ref).toMatch(/^[0-9a-f]{40}$/)
      expect(snap.untracked).toContain('b.txt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns empty ref and empty untracked for a clean repo', () => {
    const dir = initGitRepo()
    try {
      const snap = snapshotWorkingTree(dir)
      expect(snap.ref).toBe('')
      expect(snap.untracked).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('freezes the HEAD sha even when the tree is clean (no stash ref)', () => {
    const dir = initGitRepo()
    try {
      const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()
      const snap = snapshotWorkingTree(dir)
      expect(snap.ref).toBe('')
      expect(snap.headSha).toBe(head)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveHeadSha', () => {
  it('returns the 40-char HEAD sha inside a repo and "" outside one', () => {
    const dir = initGitRepo()
    try {
      expect(resolveHeadSha(dir)).toMatch(/^[0-9a-f]{40}$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const nonRepo = mkdtempSync(join(tmpdir(), 'fp-norepo-'))
    try {
      expect(resolveHeadSha(nonRepo)).toBe('')
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })
})

describe('diffAgainstSnapshot', () => {
  it('parses A, M, D entries from a snapshot ref', () => {
    const dir = initGitRepo()
    try {
      writeFileSync(join(dir, 'm.txt'), 'orig\n')
      writeFileSync(join(dir, 'd.txt'), 'doomed\n')
      execSync('git add -A', { cwd: dir })
      execSync('git commit -q -m "setup"', { cwd: dir })

      // Snapshot the clean baseline (no changes -> stash create returns ''),
      // so we use HEAD as the diff reference.
      const baselineRef = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()

      appendFileSync(join(dir, 'm.txt'), 'change\n')
      unlinkSync(join(dir, 'd.txt'))
      writeFileSync(join(dir, 'added.txt'), 'new\n')
      execSync('git add -A', { cwd: dir })

      const entries = diffAgainstSnapshot(dir, baselineRef)
      const byPath = new Map(entries.map((e) => [e.path, e]))
      expect(byPath.get('m.txt')?.status).toBe('M')
      expect(byPath.get('d.txt')?.status).toBe('D')
      expect(byPath.get('added.txt')?.status).toBe('A')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('clean tree + committing job: recovers the delta via the frozen headSha (regression for lost provenance)', () => {
    const dir = initGitRepo()
    try {
      // Clean tree at snapshot time → no stash ref, headSha frozen at pre-job HEAD.
      const snap = snapshotWorkingTree(dir)
      expect(snap.ref).toBe('')

      // Job creates + modifies + COMMITS its output, advancing HEAD past the work.
      writeFileSync(join(dir, 'feature.txt'), 'feature\n')
      appendFileSync(join(dir, 'a.txt'), 'edit by job\n')
      execSync('git add -A', { cwd: dir })
      execSync('git commit -q -m "job output"', { cwd: dir })

      // Old behavior (no baseSha) diffs against the ADVANCED live HEAD → empty,
      // which is exactly how all provenance was silently lost.
      const stale = diffAgainstSnapshot(dir, snap.ref, snap.untracked)
      expect(stale).toEqual([])

      // Fixed: passing the frozen headSha recovers created + modified rows.
      const entries = diffAgainstSnapshot(dir, snap.ref, snap.untracked, snap.headSha)
      const byPath = new Map(entries.map((e) => [e.path, e]))
      expect(byPath.get('feature.txt')?.status).toBe('A')
      expect(byPath.get('a.txt')?.status).toBe('M')

      // Patches are likewise recovered (collectDiffPatches honours baseSha).
      const patches = collectDiffPatches(dir, snap.ref, entries, snap.headSha)
      expect(patches.get('a.txt')?.patch).toContain('edit by job')
      expect(collectDiffPatches(dir, snap.ref, entries).get('a.txt')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('parses R rename entries', () => {
    const dir = initGitRepo()
    try {
      writeFileSync(join(dir, 'old.txt'), 'x'.repeat(200))
      execSync('git add -A', { cwd: dir })
      execSync('git commit -q -m "with old"', { cwd: dir })

      const baselineRef = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()
      renameSync(join(dir, 'old.txt'), join(dir, 'new.txt'))
      execSync('git add -A', { cwd: dir })

      const entries = diffAgainstSnapshot(dir, baselineRef)
      const r = entries.find((e) => e.status === 'R')
      expect(r).toBeDefined()
      expect(r?.path).toBe('new.txt')
      expect(r?.renamedFrom).toBe('old.txt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns [] for an empty diff', () => {
    const dir = initGitRepo()
    try {
      const entries = diffAgainstSnapshot(dir, '')
      expect(entries).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records rail-created untracked files even when the tree was DIRTY at snapshot time', () => {
    // Regression: a dirty tree yields a non-empty stash ref; the old code only
    // ran `git ls-files --others` when the ref was empty, so new untracked files
    // a rail created were silently lost. Pre-existing untracked files must NOT be
    // mis-recorded as created.
    const dir = initGitRepo()
    try {
      // Dirty the tree: modify a tracked file AND leave a pre-existing untracked file.
      appendFileSync(join(dir, 'a.txt'), 'dirty\n')
      writeFileSync(join(dir, 'preexisting.txt'), 'was here before\n')
      const snap = snapshotWorkingTree(dir)
      expect(snap.ref).toMatch(/^[0-9a-f]{40}$/) // dirty → real ref
      expect(snap.untracked).toContain('preexisting.txt')

      // The "rail" runs: creates a brand-new untracked file + edits the tracked file again.
      writeFileSync(join(dir, 'rail-new.txt'), 'created by rail\n')
      appendFileSync(join(dir, 'a.txt'), 'rail edit\n')

      const entries = diffAgainstSnapshot(dir, snap.ref, snap.untracked)
      const byPath = new Map(entries.map((e) => [e.path, e]))
      expect(byPath.get('rail-new.txt')?.status).toBe('A') // recorded as created
      expect(byPath.get('a.txt')?.status).toBe('M')
      expect(byPath.has('preexisting.txt')).toBe(false) // not the rail's creation
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maps a typechange (T) status to modified and never desyncs the parser', () => {
    // Replace a regular file with a symlink → git reports `T`. The next changed
    // file must still be parsed correctly (no off-by-one corruption).
    const dir = initGitRepo()
    try {
      writeFileSync(join(dir, 'sib.txt'), 'sibling\n')
      execSync('git add -A', { cwd: dir })
      execSync('git commit -q -m "add sib"', { cwd: dir })
      const baselineRef = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()

      unlinkSync(join(dir, 'a.txt'))
      execSync('ln -s sib.txt a.txt', { cwd: dir }) // a.txt: regular → symlink = typechange
      appendFileSync(join(dir, 'sib.txt'), 'more\n')
      execSync('git add -A', { cwd: dir })

      const entries = diffAgainstSnapshot(dir, baselineRef)
      const byPath = new Map(entries.map((e) => [e.path, e]))
      expect(byPath.get('a.txt')?.status).toBe('M') // T → M
      expect(byPath.get('sib.txt')?.status).toBe('M')
      // No phantom path named after a status letter leaked in.
      expect(entries.every((e) => e.path === 'a.txt' || e.path === 'sib.txt')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('listUntracked', () => {
  it('lists untracked non-ignored files and excludes ignored ones', () => {
    const dir = initGitRepo()
    try {
      writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
      writeFileSync(join(dir, 'untracked.txt'), 'x\n')
      writeFileSync(join(dir, 'ignored.txt'), 'y\n')
      const list = listUntracked(dir)
      expect(list).toContain('untracked.txt')
      expect(list).toContain('.gitignore')
      expect(list).not.toContain('ignored.txt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns [] outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-nogit-'))
    try {
      expect(listUntracked(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('collectDiffPatches', () => {
  it('captures a patch for a modified tracked file', () => {
    const dir = initGitRepo()
    try {
      const baselineRef = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()
      appendFileSync(join(dir, 'a.txt'), 'change\n')
      const diff = diffAgainstSnapshot(dir, baselineRef)
      const patches = collectDiffPatches(dir, baselineRef, diff)
      expect(patches.get('a.txt')?.patch).toContain('+change')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('synthesizes an added-file patch with the no-newline marker for untracked files', () => {
    const dir = initGitRepo()
    try {
      // Clean tree → empty snapshot ref → untracked files surface as 'A'.
      writeFileSync(join(dir, 'no-eol.txt'), 'line1\nline2') // no trailing newline
      writeFileSync(join(dir, 'eol.txt'), 'a\nb\n') // trailing newline
      const diff = diffAgainstSnapshot(dir, '')
      const patches = collectDiffPatches(dir, '', diff)
      const noEol = patches.get('no-eol.txt')?.patch ?? ''
      const eol = patches.get('eol.txt')?.patch ?? ''
      expect(noEol).toContain('+line2')
      expect(noEol).toContain('\\ No newline at end of file')
      expect(eol).toContain('+b')
      expect(eol).not.toContain('No newline at end of file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('recordProvenanceForJob', () => {
  let db: DbInstance
  beforeEach(() => { db = initTestDb() })

  it('normalises A -> created, M -> modified, D -> deleted', () => {
    const diff: DiffEntry[] = [
      { path: 'new.ts', status: 'A' },
      { path: 'mod.ts', status: 'M' },
      { path: 'gone.ts', status: 'D' },
    ]
    const rows = recordProvenanceForJob(db, 'p1', 'job-1', 42, diff, 1000)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ file_path: 'new.ts', kind: 'created', ticket_id: 42, job_id: 'job-1', at: 1000 })
    expect(rows[1]).toMatchObject({ file_path: 'mod.ts', kind: 'modified' })
    expect(rows[2]).toMatchObject({ file_path: 'gone.ts', kind: 'deleted' })
  })

  it('R -> modified at new path + deleted at renamedFrom', () => {
    const diff: DiffEntry[] = [{ path: 'B.ts', status: 'R', renamedFrom: 'A.ts' }]
    const rows = recordProvenanceForJob(db, 'p1', 'job-1', 7, diff, 2000)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ file_path: 'B.ts', kind: 'modified', ticket_id: 7, job_id: 'job-1' })
    expect(rows[1]).toMatchObject({ file_path: 'A.ts', kind: 'deleted', ticket_id: 7, job_id: 'job-1' })
  })

  it('empty diff is a no-op fast path', () => {
    const rows = recordProvenanceForJob(db, 'p1', 'job-1', 1, [], 1000)
    expect(rows).toEqual([])
    const count = db.prepare('SELECT COUNT(*) AS n FROM file_provenance').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('rolls back when a CHECK constraint violates inside the transaction', () => {
    recordProvenanceForJob(db, 'p1', 'job-0', null, [{ path: 'pre.ts', status: 'A' }], 500)
    const before = (db.prepare('SELECT COUNT(*) AS n FROM file_provenance').get() as { n: number }).n
    expect(before).toBe(1)

    const badInsert = db.prepare(`
      INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at)
      VALUES (?, ?, ?, ?, ?)
    `)
    const tx = db.transaction(() => {
      badInsert.run('ok.ts', null, 'job-x', 'modified', 600)
      badInsert.run('bad.ts', null, 'job-x', 'INVALID_KIND', 700)
    })
    expect(() => tx()).toThrow()

    const after = (db.prepare('SELECT COUNT(*) AS n FROM file_provenance').get() as { n: number }).n
    expect(after).toBe(1)
  })

  it('null ticket_id is allowed', () => {
    const rows = recordProvenanceForJob(db, 'p1', 'job-1', null, [{ path: 'x.ts', status: 'A' }], 100)
    expect(rows[0].ticket_id).toBeNull()
  })

  it('stores optional patches keyed to provenance rows', () => {
    const patches = new Map([['x.ts', { patch: 'diff --git a/x.ts b/x.ts\n+hello', truncated: false }]])
    recordProvenanceForJob(db, 'p1', 'job-1', 1, [{ path: 'x.ts', status: 'M' }], 100, patches)
    expect(getProvenanceDiff(db, 'p1', 'job-1', 'x.ts')).toEqual({
      patch: 'diff --git a/x.ts b/x.ts\n+hello',
      truncated: false,
    })
  })
})

describe('list queries', () => {
  let db: DbInstance
  beforeEach(() => { db = initTestDb() })

  it('listProvenanceByTicket returns rows ORDER BY at DESC', () => {
    recordProvenanceForJob(db, 'p1', 'j1', 5, [{ path: 'a.ts', status: 'A' }], 100)
    recordProvenanceForJob(db, 'p1', 'j2', 5, [{ path: 'b.ts', status: 'M' }], 300)
    recordProvenanceForJob(db, 'p1', 'j3', 5, [{ path: 'c.ts', status: 'A' }], 200)
    recordProvenanceForJob(db, 'p1', 'j4', 99, [{ path: 'z.ts', status: 'A' }], 500)

    const rows = listProvenanceByTicket(db, 'p1', 5)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.at)).toEqual([300, 200, 100])
  })

  it('listProvenanceByPath returns rows ORDER BY at DESC', () => {
    recordProvenanceForJob(db, 'p1', 'j1', 1, [{ path: 'shared.ts', status: 'A' }], 100)
    recordProvenanceForJob(db, 'p1', 'j2', 2, [{ path: 'shared.ts', status: 'M' }], 300)
    recordProvenanceForJob(db, 'p1', 'j3', 3, [{ path: 'shared.ts', status: 'M' }], 200)
    recordProvenanceForJob(db, 'p1', 'j4', 4, [{ path: 'other.ts', status: 'A' }], 999)

    const rows = listProvenanceByPath(db, 'p1', 'shared.ts')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.at)).toEqual([300, 200, 100])
  })
})

describe('broadcastProvenanceUpdated', () => {
  it('calls broadcast once with the right shape', () => {
    const broadcast = vi.fn()
    const row: ProvenanceRow = {
      id: 1,
      file_path: 'src/x.ts',
      ticket_id: 42,
      job_id: 'job-1',
      kind: 'modified',
      at: 12345,
    }
    broadcastProvenanceUpdated(broadcast, 'proj-1', row)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith({
      type: 'file.provenance_updated',
      projectId: 'proj-1',
      path: 'src/x.ts',
      kind: 'modified',
      ticketId: 42,
      jobId: 'job-1',
      at: 12345,
    })
  })

  it('empty diff path emits no broadcast (caller responsibility, no inserted rows to iterate)', () => {
    const broadcast = vi.fn()
    const db = initTestDb()
    const rows = recordProvenanceForJob(db, 'p1', 'j1', 1, [], 1)
    for (const r of rows) broadcastProvenanceUpdated(broadcast, 'p1', r)
    expect(broadcast).not.toHaveBeenCalled()
  })
})

describe('gitExecEnv', () => {
  it('reads PATH at call time so the startup resolver\'s bundled git is found', () => {
    const before = process.env.PATH
    try {
      process.env.PATH = `/bundled/git/bin${process.platform === 'win32' ? ';' : ':'}${before ?? ''}`
      const env = gitExecEnv()
      expect(env.PATH?.startsWith('/bundled/git/bin')).toBe(true)
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
      expect(env.GIT_DIR).toBeUndefined()
    } finally {
      process.env.PATH = before
    }
  })
})
