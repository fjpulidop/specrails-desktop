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
import { executePrDecision, recoverLocalStashes, runBringBackLocalChanges, runDiscardRestoreBranch, runRestoreLocalChanges, waitForLocalRestores, type PrDecisionDeps } from './rail-pr-decision'
import { createPrDelivery, getPrDelivery, readLocalStash, setPrDeliveryLocalStash, toPrDeliverySnapshot, transitionDecision } from './rail-pr-store'
import { isSpecrailsManagedPath, localStashMessage, pathsOverlap, saveLocalChanges } from './local-stash'
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
type ResolverInput = Parameters<NonNullable<PrDecisionDeps['localRestoreResolver']>>[0]
/** Fake write-capable resolver: by default keeps both sides of each conflict block. */
const resolver = vi.fn(async (input: ResolverInput) => {
  for (const file of input.conflictPaths) {
    const abs = path.join(input.worktreePath, file)
    const text = fs.readFileSync(abs, 'utf8')
    fs.writeFileSync(abs, text.replace(/^<{7}[^\n]*\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7}[^\n]*\n/m, (_m, ours: string, theirs: string) => `${ours}${theirs}`))
  }
})
function deps(): PrDecisionDeps {
  return {
    db, project: { id: 'local-project', slug: 'local-project', path: repo }, git: realGit,
    exec: { run: vi.fn().mockRejectedValue(new Error('Local integration must never call GitHub')) },
    broadcast: vi.fn(), ticketFile: path.join(root, 'tickets.json'), assemblyRoot: path.join(root, 'assembly'),
    agentChat: () => null, missionAgent: () => ({ startAutomaticTurn }), localRestoreResolver: resolver,
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
  resolver.mockClear()
  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'Specrails Test'])
  git(['config', 'user.email', 'specrails@example.test'])
  write('tracked.txt', LINES)
  write('.gitignore', 'cache/\n')
  git(['add', '.'])
  git(['commit', '-m', 'base'])
  write('tickets.json', JSON.stringify({ schema_version: '1.3', revision: 1, next_id: 1, tickets: {} }), root)
})
afterEach(async () => {
  await waitForLocalRestores()
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
    expect(text).toContain(record.restoreBranch!)
    expect(text).toContain('no action needed from you')
    expect(text).not.toMatch(/git (worktree add|stash apply)/)
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
    await waitForLocalRestores()
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
    await waitForLocalRestores()
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
    await waitForLocalRestores()
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
  it('only reports status to the read-only mission: no write instructions', () => {
    const text = buildLocalChangesBriefing({
      deliveryId: 'd1', ticketIds: [3, 4], branch: 'main',
      record: { sha: 'a'.repeat(40), name: 'specrails: before integrating #3, #4 (d1)', checkoutPath: '/x', branch: 'main', state: 'needs_attention', restoreBranch: null, conflictPaths: [], savedAt: '', updatedAt: '' },
    })
    expect(text).toContain('#3, #4')
    expect(text).toContain('specrails/restore-local-aaaaaaaa')
    expect(text).toContain('Specrails itself is restoring')
    expect(text).toContain('You are read-only here')
    expect(text).toContain('(git reported no unmerged path)')
    // Never hands the agent git commands to run.
    expect(text).not.toMatch(/`git (worktree|stash apply|commit)/)
  })
})

describe('isSpecrailsManagedPath', () => {
  it('matches OpenSpec-generated skills and commands for any tool dir only', () => {
    expect(isSpecrailsManagedPath('.claude/skills/openspec-explore/SKILL.md')).toBe(true)
    expect(isSpecrailsManagedPath('.codex/skills/openspec-apply-change/SKILL.md')).toBe(true)
    expect(isSpecrailsManagedPath('.agents/skills/openspec-propose/SKILL.md')).toBe(true)
    expect(isSpecrailsManagedPath('.claude/commands/opsx/apply.md')).toBe(true)
    expect(isSpecrailsManagedPath('.github/prompts/opsx-apply.prompt.md')).toBe(true)
    expect(isSpecrailsManagedPath('.claude/skills/my-skill/SKILL.md')).toBe(false)
    expect(isSpecrailsManagedPath('skills/openspec-explore/SKILL.md')).toBe(false)
    expect(isSpecrailsManagedPath('src/openspec-x.ts')).toBe(false)
    expect(isSpecrailsManagedPath('CLAUDE.md')).toBe(false)
  })
})

describe('server-side restoration of a conflicting stash (real Git)', () => {
  const SKILL = '.claude/skills/openspec-explore/SKILL.md'
  const recordOf = (id: string) => readLocalStash(getPrDelivery(db, id)!.local_stash)!
  const branchExists = (name: string) => {
    try { git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]); return true } catch { return false }
  }

  it('(a) applies cleanly in its own worktree, commits there and brings it back only on request', async () => {
    // The delivery adds a file the person also created (identical content):
    // the checkout apply is refused (untracked would be overwritten), the
    // worktree apply is not.
    const sha = feature('shared.txt', 'same\n')
    const row = delivery(sha)
    write('shared.txt', 'same\n')
    write('tracked.txt', LINES.replace('eight', 'eight (my edit)'))
    const integrated = await integrate(row.id)
    expect(integrated.body.localChanges).toMatchObject({ state: 'needs_attention' })
    await waitForLocalRestores()
    const record = recordOf(row.id)
    expect(record.restore).toMatchObject({ status: 'ready', resolvedBy: 'clean', branch: `specrails/restore-local-${record.sha.slice(0, 8)}` })
    expect(resolver).not.toHaveBeenCalled()
    expect(record.restore!.files.map((f) => f.path)).toEqual(['tracked.txt'])
    expect(git(['log', '-1', '--format=%s', record.restore!.branch])).toBe('Restore local changes from before integrating #7')
    // Nothing touched main or the stash yet.
    const mainBefore = git(['rev-parse', 'main'])
    expect(read('tracked.txt')).toBe(LINES)
    expect(stashes()).toEqual([record.sha])
    expect(toPrDeliverySnapshot(getPrDelivery(db, row.id)!).localStash?.restore).not.toHaveProperty('worktreePath')

    const back = await runBringBackLocalChanges(deps(), row.id)
    expect(back).toMatchObject({ status: 200, body: { localChanges: { state: 'restored', restore: { status: 'brought_back' } } } })
    expect(git(['rev-parse', 'main'])).not.toBe(mainBefore)
    expect(git(['rev-parse', 'main'])).toBe(record.restore!.commitSha)
    expect(read('tracked.txt')).toBe(LINES.replace('eight', 'eight (my edit)'))
    expect(userStatus()).toBe('')
    expect(stashes()).toEqual([])
    expect(branchExists(record.restore!.branch)).toBe(false)
    expect(fs.existsSync(record.restore!.worktreePath)).toBe(false)
    expect(getPrDelivery(db, row.id)!.status_code).toBe('merged')
    // Idempotent.
    expect(await runBringBackLocalChanges(deps(), row.id)).toMatchObject({ status: 200 })
  })

  it('(b) hands remaining conflicts to the write-capable resolver confined to the worktree, then commits', async () => {
    const sha = feature('tracked.txt', LINES.replace('one', 'ONE (delivery)'))
    const row = delivery(sha)
    write('tracked.txt', LINES.replace('one', 'one (mine)'))
    await integrate(row.id)
    await waitForLocalRestores()
    expect(resolver).toHaveBeenCalledTimes(1)
    const input = resolver.mock.calls[0][0]
    const record = recordOf(row.id)
    expect(input).toMatchObject({ branch: record.restore!.branch, targetBranch: 'main', conflictPaths: ['tracked.txt'] })
    expect(input.worktreePath).toBe(record.restore!.worktreePath)
    expect(input.worktreePath.startsWith(path.join(root, 'assembly'))).toBe(true)
    expect(record.restore).toMatchObject({ status: 'ready', resolvedBy: 'resolver', conflictPaths: ['tracked.txt'] })
    expect(git(['show', `${record.restore!.commitSha}:tracked.txt`])).toBe(LINES.replace('one', 'ONE (delivery)\none (mine)').trimEnd())
    // The person's checkout stays exactly as integrated; the stash is kept.
    expect(read('tracked.txt')).toBe(LINES.replace('one', 'ONE (delivery)'))
    expect(userStatus()).toBe('')
    expect(stashes()).toEqual([record.sha])
    // A second Restore click while a branch is ready does not start another.
    await runRestoreLocalChanges(deps(), row.id)
    await waitForLocalRestores()
    expect(resolver).toHaveBeenCalledTimes(1)

    const back = await runBringBackLocalChanges(deps(), row.id)
    expect(back.status).toBe(200)
    expect(read('tracked.txt')).toBe(LINES.replace('one', 'ONE (delivery)\none (mine)'))
    expect(stashes()).toEqual([])
  })

  it('a resolver that leaves markers fails closed; Discard removes the branch and keeps the stash', async () => {
    resolver.mockImplementationOnce(async () => { /* resolves nothing */ })
    const sha = feature('tracked.txt', LINES.replace('one', 'ONE (delivery)'))
    const row = delivery(sha)
    write('tracked.txt', LINES.replace('one', 'one (mine)'))
    await integrate(row.id)
    await waitForLocalRestores()
    const record = recordOf(row.id)
    expect(record.restore).toMatchObject({ status: 'failed', conflictPaths: ['tracked.txt'], commitSha: null })
    expect(await runBringBackLocalChanges(deps(), row.id)).toMatchObject({ status: 409, body: { error: 'restore_not_ready' } })
    expect(read('tracked.txt')).toBe(LINES.replace('one', 'ONE (delivery)'))

    const discarded = await runDiscardRestoreBranch(deps(), row.id)
    expect(discarded).toMatchObject({ status: 200, body: { localChanges: { state: 'needs_attention', restore: { status: 'discarded' } } } })
    expect(branchExists(record.restore!.branch)).toBe(false)
    expect(fs.existsSync(record.restore!.worktreePath)).toBe(false)
    expect(stashes()).toEqual([record.sha])
    expect(getPrDelivery(db, row.id)!.status_code).toBe('local_changes_attention')
    // "Restore my changes" afterwards starts a fresh branch restoration.
    await runRestoreLocalChanges(deps(), row.id)
    await waitForLocalRestores()
    expect(recordOf(row.id).restore).toMatchObject({ status: 'ready', resolvedBy: 'resolver' })
  })

  it('refuses to bring back over overlapping uncommitted edits or onto another branch', async () => {
    const sha = feature('tracked.txt', LINES.replace('one', 'ONE (delivery)'))
    const row = delivery(sha)
    write('tracked.txt', LINES.replace('one', 'one (mine)'))
    await integrate(row.id)
    await waitForLocalRestores()
    write('tracked.txt', LINES.replace('two', 'two (newer)'))
    expect(await runBringBackLocalChanges(deps(), row.id)).toMatchObject({ status: 409, body: { reason: 'dirty' } })
    expect(read('tracked.txt')).toBe(LINES.replace('two', 'two (newer)'))
    git(['checkout', '--', 'tracked.txt'])
    git(['switch', '-c', 'elsewhere'])
    expect(await runBringBackLocalChanges(deps(), row.id)).toMatchObject({ status: 409, body: { reason: 'wrong_branch', current: 'elsewhere' } })
    git(['switch', 'main'])
    // The target moved meanwhile (non-conflicting): merged into the restore branch first, main only fast-forwards.
    write('other.txt', 'later\n')
    git(['add', 'other.txt'])
    git(['commit', '-m', 'later work'])
    const back = await runBringBackLocalChanges(deps(), row.id)
    expect(back.status).toBe(200)
    expect(read('other.txt')).toBe('later\n')
    expect(read('tracked.txt')).toContain('one (mine)')
  })

  it('never discards while the resolver is running and settles an interrupted resolve at startup', async () => {
    let finish!: () => void
    resolver.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const sha = feature('tracked.txt', LINES.replace('one', 'ONE (delivery)'))
    const row = delivery(sha)
    write('tracked.txt', LINES.replace('one', 'one (mine)'))
    await integrate(row.id)
    await vi.waitFor(() => expect(recordOf(row.id).restore?.status).toBe('resolving'))
    expect(await runDiscardRestoreBranch(deps(), row.id)).toMatchObject({ status: 409, body: { error: 'restore_in_progress' } })
    // Simulated restart while resolving.
    expect(await recoverLocalStashes(deps())).toContain(row.id)
    expect(recordOf(row.id).restore).toMatchObject({ status: 'failed', detail: expect.stringContaining('Interrupted') })
    finish()
    await waitForLocalRestores()
    // The stale resolver result never overrides the newer state.
    expect(recordOf(row.id).restore?.status).toBe('failed')
    expect(stashes()).toEqual([recordOf(row.id).sha])
  })

  it('startup restores a conflicting stash recorded before server-side restoration existed', async () => {
    const sha = feature('tracked.txt', LINES.replace('one', 'ONE (delivery)'))
    const row = delivery(sha)
    write('tracked.txt', LINES.replace('one', 'one (mine)'))
    resolver.mockImplementationOnce(async () => { /* first run stays unresolved */ })
    await integrate(row.id)
    await waitForLocalRestores()
    const legacy = { ...recordOf(row.id), restore: null }
    await runDiscardRestoreBranch(deps(), row.id)
    setPrDeliveryLocalStash(db, row.id, legacy)
    await recoverLocalStashes(deps())
    await waitForLocalRestores()
    expect(recordOf(row.id).restore).toMatchObject({ status: 'ready' })
  })

  it('Specrails-managed generated files take the integrated version in the checkout (no attention needed)', async () => {
    write(SKILL, 'generatedBy: 1.13.0\nbody\n')
    git(['add', '.'])
    git(['commit', '-m', 'openspec skills'])
    const sha = feature(SKILL, 'generatedBy: 1.14.3 (delivery)\nbody\n')
    const row = delivery(sha)
    write(SKILL, 'generatedBy: 1.14.3 (local regenerate)\nbody\n')
    write('tracked.txt', LINES.replace('seven', 'seven (mine)'))
    const result = await integrate(row.id)
    expect(result.body.localChanges).toMatchObject({ state: 'restored' })
    expect(read(SKILL)).toBe('generatedBy: 1.14.3 (delivery)\nbody\n')
    expect(read('tracked.txt')).toBe(LINES.replace('seven', 'seven (mine)'))
    expect(git(['diff', '--cached', '--name-only'])).toBe('')
    expect(stashes()).toEqual([])
    expect(getPrDelivery(db, row.id)!.status_code).toBe('merged')
    await waitForLocalRestores()
    expect(resolver).not.toHaveBeenCalled()
    expect(startAutomaticTurn).not.toHaveBeenCalled()
  })

  it('managed files are settled in the worktree; only the person\'s conflicts reach the resolver', async () => {
    write(SKILL, 'generatedBy: 1.13.0\nbody\n')
    git(['add', '.'])
    git(['commit', '-m', 'openspec skills'])
    git(['switch', '-c', 'feat/delivery', 'main'])
    write(SKILL, 'generatedBy: 1.14.3 (delivery)\nbody\n')
    write('tracked.txt', LINES.replace('one', 'ONE (delivery)'))
    git(['commit', '-am', 'feature'])
    const sha = git(['rev-parse', 'HEAD'])
    git(['switch', 'main'])
    const row = delivery(sha)
    write(SKILL, 'generatedBy: 1.14.3 (local)\nbody\n')
    write('tracked.txt', LINES.replace('one', 'one (mine)'))
    await integrate(row.id)
    await waitForLocalRestores()
    expect(resolver.mock.calls[0][0].conflictPaths).toEqual(['tracked.txt'])
    const record = recordOf(row.id)
    expect(record.conflictPaths).toEqual(expect.arrayContaining(['tracked.txt']))
    expect(record.restore).toMatchObject({ status: 'ready', managedPaths: [SKILL] })
    expect(git(['show', `${record.restore!.commitSha}:${SKILL}`])).toBe('generatedBy: 1.14.3 (delivery)\nbody')
  })
})

describe('POST /rails/pr-local-changes/{bring-back,discard-branch}', () => {
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

  it('validates input and answers restore_not_ready without a restored branch', async () => {
    for (const action of ['bring-back', 'discard-branch']) {
      expect((await request(app()).post(`/rails/pr-local-changes/${action}`).send({})).status).toBe(400)
      expect((await request(app()).post(`/rails/pr-local-changes/${action}`).send({ prDeliveryId: 'nope' })).status).toBe(404)
    }
    const sha = feature('feature.txt', 'feature\n')
    const row = delivery(sha)
    write('tracked.txt', LINES.replace('six', 'six (mine)'))
    const saved = await saveLocalChanges({ git: realGit, repo, branch: 'main', deliveryId: row.id, ticketIds: [7] })
    if (!saved.ok) throw new Error(saved.detail)
    setPrDeliveryLocalStash(db, row.id, { ...saved.record, state: 'needs_attention' })
    const res = await request(app()).post('/rails/pr-local-changes/bring-back').send({ prDeliveryId: row.id })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: 'restore_not_ready' })
    expect(res.body.snapshot.localStash.state).toBe('needs_attention')
    const discard = await request(app()).post('/rails/pr-local-changes/discard-branch').send({ prDeliveryId: row.id })
    expect(discard.status).toBe(200)
  })
})
