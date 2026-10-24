import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import { createRailsRouter } from './rails-router'
import { createPrDelivery, transitionDecision } from './rail-pr-store'
import {
  collectAnnotations, composeDeliveryChanges, composeFileDiff, parseLocationRef, parseNumstat, parseRawDiff, parseUnifiedDiff,
} from './delivery-changes'

vi.mock('../../agent-runtime/runtime/agent-runtime-loader', () => ({ loadCoreAgentRuntime: async () => ({ api: { capabilities: {} } }) }))

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()
}
function write(repo: string, file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  fs.writeFileSync(path.join(repo, file), content)
}

let repo: string
let db: DbInstance
let desktopDb: DbInstance
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-changes-'))
  git(repo, 'init', '-q', '-b', 'main')
  write(repo, 'src/keep.ts', 'a\nb\nc\n')
  write(repo, 'src/old-name.ts', Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n')
  write(repo, 'src/gone.ts', 'bye\n')
  write(repo, 'logo.bin', Buffer.from([0, 1, 2, 3]))
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base')
  git(repo, 'checkout', '-qb', 'feat/x')
  write(repo, 'src/keep.ts', 'a\nB\nc\nd\n')
  write(repo, 'src/new.ts', 'export const n = 1\n')
  fs.rmSync(path.join(repo, 'src/gone.ts'))
  git(repo, 'mv', 'src/old-name.ts', 'src/renamed.ts')
  write(repo, 'logo.bin', Buffer.from([0, 9, 9, 9, 0]))
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'work')
  // The base moves on after the fork: it must not leak into the review.
  git(repo, 'checkout', '-q', 'main')
  write(repo, 'unrelated.ts', 'moved on\n')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'main moves')
  db = initDb(':memory:')
  desktopDb = initDesktopDb(':memory:')
})
afterEach(() => { db.close(); desktopDb.close(); fs.rmSync(repo, { recursive: true, force: true }) })

let railCounter = 0
function delivery(overrides: Record<string, unknown> = {}) {
  const row = createPrDelivery(db, { railIndex: ++railCounter, loopId: 'factory:implement', railKey: `${railCounter}-factory:implement`, ticketIds: [1], baseBranch: 'main', loopName: 'Implement', originSurface: 'dashboard' })
  transitionDecision(db, row.id, 'building', 'on_review', {
    branch: 'feat/x', implementationOutcome: 'succeeded', deliveryOutcome: 'ready', statusCode: 'ready_for_review',
    branches: [{ ticketId: 1, branch: 'feat/x', succeeded: true, changed: true }], ...overrides,
  } as never)
  return db.prepare('SELECT * FROM rail_pr_deliveries WHERE id = ?').get(row.id) as never
}

