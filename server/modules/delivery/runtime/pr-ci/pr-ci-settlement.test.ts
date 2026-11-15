import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultGitRunner } from '../../../../worktree-manager'
import type { Exec } from '../pr-publisher'
import { initDb, type DbInstance } from '../../../../db'
import { claimPrCiAdmission, getPrCiAdmission, setPrCiAdmissionWorktree, upsertPrCiAdmission, type PrCiAdmissionRow } from './pr-ci-admission'
import { preservePrCiWip, prCiKeptRef, prCiWipRef, replayPrCiAdmissions, settleAdmissionRun, settlePrCiGeneration } from './pr-ci-settlement'

let root: string, work: string
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd: work, encoding: 'utf8' }).trim()
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pr-ci-settle-')); work = path.join(root, 'work')
  execFileSync('git', ['init', '-q', '-b', 'feature', work])
  writeFileSync(path.join(work, 'a.txt'), 'a\n'); git('add', '.'); git('commit', '-qm', 'pushed')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const view = (over: Record<string, unknown>) => JSON.stringify({ state: 'OPEN', isDraft: true, headRefName: 'feature', baseRefName: 'main', isCrossRepository: false, headRefOid: git('rev-parse', 'HEAD'), mergeCommit: null, commits: [], ...over })
const exec = (stdout: () => string): Exec => ({ run: async () => ({ code: 0, stdout: stdout(), stderr: '' }) })
const unit = { ticketId: 3, branch: 'feature', succeeded: false, implementationOutcome: 'failed' as const, deliveryOutcome: 'not_started' as const, finalSha: 'x', failureCode: 'implementation_failed' as const }
const input = (stdout: () => string, completion: { ok: boolean; reasons: string[] } | null) => ({ git: defaultGitRunner, exec: exec(stdout), baseRepo: work, deliveryId: 'd-ci',
  continuation: { prUrl: 'https://github.com/acme/app/pull/7', branch: 'feature', baseBranch: 'main' }, worktrees: [work], completion, branches: [unit] })

