// proactive-local-integration: "Integrate locally" saves the person's
// overlapping uncommitted work as a stash, integrates, and restores it —
// against a REAL temporary Git repository.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import express from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from '../../../db'
import { executePrDecision, recoverLocalStashes, runRestoreLocalChanges, type PrDecisionDeps } from './rail-pr-decision'
import { createPrDelivery, getPrDelivery, readLocalStash, setPrDeliveryLocalStash, toPrDeliverySnapshot, transitionDecision } from './rail-pr-store'
import { localStashMessage, pathsOverlap, saveLocalChanges } from './local-stash'
import { buildLocalChangesBriefing } from '../adapters/decisions/local-changes'
import { createRailsRouter } from './rails-router'
import { withRepoLock } from '../../../repo-lock'
import type { GitRunner } from '../../../worktree-manager'

let root: string
let repo: string
let db: DbInstance
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Specrails Test', GIT_AUTHOR_EMAIL: 'specrails@example.test',
  GIT_COMMITTER_NAME: 'Specrails Test', GIT_COMMITTER_EMAIL: 'specrails@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
}
function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim()
}
const realGit: GitRunner = {
  async run(args, cwd) {
    try {
      return { code: 0, stdout: execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }), stderr: '' }
    } catch (err) {
      const failure = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer }
      return { code: failure.status ?? 1, stdout: failure.stdout?.toString() ?? '', stderr: failure.stderr?.toString() ?? '' }
    }
  },
}
function write(name: string, content: string, cwd = repo): void {
  fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true })
  fs.writeFileSync(path.join(cwd, name), content)
}
function read(name: string, cwd = repo): string { return fs.readFileSync(path.join(cwd, name), 'utf8') }
const LINES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n') + '\n'
function feature(file: string, content: string): string {
  git(['switch', '-c', 'feat/delivery', 'main'])
  write(file, content)
  git(['add', '--', file])
  git(['commit', '-m', 'feature'])
  const sha = git(['rev-parse', 'HEAD'])
  git(['switch', 'main'])
  return sha
}
function delivery(sha: string) {
  const row = createPrDelivery(db, {
    railIndex: 0, railKey: '0-factory:implement', loopId: 'factory:implement',
    ticketIds: [7], baseBranch: 'main', loopName: 'Implement', originSurface: 'agent-chat', originConversationId: 'conv-1',
  })
  transitionDecision(db, row.id, 'building', 'on_review', {
    branch: 'feat/delivery', deliverySha: sha, implementationOutcome: 'succeeded', deliveryOutcome: 'ready',
    branches: [{ ticketId: 7, branch: 'feat/delivery', finalSha: sha, succeeded: true, branchOwnership: 'created' }],
  })
  return row
}
const startAutomaticTurn = vi.fn(async () => 'started' as const)
function deps(): PrDecisionDeps {
  return {
    db, project: { id: 'local-project', slug: 'local-project', path: repo }, git: realGit,
    exec: { run: vi.fn().mockRejectedValue(new Error('Local integration must never call GitHub')) },
    broadcast: vi.fn(), ticketFile: path.join(root, 'tickets.json'), assemblyRoot: path.join(root, 'assembly'),
    agentChat: () => null, missionAgent: () => ({ startAutomaticTurn }),
  }
}
const integrate = (id: string) => executePrDecision(deps(), { prDeliveryId: id, action: 'merge-local', expectedDecision: 'on_review' })
const stashes = () => git(['stash', 'list', '--format=%H']).split('\n').filter(Boolean)
const userStatus = () => git(['status', '--porcelain', '--untracked-files=all'])

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-local-stash-'))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  db = initDb(':memory:')
  startAutomaticTurn.mockClear()
  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'Specrails Test'])
  git(['config', 'user.email', 'specrails@example.test'])
  write('tracked.txt', LINES)
  write('.gitignore', 'cache/\n')
  git(['add', '.'])
  git(['commit', '-m', 'base'])
  write('tickets.json', JSON.stringify({ schema_version: '1.3', revision: 1, next_id: 1, tickets: {} }), root)
})
afterEach(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('pathsOverlap', () => {
  it('matches exact, nested and case-folded paths only', () => {
    expect(pathsOverlap(['a.txt'], ['a.txt'])).toBe(true)
    expect(pathsOverlap(['README.md'], ['readme.md'])).toBe(true)
    expect(pathsOverlap(['dir/x.txt'], ['dir'])).toBe(true)
    expect(pathsOverlap(['other.txt'], ['a.txt'])).toBe(false)
    expect(pathsOverlap([], ['a.txt'])).toBe(false)
  })
})

describe('Integrate locally with overlapping local changes (real Git)', () => {
  it('saves, integrates and restores cleanly, then drops the stash', async () => {
    const sha = feature('tracked.txt', LINES.replace('one', 'ONE (delivery)'))
    const row = delivery(sha)
    write('tracked.txt', LINES.replace('eight', 'eight (my edit)'))
    write('notes/new.txt', 'untracked draft\n')
    const result = await integrate(row.id)
    expect(result.status).toBe(200)
    expect(result.body.localChanges).toMatchObject({ state: 'restored', stashName: localStashMessage([7], row.id) })
    expect(read('tracked.txt')).toBe(LINES.replace('one', 'ONE (delivery)').replace('eight', 'eight (my edit)'))
    expect(read('notes/new.txt')).toBe('untracked draft\n')
    expect(git(['merge-base', '--is-ancestor', sha, 'main'])).toBe('')
    expect(stashes()).toEqual([])
    const after = getPrDelivery(db, row.id)!
    expect(after.decision).toBe('merged')
    expect(after.status_code).toBe('merged')
    expect(readLocalStash(after.local_stash)?.state).toBe('restored')
    expect(toPrDeliverySnapshot(after).localStash).toMatchObject({ state: 'restored', branch: 'main' })
    expect(toPrDeliverySnapshot(after).localStash).not.toHaveProperty('checkoutPath')
    expect(startAutomaticTurn).not.toHaveBeenCalled()
  })

  it('keeps non-overlapping dirty work in place without stashing (unchanged behaviour)', async () => {
    const sha = feature('feature.txt', 'feature\n')
    const row = delivery(sha)
    write('tracked.txt', LINES.replace('two', 'two (mine)'))
    const result = await integrate(row.id)
    expect(result.status).toBe(200)
    expect(result.body.localChanges).toBeUndefined()
    expect(read('tracked.txt')).toBe(LINES.replace('two', 'two (mine)'))
    expect(stashes()).toEqual([])
    expect(getPrDelivery(db, row.id)!.local_stash ?? null).toBeNull()
  })

  it('on a conflicting restore keeps the stash, restores the integrated tree and briefs the agent', async () => {
    const sha = feature('tracked.txt', LINES.replace('one', 'ONE (delivery)'))
    const row = delivery(sha)
    write('tracked.txt', LINES.replace('one', 'one (my conflicting edit)'))
    write('cache/private.txt', 'ignored work\n')
    const result = await integrate(row.id)
    expect(result.status).toBe(200)
    expect(result.body.localChanges).toMatchObject({ state: 'needs_attention', conflictPaths: ['tracked.txt'] })
    // Integrated tree, nothing half-applied, ignored data untouched.
    expect(read('tracked.txt')).toBe(LINES.replace('one', 'ONE (delivery)'))
    expect(userStatus()).toBe('')
    expect(read('cache/private.txt')).toBe('ignored work\n')
    expect(git(['rev-parse', 'HEAD'])).toBe(git(['rev-parse', 'main']))
    // The person's work survives in the stash, by sha.
    const record = readLocalStash(getPrDelivery(db, row.id)!.local_stash)!
    expect(stashes()).toEqual([record.sha])
    expect(git(['show', `${record.sha}:tracked.txt`])).toContain('one (my conflicting edit)')
    expect(record).toMatchObject({ state: 'needs_attention', restoreBranch: `specrails/restore-local-${record.sha.slice(0, 8)}` })
    const after = getPrDelivery(db, row.id)!
    expect(after.decision).toBe('merged')
    expect(after.delivery_outcome).toBe('delivered')
    expect(after.status_code).toBe('local_changes_attention')
    expect(startAutomaticTurn).toHaveBeenCalledTimes(1)
    const [conversationId, text, opts] = startAutomaticTurn.mock.calls[0] as unknown as [string, string, { turnKey: string }]
    expect(conversationId).toBe('conv-1')
    expect(opts.turnKey).toBe(`local-changes:${row.id}`)
    expect(text).toContain(record.sha)
    expect(text).toContain(record.restoreBranch!)
    expect(text).toContain('never run `git stash drop`')
  })

  it('keeps an untracked collision in the stash instead of refusing', async () => {
    const sha = feature('collision.txt', 'implemented\n')
    const row = delivery(sha)
    write('collision.txt', 'precious local work\n')
    const result = await integrate(row.id)
    expect(result.status).toBe(200)
    expect(result.body.localChanges).toMatchObject({ state: 'needs_attention' })
    expect(read('collision.txt')).toBe('implemented\n')
    const record = readLocalStash(getPrDelivery(db, row.id)!.local_stash)!
    expect(git(['show', `${record.sha}^3:collision.txt`])).toBe('precious local work')
    expect(userStatus()).toBe('')
  })

  it('Restore is idempotent while conflicting and releases once the person resolved the stash', async () => {
    const sha = feature('tracked.txt', LINES.replace('one', 'ONE (delivery)'))
    const row = delivery(sha)
    write('tracked.txt', LINES.replace('one', 'one (mine)'))
    await integrate(row.id)
    const record = readLocalStash(getPrDelivery(db, row.id)!.local_stash)!
    for (let i = 0; i < 2; i++) {
      const retry = await runRestoreLocalChanges(deps(), row.id)
      expect(retry).toMatchObject({ status: 200, body: { localChanges: { state: 'needs_attention' } } })
      expect(stashes()).toEqual([record.sha])
      expect(userStatus()).toBe('')
    }
    // The person (or the agent on its branch) took care of it and dropped it.
    git(['stash', 'drop'])
    const released = await runRestoreLocalChanges(deps(), row.id)
    expect(released).toMatchObject({ status: 200, body: { localChanges: { state: 'released' } } })
    expect(getPrDelivery(db, row.id)!.status_code).toBe('merged')
    expect(startAutomaticTurn).toHaveBeenCalledTimes(1)
  })

  it('Restore applies cleanly once the conflict is gone and refuses during another operation', async () => {
    const sha = feature('tracked.txt', LINES.replace('one', 'ONE (delivery)'))
    const row = delivery(sha)
    write('tracked.txt', LINES.replace('one', 'one (mine)'))
    await integrate(row.id)
    db.prepare(`UPDATE rail_pr_deliveries SET operation = 'merge-local', operation_token = 'other' WHERE id = ?`).run(row.id)
    expect(await runRestoreLocalChanges(deps(), row.id)).toMatchObject({ status: 409, body: { error: 'operation_in_progress' } })
    db.prepare(`UPDATE rail_pr_deliveries SET operation = NULL, operation_token = NULL WHERE id = ?`).run(row.id)
    // The person reverts the conflicting line on main; now the stash applies.
    write('tracked.txt', LINES)
    git(['commit', '-am', 'revert delivery line'])
    const restored = await runRestoreLocalChanges(deps(), row.id)
    expect(restored).toMatchObject({ status: 200, body: { localChanges: { state: 'restored' } } })
    expect(read('tracked.txt')).toBe(LINES.replace('one', 'one (mine)'))
    expect(stashes()).toEqual([])
    expect(getPrDelivery(db, row.id)!.status_code).toBe('merged')
  })

  it('waits for the repository lock before restoring', async () => {
    const sha = feature('tracked.txt', LINES.replace('one', 'ONE (delivery)'))
    const row = delivery(sha)
    write('tracked.txt', LINES.replace('one', 'one (mine)'))
    await integrate(row.id)
    const order: string[] = []
    let release!: () => void
    const held = withRepoLock(repo, () => new Promise<void>((resolve) => { release = () => { order.push('lock released'); resolve() } }))
    const restore = runRestoreLocalChanges(deps(), row.id).then((r) => { order.push('restore done'); return r })
    await new Promise((r) => setTimeout(r, 20))
    release()
    await held
    await restore
    expect(order).toEqual(['lock released', 'restore done'])
  })
})

describe('startup recovery of saved local changes (real Git)', () => {
  it('re-applies a recorded stash that was saved but never restored', async () => {
    const sha = feature('feature.txt', 'feature\n')
    const row = delivery(sha)
    write('tracked.txt', LINES.replace('three', 'three (mine)'))
    const saved = await saveLocalChanges({ git: realGit, repo, branch: 'main', deliveryId: row.id, ticketIds: [7] })
    if (!saved.ok) throw new Error(saved.detail)
    setPrDeliveryLocalStash(db, row.id, saved.record)
    expect(read('tracked.txt')).toBe(LINES)
    expect(await recoverLocalStashes(deps())).toEqual([row.id])
    expect(read('tracked.txt')).toBe(LINES.replace('three', 'three (mine)'))
    expect(stashes()).toEqual([])
    expect(readLocalStash(getPrDelivery(db, row.id)!.local_stash)?.state).toBe('restored')
    // Idempotent: a second pass touches nothing.
    expect(await recoverLocalStashes(deps())).toEqual([])
    expect(read('tracked.txt')).toBe(LINES.replace('three', 'three (mine)'))
  })

  it('adopts a Specrails stash whose record never landed (crash right after git stash push)', async () => {
    const sha = feature('feature.txt', 'feature\n')
    const row = delivery(sha)
    write('draft.txt', 'untracked draft\n')
    const saved = await saveLocalChanges({ git: realGit, repo, branch: 'main', deliveryId: row.id, ticketIds: [7] })
    expect(saved.ok).toBe(true)
    expect(fs.existsSync(path.join(repo, 'draft.txt'))).toBe(false)
    expect(await recoverLocalStashes(deps())).toEqual([row.id])
    expect(read('draft.txt')).toBe('untracked draft\n')
    expect(stashes()).toEqual([])
  })

  it('only drops a stash that was already applied before the crash', async () => {
    const sha = feature('feature.txt', 'feature\n')
    const row = delivery(sha)
    write('tracked.txt', LINES.replace('four', 'four (mine)'))
    const saved = await saveLocalChanges({ git: realGit, repo, branch: 'main', deliveryId: row.id, ticketIds: [7] })
    if (!saved.ok) throw new Error(saved.detail)
    setPrDeliveryLocalStash(db, row.id, saved.record)
    git(['stash', 'apply', saved.record.sha])
    expect(await recoverLocalStashes(deps())).toEqual([row.id])
    expect(read('tracked.txt')).toBe(LINES.replace('four', 'four (mine)'))
    expect(stashes()).toEqual([])
  })

  it('never applies onto another branch the person switched to meanwhile', async () => {
    const sha = feature('feature.txt', 'feature\n')
    const row = delivery(sha)
    write('tracked.txt', LINES.replace('five', 'five (mine)'))
    const saved = await saveLocalChanges({ git: realGit, repo, branch: 'main', deliveryId: row.id, ticketIds: [7] })
    if (!saved.ok) throw new Error(saved.detail)
    setPrDeliveryLocalStash(db, row.id, saved.record)
    git(['switch', '-c', 'elsewhere'])
    expect(await recoverLocalStashes(deps())).toEqual([])
    expect(read('tracked.txt')).toBe(LINES)
    expect(stashes()).toEqual([saved.record.sha])
    expect(readLocalStash(getPrDelivery(db, row.id)!.local_stash)?.state).toBe('saved')
  })
})

describe('POST /rails/pr-local-changes/restore', () => {
  function app() {
    const a = express(); a.use(express.json())
    a.use((req, _res, next) => {
      ;(req as unknown as { projectCtx: unknown }).projectCtx = {
        db, project: { id: 'local-project', slug: 'local-project', path: repo }, broadcast: vi.fn(),
        railJobs: new Map(), railLoopRuns: new Map(),
      }
      next()
    })
    a.use('/rails', createRailsRouter())
    return a
  }

  it('validates input, reports unknown deliveries and restores with the authoritative snapshot', async () => {
    expect((await request(app()).post('/rails/pr-local-changes/restore').send({})).status).toBe(400)
    expect((await request(app()).post('/rails/pr-local-changes/restore').send({ prDeliveryId: 'nope' })).status).toBe(404)
    const sha = feature('feature.txt', 'feature\n')
    const row = delivery(sha)
    expect((await request(app()).post('/rails/pr-local-changes/restore').send({ prDeliveryId: row.id })).body).toMatchObject({ error: 'no_local_changes' })
    write('tracked.txt', LINES.replace('six', 'six (mine)'))
    const saved = await saveLocalChanges({ git: realGit, repo, branch: 'main', deliveryId: row.id, ticketIds: [7] })
    if (!saved.ok) throw new Error(saved.detail)
    setPrDeliveryLocalStash(db, row.id, saved.record)
    const res = await request(app()).post('/rails/pr-local-changes/restore').send({ prDeliveryId: row.id })
    expect(res.status).toBe(200)
    expect(res.body.localChanges.state).toBe('restored')
    expect(res.body.snapshot.localStash.state).toBe('restored')
    expect(read('tracked.txt')).toBe(LINES.replace('six', 'six (mine)'))
  })

  it('answers 409 with the reason when the checkout is on another branch', async () => {
    const sha = feature('feature.txt', 'feature\n')
    const row = delivery(sha)
    write('tracked.txt', LINES.replace('six', 'six (mine)'))
    const saved = await saveLocalChanges({ git: realGit, repo, branch: 'main', deliveryId: row.id, ticketIds: [7] })
    if (!saved.ok) throw new Error(saved.detail)
    setPrDeliveryLocalStash(db, row.id, saved.record)
    git(['switch', '-c', 'elsewhere'])
    const res = await request(app()).post('/rails/pr-local-changes/restore').send({ prDeliveryId: row.id })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: 'local_restore_blocked', reason: 'wrong_branch', current: 'elsewhere', base: 'main' })
  })
})

describe('buildLocalChangesBriefing', () => {
  it('names the stash, the restore branch and forbids dropping', () => {
    const text = buildLocalChangesBriefing({
      deliveryId: 'd1', ticketIds: [3, 4], branch: 'main',
      record: { sha: 'a'.repeat(40), name: 'specrails: before integrating #3, #4 (d1)', checkoutPath: '/x', branch: 'main', state: 'needs_attention', restoreBranch: null, conflictPaths: [], savedAt: '', updatedAt: '' },
    })
    expect(text).toContain('#3, #4')
    expect(text).toContain('specrails/restore-local-aaaaaaaa')
    expect(text).toContain('git stash apply ' + 'a'.repeat(40))
    expect(text).toContain('(git reported no unmerged path)')
  })
})