describe('delivery changes read model', () => {
  it('lists status, counts and hashes against the merge-base (rename, binary, delete)', async () => {
    const changes = await composeDeliveryChanges({ row: delivery(), repoDir: repo })
    if (!changes.available) throw new Error('expected available')
    const byPath = Object.fromEntries(changes.files.map((f) => [f.path, f]))
    expect(Object.keys(byPath).sort()).toEqual(['logo.bin', 'src/gone.ts', 'src/keep.ts', 'src/new.ts', 'src/renamed.ts'])
    expect(byPath['unrelated.ts']).toBeUndefined()
    expect(byPath['src/new.ts']).toMatchObject({ status: 'added', additions: 1, deletions: 0, binary: false })
    expect(byPath['src/gone.ts']).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 })
    expect(byPath['src/keep.ts']).toMatchObject({ status: 'modified', additions: 2, deletions: 1 })
    expect(byPath['src/renamed.ts']).toMatchObject({ status: 'renamed', oldPath: 'src/old-name.ts', additions: 0, deletions: 0 })
    expect(byPath['logo.bin']).toMatchObject({ binary: true, additions: null, deletions: null })
    expect(changes.totals).toEqual({ files: 5, additions: 3, deletions: 2 })
    expect(changes.sources).toEqual([{ id: 'delivery', ticketId: null, branch: 'feat/x' }])
    expect(byPath['src/keep.ts'].hash).toMatch(/^[0-9a-f]{16}\.\.[0-9a-f]{16}$/)
  })

  it('parses one file lazily into numbered hunks and flags binary files', async () => {
    const row = delivery()
    const diff = await composeFileDiff({ row, repoDir: repo, path: 'src/keep.ts' })
    if (!diff.ok) throw new Error('expected ok')
    expect(diff.diff.hunks).toHaveLength(1)
    expect(diff.diff.hunks[0].lines).toEqual([
      { type: 'context', oldNo: 1, newNo: 1, text: 'a' },
      { type: 'delete', oldNo: 2, newNo: null, text: 'b' },
      { type: 'add', oldNo: null, newNo: 2, text: 'B' },
      { type: 'context', oldNo: 3, newNo: 3, text: 'c' },
      { type: 'add', oldNo: null, newNo: 4, text: 'd' },
    ])
    const binary = await composeFileDiff({ row, repoDir: repo, path: 'logo.bin' })
    expect(binary).toMatchObject({ ok: true, diff: { binary: true, hunks: [] } })
  })

  it('only hands git a path the diff lists', async () => {
    const row = delivery()
    expect(await composeFileDiff({ row, repoDir: repo, path: '../../etc/passwd' })).toMatchObject({ ok: false, status: 404 })
    expect(await composeFileDiff({ row, repoDir: repo, path: 'unrelated.ts' })).toMatchObject({ ok: false, status: 404 })
  })

  it('resolves the base from the settled sha and falls back per reason', async () => {
    expect(await composeDeliveryChanges({ row: delivery({ branch: 'gone/branch', branches: [] }), repoDir: repo })).toMatchObject({ available: false, reason: 'head_missing' })
    expect(await composeDeliveryChanges({ row: delivery({ branch: null, branches: [] }), repoDir: repo })).toMatchObject({ available: false, reason: 'no_branch' })
    const noBase = { ...delivery(), base_branch: 'nope' }
    expect(await composeDeliveryChanges({ row: noBase, repoDir: repo })).toMatchObject({ available: false, reason: 'base_missing' })
    expect(await composeDeliveryChanges({ row: delivery(), repoDir: os.tmpdir() })).toMatchObject({ available: false, reason: 'not_a_repository' })
  })

  it('lists per-ticket sources when no assembled branch exists and honours the chosen one', async () => {
    const row = delivery({
      branch: null,
      branches: [{ ticketId: 1, branch: 'feat/x', succeeded: true, changed: true }, { ticketId: 2, branch: 'feat/none', succeeded: true, changed: false }],
    })
    const changes = await composeDeliveryChanges({ row, repoDir: repo })
    expect(changes).toMatchObject({ available: true, source: 'ticket:1' })
    if (changes.available) expect(changes.sources.map((s) => s.id)).toEqual(['ticket:1'])
  })

  it('never reads a ref as an option', async () => {
    const row = { ...delivery({ branches: [] }), branch: '--output=/tmp/pwn' }
    expect(await composeDeliveryChanges({ row, repoDir: repo })).toMatchObject({ available: false, reason: 'no_branch' })
  })
})

describe('diff parsers', () => {
  it('parses -z raw and numstat output including renames', () => {
    const sha = 'a'.repeat(40)
    const raw = `:100644 100644 ${sha} ${'b'.repeat(40)} M\0src/a.ts\0:100644 100644 ${sha} ${sha} R090\0old.ts\0new.ts\0`
    expect(parseRawDiff(raw)).toEqual([
      { status: 'modified', path: 'src/a.ts', oldPath: null, oldSha: sha, newSha: 'b'.repeat(40) },
      { status: 'renamed', path: 'new.ts', oldPath: 'old.ts', oldSha: sha, newSha: sha },
    ])
    const counts = parseNumstat('3\t1\tsrc/a.ts\0-\t-\tbin.png\0' + '0\t0\t\0old.ts\0new.ts\0')
    expect(counts.get('src/a.ts')).toEqual({ additions: 3, deletions: 1 })
    expect(counts.get('bin.png')).toEqual({ additions: null, deletions: null })
    expect(counts.get('new.ts')).toEqual({ additions: 0, deletions: 0 })
  })

  it('caps a huge diff and reports the true size', () => {
    const body = '@@ -0,0 +1,50 @@\n' + Array.from({ length: 50 }, (_, i) => `+l${i}`).join('\n') + '\n\\ No newline at end of file\n'
    const capped = parseUnifiedDiff(body, 10)
    expect(capped.truncated).toBe(true)
    expect(capped.totalLines).toBe(50)
    expect(capped.hunks[0].lines).toHaveLength(10)
    const full = parseUnifiedDiff(body, 100)
    expect(full.truncated).toBe(false)
    expect(full.hunks[0].lines.at(-1)?.noNewline).toBe(true)
  })

  it('reads a bare path[:line[-end]] reference and rejects prose', () => {
    expect(parseLocationRef('src/a.ts:12-18')).toEqual({ path: 'src/a.ts', line: 12, endLine: 18 })
    expect(parseLocationRef('./src/a.ts')).toEqual({ path: 'src/a.ts', line: null, endLine: null })
    expect(parseLocationRef('see the auth flow')).toBeNull()
    expect(parseLocationRef('../x.ts:1')).toBeNull()
    expect(parseLocationRef(null)).toBeNull()
  })
})