describe('settlePrCiGeneration', () => {
  it('keeps the PR as the deliverable with the CI reason when the loop stops', async () => {
    const head = git('rev-parse', 'HEAD')
    const settled = await settlePrCiGeneration(input(() => view({ isDraft: false }), { ok: false, reasons: ['The remaining failures are not caused by the code (flaky): test X'] }))
    expect(settled).toEqual({ next: 'pr_ready', deliverySha: head, statusCode: 'ci_needs_attention', statusDetail: 'The remaining failures are not caused by the code (flaky): test X', keptRef: null,
      branches: [expect.objectContaining({ succeeded: true, implementationOutcome: 'succeeded', deliveryOutcome: 'ready', finalSha: head, failureCode: null })] })
  })

  it('freezes the ignored-path snapshot of a failed loop once its worktree is clean at the PR head', async () => {
    writeFileSync(path.join(work, '.gitignore'), 'node_modules/\n'); git('add', '.'); git('commit', '-qm', 'ignore')
    execFileSync('mkdir', ['-p', path.join(work, 'node_modules', 'pkg')]); writeFileSync(path.join(work, 'node_modules', 'pkg', 'index.js'), '\n')
    writeFileSync(path.join(work, 'wip.txt'), 'unfinished\n')
    const seen: Array<{ worktree: string; excludes: readonly string[]; dirty: string }> = []
    const capture = async (worktree: string, excludes: readonly string[]) => {
      seen.push({ worktree, excludes, dirty: git('status', '--porcelain') })
      return git('status', '--porcelain', '--ignored=matching').split('\n').filter(line => line.startsWith('!! ')).map(line => line.slice(3).replace(/\/$/, ''))
    }
    const failed = { ...unit, worktreePath: work, overlayExcludes: ['.sr-rail-overlay.json'], settlementIgnoredPaths: null }
    const settled = await settlePrCiGeneration({ ...input(() => view({}), { ok: false, reasons: ['Budget exhausted'] }), branches: [failed], captureIgnoredPaths: capture })
    expect(seen).toEqual([{ worktree: work, excludes: ['.sr-rail-overlay.json'], dirty: '' }])
    expect(settled?.branches[0].settlementIgnoredPaths).toEqual(['node_modules'])
    // A snapshot the ordinary settlement already froze is never replaced.
    seen.length = 0
    const kept = await settlePrCiGeneration({ ...input(() => view({}), { ok: true, reasons: [] }), branches: [{ ...failed, settlementIgnoredPaths: ['dist'] }], captureIgnoredPaths: capture })
    expect(seen).toEqual([])
    expect(kept?.branches[0].settlementIgnoredPaths).toEqual(['dist'])
  })

  it('reports green when Core ended green', async () => {
    expect(await settlePrCiGeneration(input(() => view({}), { ok: true, reasons: ['All checks of the pull request are green.'] }))).toMatchObject({ next: 'pr_draft', statusCode: 'ci_green', statusDetail: null })
  })

  it('moves unverified local commits off the PR branch and keeps them on a delivery ref', async () => {
    const pushed = git('rev-parse', 'HEAD')
    writeFileSync(path.join(work, 'b.txt'), 'unverified\n'); git('add', '.'); git('commit', '-qm', 'unverified')
    const local = git('rev-parse', 'HEAD')
    const settled = await settlePrCiGeneration(input(() => view({ headRefOid: pushed }), { ok: false, reasons: ['Budget exhausted'] }))
    expect(settled).toMatchObject({ deliverySha: pushed, keptRef: prCiKeptRef('d-ci'), statusDetail: expect.stringContaining(prCiKeptRef('d-ci')) })
    expect(git('rev-parse', 'HEAD')).toBe(pushed)
    expect(git('rev-parse', prCiKeptRef('d-ci'))).toBe(local)
  })

  it('sets aside edits a stopped loop never committed, leaving the worktree clean at the PR head', async () => {
    writeFileSync(path.join(work, 'a.txt'), 'edited\n'); writeFileSync(path.join(work, 'new.txt'), 'untracked\n')
    const settled = await settlePrCiGeneration(input(() => view({}), { ok: false, reasons: ['Budget exhausted'] }))
    expect(settled?.statusDetail).toContain(prCiWipRef('d-ci'))
    expect(git('status', '--porcelain')).toBe('')
    expect(git('show', `${prCiWipRef('d-ci')}:a.txt`)).toBe('edited')
    expect(git('show', `${prCiWipRef('d-ci')}^3:new.txt`)).toBe('untracked')
    expect(git('stash', 'list')).toBe('')
    expect(await preservePrCiWip(defaultGitRunner, work, 'd-ci')).toBeNull()
  })

  it('follows a PR someone else moved, keeping local commits the PR does not contain', async () => {
    const base = git('rev-parse', 'HEAD')
    writeFileSync(path.join(work, 'theirs.txt'), 'pushed by someone else\n'); git('add', '.'); git('commit', '-qm', 'theirs')
    const theirs = git('rev-parse', 'HEAD')
    git('reset', '-q', '--hard', base)
    expect(await settlePrCiGeneration(input(() => view({ headRefOid: theirs }), { ok: false, reasons: ['flaky'] }))).toMatchObject({ deliverySha: theirs, keptRef: null })
    expect(git('rev-parse', 'HEAD')).toBe(theirs)
    git('reset', '-q', '--hard', base)
    writeFileSync(path.join(work, 'mine.txt'), 'local only\n'); git('add', '.'); git('commit', '-qm', 'mine')
    const mine = git('rev-parse', 'HEAD')
    expect(await settlePrCiGeneration(input(() => view({ headRefOid: theirs }), { ok: false, reasons: ['flaky'] }))).toMatchObject({ deliverySha: theirs, keptRef: prCiKeptRef('d-ci') })
    expect(git('rev-parse', 'HEAD')).toBe(theirs)
    expect(git('rev-parse', prCiKeptRef('d-ci'))).toBe(mine)
  })

  it('leaves a closed PR, an unreachable PR head or an unverifiable PR to the ordinary settlement', async () => {
    expect(await settlePrCiGeneration(input(() => view({ state: 'CLOSED' }), null))).toBeNull()
    expect(await settlePrCiGeneration(input(() => view({ headRefOid: 'f'.repeat(40) }), null))).toBeNull()
    expect(await settlePrCiGeneration({ ...input(() => '', null), exec: { run: async () => ({ code: 1, stdout: '', stderr: 'gh: offline' }) } })).toBeNull()
  })
})