describe('annotations', () => {
  const evidence = (extra: Record<string, unknown>) => JSON.stringify({
    schemaVersion: 1, harvest: 'ok', harvestedAt: 'x',
    units: [{
      ticketId: 1, runId: 'r', sentinel: 'pass', sentinelDetail: null, verifyTail: null, confidence: null,
      runtime: { commands: [], checks: [], review: null, findings: ['Null deref', 'Style nit'], findingLocations: [{ finding: 0, path: 'src/keep.ts', line: 2 }], ...extra },
      reviewBrief: { source: 'pipeline', approved: true, score: 90, recordedAt: null, diagnostic: null, droppedEntries: 0, brief: {
        behaviourChanges: [], invariantsTouched: [], humanChecks: [], divergences: [],
        untested: [{ path: 'src/new.ts', why: 'No test' }],
        risks: [{ severity: 'high', area: null, whatToLookAt: 'Check the guard', ref: 'src/keep.ts:3' }, { severity: 'low', area: null, whatToLookAt: 'Vague', ref: 'somewhere in auth' }],
      } },
    }],
  })

  it('anchors located findings and keeps the rest unanchored', () => {
    const out = collectAnnotations({ settle_evidence: evidence({}), follow_up: null })
    expect(out.find((a) => a.id === 'finding:1:0')).toMatchObject({ source: 'reviewer-finding', location: { path: 'src/keep.ts', line: 2, endLine: null } })
    expect(out.find((a) => a.id === 'finding:1:1')).toMatchObject({ location: null })
    expect(out.find((a) => a.id === 'risk:1:0')).toMatchObject({ severity: 'high', location: { path: 'src/keep.ts', line: 3 } })
    expect(out.find((a) => a.id === 'risk:1:1')).toMatchObject({ location: null })
    expect(out.find((a) => a.id === 'untested:1:0')).toMatchObject({ location: { path: 'src/new.ts', line: null } })
  })

  it('old evidence without locations renders every finding unanchored', () => {
    const out = collectAnnotations({ settle_evidence: evidence({ findingLocations: undefined }), follow_up: null })
    expect(out.filter((a) => a.source === 'reviewer-finding').every((a) => a.location === null)).toBe(true)
  })
})

describe('GET /rails/pr-deliveries/:id/changes', () => {
  function app(projectPath: string, database: DbInstance) {
    const instance = express()
    instance.use((req, _res, next) => {
      ;(req as unknown as { projectCtx: unknown }).projectCtx = {
        db: database, desktopDb, railJobs: new Map(), railLoopRuns: new Map(),
        project: { id: 'p', slug: 'p', provider: 'claude', providers: ['claude'], path: projectPath },
        broadcast: () => {}, loopRunManager: { run: vi.fn(), cancel: vi.fn() }, getTicketSpec: () => null, onLoopRunFinished: () => {},
      }
      next()
    })
    instance.use('/rails', createRailsRouter())
    return instance
  }

  it('serves the list and one file, and 404s outside the project', async () => {
    const row = delivery() as { id: string }
    const list = await request(app(repo, db)).get(`/rails/pr-deliveries/${row.id}/changes`)
    expect(list.status).toBe(200)
    expect(list.body.changes.files.map((f: { path: string }) => f.path)).toContain('src/keep.ts')
    const file = await request(app(repo, db)).get(`/rails/pr-deliveries/${row.id}/changes/file`).query({ path: 'src/keep.ts' })
    expect(file.status).toBe(200)
    expect(file.body.diff.hunks[0].lines.length).toBeGreaterThan(0)
    expect((await request(app(repo, db)).get(`/rails/pr-deliveries/${row.id}/changes/file`)).status).toBe(400)
    expect((await request(app(repo, db)).get(`/rails/pr-deliveries/${row.id}/changes?source=--x`)).status).toBe(400)
    // Project isolation: another project's database does not know this delivery.
    const other = initDb(':memory:')
    expect((await request(app(repo, other)).get(`/rails/pr-deliveries/${row.id}/changes`)).status).toBe(404)
    other.close()
  })
})