describe('mission-origin admission settlement', () => {
  let db: DbInstance
  let announced: PrCiAdmissionRow[]
  beforeEach(() => { db = initDb(':memory:'); announced = [] })
  afterEach(() => db.close())

  const startedAdmission = () => {
    const row = upsertPrCiAdmission(db, { projectId: 'p1', repositoryId: 'r-api', repositoryPath: work, prNumber: 7, prUrl: 'https://github.com/acme/app/pull/7',
      headBranch: 'feature', headSha: git('rev-parse', 'HEAD'), baseBranch: 'main', originConversationId: 'c1' })
    claimPrCiAdmission(db, 'p1', row.id, 'run-1')
    setPrCiAdmissionWorktree(db, row.id, work)
    return getPrCiAdmission(db, 'p1', row.id)!
  }
  const task = (seq: number, name: string, outcome: string) => {
    db.prepare("INSERT OR IGNORE INTO jobs (id, command, started_at) VALUES ('run-1', 'pr-ci', 't')").run()
    return db.prepare("INSERT INTO events (job_id, seq, event_type, source, payload) VALUES ('run-1', ?, 'host_task_finished', 'stdout', ?)").run(seq, JSON.stringify({ task: name, outcome }))
  }
  const settlement = (completion: { ok: boolean; reasons: string[] } | null, stdout: () => string = () => view({})) => ({
    db, git: defaultGitRunner, exec: exec(stdout), completionOf: async () => completion, announce: (row: PrCiAdmissionRow) => { announced.push(row) },
  })

  it('[spec:mission-pr-ci-repair/mission-shows-progress-logs-and-result-after-reload] settles green with the pushes and rounds the run recorded, and shows it on the card', async () => {
    const admission = startedAdmission()
    task(1, 'pr.checks', 'red'); task(2, 'pr.sync', 'pushed'); task(3, 'pr.checks', 'green')
    const settled = await settleAdmissionRun(settlement({ ok: true, reasons: [] }), admission)
    expect(settled).toMatchObject({ state: 'green', pushes: 1, rounds: 1, reason: null })
    expect(announced.at(-1)?.state).toBe('green')
  })

  it('[spec:mission-pr-ci-repair/ci-repair-never-merges-or-accepts-work] settling green never merges the PR and leaves the delivery table untouched', async () => {
    const admission = startedAdmission()
    const calls: string[][] = []
    const recording: Exec = { run: async (_cmd, args) => { calls.push(args); return { code: 0, stdout: view({}), stderr: '' } } }
    task(1, 'pr.checks', 'green')
    const before = db.prepare('SELECT COUNT(*) AS n FROM rail_pr_deliveries').get()
    const settled = await settleAdmissionRun({ ...settlement({ ok: true, reasons: [] }), exec: recording }, admission)
    expect(settled).toMatchObject({ state: 'green' })
    expect(calls.some(args => args.includes('merge'))).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM rail_pr_deliveries').get()).toEqual(before)
  })

  it('[spec:mission-pr-ci-repair/mission-shows-progress-logs-and-result-after-reload] reports a PR without checks as no checks, never green', async () => {
    const admission = startedAdmission()
    task(1, 'pr.checks', 'none')
    expect(await settleAdmissionRun(settlement({ ok: true, reasons: [] }), admission)).toMatchObject({ state: 'no-ci' })
  })

  it('[spec:mission-pr-ci-repair/mission-shows-progress-logs-and-result-after-reload] reports the concrete stop reason when the loop stops before green', async () => {
    const admission = startedAdmission()
    const settled = await settleAdmissionRun(settlement({ ok: false, reasons: ['Round budget exhausted'] }), admission)
    expect(settled).toMatchObject({ state: 'needs-attention', reason: 'Round budget exhausted' })
  })

  it('[spec:mission-pr-ci-repair/mission-shows-progress-logs-and-result-after-reload] says so when the PR could not be proven open at the end, instead of claiming a result silently', async () => {
    const admission = startedAdmission()
    const settled = await settleAdmissionRun(settlement({ ok: false, reasons: ['Stopped'] }, () => view({ state: 'CLOSED' })), admission)
    expect(settled.state).toBe('needs-attention')
    expect(settled.reason).toMatch(/could not be proven open/)
  })

  it('[spec:mission-pr-ci-repair/mission-shows-progress-logs-and-result-after-reload] is idempotent: settling or replaying again returns the stored result', async () => {
    const admission = startedAdmission()
    const deps = settlement({ ok: true, reasons: [] })
    const first = await settleAdmissionRun(deps, admission)
    const again = await settleAdmissionRun(deps, admission)
    expect(again).toMatchObject({ state: first.state })
    await replayPrCiAdmissions(deps, 'p1')
    expect(getPrCiAdmission(db, 'p1', admission.id)).toMatchObject({ state: 'green', run_id: 'run-1' })
  })

  it('[spec:mission-pr-ci-repair/mission-shows-progress-logs-and-result-after-reload] replay settles an interrupted admission whose run finished and leaves a running one alone', async () => {
    const admission = startedAdmission()
    db.prepare("INSERT INTO loop_runs (id, project_id, loop_id, status, final_outcome, started_at) VALUES ('run-1', 'p1', 'factory:pr-ci', 'running', NULL, 't')").run()
    await replayPrCiAdmissions(settlement({ ok: true, reasons: [] }), 'p1')
    expect(getPrCiAdmission(db, 'p1', admission.id)?.state).toBe('started')
    db.prepare("UPDATE loop_runs SET status = 'completed', final_outcome = 'success' WHERE id = 'run-1'").run()
    await replayPrCiAdmissions(settlement({ ok: true, reasons: [] }), 'p1')
    expect(getPrCiAdmission(db, 'p1', admission.id)?.state).toBe('green')
  })

  it('[spec:mission-pr-ci-repair/mission-shows-progress-logs-and-result-after-reload] replay returns a claim whose run never existed to its offer with the reason', async () => {
    const admission = startedAdmission()
    await replayPrCiAdmissions(settlement(null), 'p1')
    expect(getPrCiAdmission(db, 'p1', admission.id)).toMatchObject({ state: 'offered', run_id: null })
    expect(getPrCiAdmission(db, 'p1', admission.id)?.reason).toMatch(/restarted/)
  })
})
