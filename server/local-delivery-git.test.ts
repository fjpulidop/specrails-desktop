import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { initDb, type DbInstance } from './db'
import { executePrDecision, type PrDecisionDeps } from './rail-pr-decision'
import { createPrDelivery, getPrDelivery, transitionDecision } from './rail-pr-store'
import { createRailWorktree, getRailWorktree } from './rail-worktrees-store'
import { releaseRailWorktrees } from './rail-worktree-release'
import { checkoutProjectReviewBranch } from './project-git'
import type { GitRunner } from './worktree-manager'
import { applyWorktreeOverlay } from './worktree-overlay'

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
function feature(name = 'feat/delivery', file = 'implemented.txt', content = 'implemented\n'): string {
  git(['switch', '-c', name, 'main'])
  write(file, content)
  git(['add', '--force', '--', file])
  git(['commit', '-m', name])
  const sha = git(['rev-parse', 'HEAD'])
  git(['switch', 'main'])
  return sha
}
function delivery(branch: string, sha: string, worktreeIds: string[] = []) {
  const row = createPrDelivery(db, {
    railIndex: 0, railKey: '0-factory:implement', loopId: 'factory:implement',
    ticketIds: [1], baseBranch: 'main', loopName: 'Implement', originSurface: 'agent-chat',
  })
  transitionDecision(db, row.id, 'building', 'on_review', {
    branch, deliverySha: sha, implementationOutcome: 'succeeded', deliveryOutcome: 'ready',
    branches: [{ ticketId: 1, branch, finalSha: sha, succeeded: true, branchOwnership: 'created' }],
    worktreeIds,
  })
  return row
}
function deps(gitRunner = realGit): PrDecisionDeps {
  return {
    db, project: { id: 'local-project', slug: 'local-project', path: repo }, git: gitRunner,
    exec: { run: vi.fn().mockRejectedValue(new Error('Local integration must never call GitHub')) },
    broadcast: vi.fn(), ticketFile: path.join(root, 'tickets.json'), assemblyRoot: path.join(root, 'assembly'),
  }
}
function integrate(id: string, gitRunner = realGit) {
  return executePrDecision(deps(gitRunner), { prDeliveryId: id, action: 'merge-local', expectedDecision: 'on_review' })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-local-delivery-'))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  db = initDb(':memory:')
  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'Specrails Test'])
  git(['config', 'user.email', 'specrails@example.test'])
  write('tracked.txt', 'base\n')
  write('.gitignore', 'cache/\n')
  git(['add', '.'])
  git(['commit', '-m', 'base'])
  write('tickets.json', JSON.stringify({ schema_version: '1.3', revision: 1, next_id: 1, tickets: {} }), root)
})
afterEach(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('real Git local delivery acceptance', () => {
  it.each(['unstaged', 'staged'] as const)('integrates with %s unrelated edits, local app state and ignored data preserved', async (kind) => {
    const sha = feature()
    const row = delivery('feat/delivery', sha)
    write('tracked.txt', 'precious edit\n')
    if (kind === 'staged') git(['add', 'tracked.txt'])
    write('.specrails/local-tickets.json', 'local app state\n')
    write('cache/private.txt', 'private ignored work\n')
    const index = git(['diff', '--cached', '--binary'])
    const unstaged = git(['diff', '--binary'])
    const result = await integrate(row.id)
    expect(result.status).toBe(200)
    expect(read('implemented.txt')).toBe('implemented\n')
    expect(read('tracked.txt')).toBe('precious edit\n')
    expect(read('.specrails/local-tickets.json')).toBe('local app state\n')
    expect(read('cache/private.txt')).toBe('private ignored work\n')
    expect(git(['diff', '--cached', '--binary'])).toBe(index)
    expect(git(['diff', '--binary'])).toBe(unstaged)
    expect(git(['merge-base', '--is-ancestor', sha, 'main'])).toBe('')
    expect(git(['worktree', 'list', '--porcelain']).split('worktree ').length - 1).toBe(1)
    expect(getPrDelivery(db, row.id)?.decision).toBe('merged')
  })

  it.each(['tracked', 'untracked', 'ignored'] as const)('preserves a %s collision and can retry after the conflicting work is saved', async (kind) => {
    const file = kind === 'tracked' ? 'tracked.txt' : kind === 'ignored' ? 'cache/collision.txt' : 'collision.txt'
    const sha = feature('feat/delivery', file)
    const row = delivery('feat/delivery', sha)
    write(file, 'precious local work\n')
    const before = git(['rev-parse', 'HEAD'])
    const result = await integrate(row.id)
    expect(result).toMatchObject({ status: 409, body: { error: 'merge_local_blocked', reason: 'dirty' } })
    expect(git(['rev-parse', 'HEAD'])).toBe(before)
    expect(read(file)).toBe('precious local work\n')
    expect(getPrDelivery(db, row.id)?.decision).toBe('on_review')
    // Simulate the user saving the conflicting file elsewhere before retry.
    fs.renameSync(path.join(repo, file), path.join(root, 'saved-work.txt'))
    if (kind === 'tracked') git(['restore', '--', file])
    expect((await integrate(row.id)).status).toBe(200)
    expect(read('saved-work.txt', root)).toBe('precious local work\n')
    expect(read(file)).toBe('implemented\n')
  })

  it('integrates into main while keeping the user on another dirty branch byte-for-byte', async () => {
    const sha = feature()
    const row = delivery('feat/delivery', sha)
    git(['switch', '-c', 'my-work'])
    write('tracked.txt', 'my staged work\n')
    git(['add', 'tracked.txt'])
    write('tracked.txt', 'my staged and unstaged work\n')
    const beforeHead = git(['rev-parse', 'HEAD'])
    const beforeIndex = git(['diff', '--cached', '--binary'])
    const beforeDiff = git(['diff', '--binary'])
    expect((await integrate(row.id)).status).toBe(200)
    expect(git(['branch', '--show-current'])).toBe('my-work')
    expect(git(['rev-parse', 'HEAD'])).toBe(beforeHead)
    expect(git(['diff', '--cached', '--binary'])).toBe(beforeIndex)
    expect(git(['diff', '--binary'])).toBe(beforeDiff)
    expect(git(['show', 'main:implemented.txt'])).toBe('implemented')
    expect(fs.existsSync(path.join(repo, 'implemented.txt'))).toBe(false)
    expect(git(['worktree', 'list', '--porcelain']).split('worktree ').length - 1).toBe(1)
  })

  it('does not mutate a base branch already checked out in an external worktree', async () => {
    const sha = feature()
    const row = delivery('feat/delivery', sha)
    git(['switch', '-c', 'my-work'])
    const other = path.join(root, 'external-main')
    git(['worktree', 'add', other, 'main'])
    write('tracked.txt', 'external work\n', other)
    const before = git(['rev-parse', 'main'])
    expect(await integrate(row.id)).toMatchObject({ status: 409, body: { reason: 'integration_branch_busy' } })
    expect(git(['rev-parse', 'main'])).toBe(before)
    expect(read('tracked.txt', other)).toBe('external work\n')
  })

  it('uses the recorded delivery object even after its branch advances', async () => {
    const sha = feature()
    const row = delivery('feat/delivery', sha)
    git(['switch', 'feat/delivery'])
    write('later.txt', 'later unrelated commit\n')
    git(['add', 'later.txt'])
    git(['commit', '-m', 'later'])
    const laterSha = git(['rev-parse', 'HEAD'])
    git(['switch', 'main'])
    expect((await integrate(row.id)).status).toBe(200)
    expect(git(['rev-parse', 'feat/delivery'])).toBe(laterSha)
    expect(fs.existsSync(path.join(repo, 'later.txt'))).toBe(false)
    expect(read('implemented.txt')).toBe('implemented\n')
  })

  it('uses durable unit evidence when an assembled branch name exists without a delivery SHA', async () => {
    const sha = feature()
    const row = delivery('feat/delivery', sha)
    transitionDecision(db, row.id, 'on_review', 'on_review', { deliverySha: null })
    git(['switch', 'feat/delivery'])
    write('later.txt', 'unapproved later commit\n')
    git(['add', 'later.txt'])
    git(['commit', '-m', 'later'])
    const laterSha = git(['rev-parse', 'HEAD'])
    git(['switch', 'main'])
    expect((await integrate(row.id)).status).toBe(200)
    expect(read('implemented.txt')).toBe('implemented\n')
    expect(fs.existsSync(path.join(repo, 'later.txt'))).toBe(false)
    expect(git(['rev-parse', 'feat/delivery'])).toBe(laterSha)
  })

  it('refuses units with no immutable final SHA even when the branch exists', async () => {
    const sha = feature()
    const row = delivery('feat/delivery', sha)
    transitionDecision(db, row.id, 'on_review', 'on_review', {
      deliverySha: null,
      branches: [{ ticketId: 1, branch: 'feat/delivery', succeeded: true, finalSha: null }],
    })
    const before = git(['rev-parse', 'HEAD'])
    expect(await integrate(row.id)).toMatchObject({ status: 502, body: { error: 'merge_failed' } })
    expect(git(['rev-parse', 'HEAD'])).toBe(before)
    expect(git(['rev-parse', 'feat/delivery'])).toBe(sha)
  })

  it('refuses a missing immutable delivery object instead of silently merging the current branch', async () => {
    feature()
    const row = delivery('feat/delivery', 'f'.repeat(40))
    const before = git(['rev-parse', 'HEAD'])
    expect(await integrate(row.id)).toMatchObject({ status: 502, body: { error: 'merge_failed' } })
    expect(git(['rev-parse', 'HEAD'])).toBe(before)
    expect(fs.existsSync(path.join(repo, 'implemented.txt'))).toBe(false)
  })

  it('resolves branch identity exactly even when a tag has the same name', async () => {
    const sha = feature()
    git(['tag', 'main'])
    git(['tag', 'feat/delivery'])
    const row = delivery('feat/delivery', sha)
    expect(await checkoutProjectReviewBranch(repo, 'feat/delivery', sha)).toEqual({ ok: true })
    git(['switch', 'main'])
    expect((await integrate(row.id)).status).toBe(200)
    expect(read('implemented.txt')).toBe('implemented\n')
  })

  it('preserves detached HEAD while integrating into a configured local branch', async () => {
    const sha = feature()
    const row = delivery('feat/delivery', sha)
    git(['switch', '--detach'])
    const beforeHead = git(['rev-parse', 'HEAD'])
    expect((await integrate(row.id)).status).toBe(200)
    expect(git(['branch', '--show-current'])).toBe('')
    expect(git(['rev-parse', 'HEAD'])).toBe(beforeHead)
    expect(git(['show', 'main:implemented.txt'])).toBe('implemented')
  })

  it.each(['HEAD', '--force', 'refs/heads/main'])('refuses integration into the ambiguous or invalid base %s', async (base) => {
    const sha = feature()
    const row = delivery('feat/delivery', sha)
    db.prepare('UPDATE rail_pr_deliveries SET base_branch = ? WHERE id = ?').run(base, row.id)
    const beforeHead = git(['rev-parse', 'HEAD'])
    expect(await integrate(row.id)).toMatchObject({ status: 409, body: { reason: 'unresolved_head' } })
    expect(git(['rev-parse', 'HEAD'])).toBe(beforeHead)
  })

  it('refuses a base HEAD changed externally during assembly and preserves the external commit', async () => {
    const sha = feature()
    const row = delivery('feat/delivery', sha)
    let concurrentSha = ''
    const racingGit: GitRunner = {
      async run(args, cwd) {
        if (cwd.includes('local-merge-') && args.join(' ') === 'rev-parse --verify HEAD') {
          write('concurrent.txt', 'external commit\n')
          git(['add', 'concurrent.txt'])
          git(['commit', '-m', 'external commit'])
          concurrentSha = git(['rev-parse', 'HEAD'])
        }
        return realGit.run(args, cwd)
      },
    }
    expect(await integrate(row.id, racingGit)).toMatchObject({ status: 409, body: { reason: 'head_changed' } })
    expect(git(['rev-parse', 'HEAD'])).toBe(concurrentSha)
    expect(read('concurrent.txt')).toBe('external commit\n')
    expect(fs.existsSync(path.join(repo, 'implemented.txt'))).toBe(false)
    expect(git(['worktree', 'list', '--porcelain']).split('worktree ').length - 1).toBe(1)
  })

  it('releases both temporary worktrees after a Git runner exception during assembly', async () => {
    const sha = feature()
    const row = delivery('feat/delivery', sha)
    git(['switch', '-c', 'my-work'])
    const failingGit: GitRunner = {
      async run(args, cwd) {
        if (cwd.includes('local-merge-') && args[0] === 'merge') throw new Error('spawn timeout')
        return realGit.run(args, cwd)
      },
    }
    await expect(integrate(row.id, failingGit)).rejects.toThrow('spawn timeout')
    expect(git(['worktree', 'list', '--porcelain']).split('worktree ').length - 1).toBe(1)
    expect(git(['branch', '--show-current'])).toBe('my-work')
    expect(getPrDelivery(db, row.id)?.decision).toBe('on_review')
  })

  it('does not accept or clean sources when an external checkout races the final fast-forward', async () => {
    const sha = feature()
    const row = delivery('feat/delivery', sha)
    git(['branch', 'external-branch'])
    const beforeBase = git(['rev-parse', 'refs/heads/main'])
    const racingGit: GitRunner = {
      async run(args, cwd) {
        if (cwd === repo && args[0] === 'merge' && args[1] === '--ff-only') git(['switch', 'external-branch'])
        return realGit.run(args, cwd)
      },
    }
    expect(await integrate(row.id, racingGit)).toMatchObject({ status: 409, body: { reason: 'head_changed' } })
    expect(git(['branch', '--show-current'])).toBe('external-branch')
    expect(git(['rev-parse', 'refs/heads/main'])).toBe(beforeBase)
    expect(git(['rev-parse', 'refs/heads/feat/delivery'])).toBe(sha)
    expect(getPrDelivery(db, row.id)?.decision).toBe('on_review')
    const current = getPrDelivery(db, row.id)!
    const archives = JSON.parse(current.safety_archives) as string[]
    expect(archives).toHaveLength(1)
    expect(read('implemented.txt', archives[0])).toBe('implemented\n')
    // A fresh attempt updates main without switching the external branch.
    expect((await integrate(row.id)).status).toBe(200)
    expect(git(['branch', '--show-current'])).toBe('external-branch')
    expect(git(['show', 'main:implemented.txt'])).toBe('implemented')
  })
})

describe('real Git review worktree handoff', () => {
  it('archives ignored content changed under a settled directory before releasing the worktree', async () => {
    const sha = feature()
    const wt = path.join(root, 'delivery-worktree')
    git(['worktree', 'add', wt, 'feat/delivery'])
    createRailWorktree(db, { id: 'wt', railIndex: 0, ticketId: 1, branch: 'feat/delivery', worktreePath: wt, mergeState: 'built' })
    write('cache/run-output.txt', 'original run data\n', wt)
    const settlementIgnored = ['cache']
    write('cache/run-output.txt', 'later user changes\n', wt)
    write('cache/new-user-file.txt', 'new user data\n', wt)
    const archives: string[] = []
    expect(await releaseRailWorktrees({
      db, git: realGit, repoDir: repo, worktreeIds: ['wt'],
      expectedHeadByBranch: new Map([['feat/delivery', sha]]), overlayEvidenceByBranch: new Map(),
      settlementIgnoredByBranch: new Map([['feat/delivery', settlementIgnored]]),
      onSafetyArchive: (archive) => { archives.push(archive) },
    })).toEqual([])
    expect(fs.existsSync(wt)).toBe(false)
    expect(archives).toHaveLength(1)
    expect(read('cache/run-output.txt', archives[0])).toBe('later user changes\n')
    expect(read('cache/new-user-file.txt', archives[0])).toBe('new user data\n')
    expect(await checkoutProjectReviewBranch(repo, 'feat/delivery', sha)).toEqual({ ok: true })
  })

  it('releases the settled linked worktree and moves its branch into the project, preserving unrelated staged edits', async () => {
    const sha = feature()
    const wt = path.join(root, 'delivery-worktree')
    git(['worktree', 'add', wt, 'feat/delivery'])
    write('.claude/commands/specrails/implement.md', 'app framework\n')
    const overlay = applyWorktreeOverlay({ worktreePath: wt, sourceRoot: repo, providerDir: '.claude', instructionsFilename: 'CLAUDE.md' })
    createRailWorktree(db, { id: 'wt', railIndex: 0, ticketId: 1, branch: 'feat/delivery', worktreePath: wt, mergeState: 'built' })
    write('tracked.txt', 'local staged edit\n')
    git(['add', 'tracked.txt'])
    const release = () => releaseRailWorktrees({
      db, git: realGit, repoDir: repo, worktreeIds: ['wt'],
      expectedHeadByBranch: new Map([['feat/delivery', sha]]),
      overlayEvidenceByBranch: new Map([['feat/delivery', overlay.cleanupEvidence]]),
    })
    expect(await release()).toEqual([])
    expect(fs.existsSync(wt)).toBe(false)
    expect(getRailWorktree(db, 'wt')?.merge_state).toBe('released')
    expect(await checkoutProjectReviewBranch(repo, 'feat/delivery', sha)).toEqual({ ok: true })
    expect(git(['branch', '--show-current'])).toBe('feat/delivery')
    expect(read('tracked.txt')).toBe('local staged edit\n')
    expect(git(['diff', '--cached', '--name-only'])).toBe('tracked.txt')
    expect(await release()).toEqual([])
    expect(await checkoutProjectReviewBranch(repo, 'feat/delivery', sha)).toEqual({ ok: true })
  })

  it.each(['tracked', 'untracked', 'ignored'] as const)('checkout refuses a %s collision and preserves both branches', async (kind) => {
    const file = kind === 'tracked' ? 'tracked.txt' : kind === 'ignored' ? 'cache/collision.txt' : 'collision.txt'
    const sha = feature('feat/delivery', file)
    write(file, 'valuable local file\n')
    expect(await checkoutProjectReviewBranch(repo, 'feat/delivery', sha)).toMatchObject({ ok: false })
    expect(git(['branch', '--show-current'])).toBe('main')
    expect(git(['rev-parse', 'feat/delivery'])).toBe(sha)
    expect(read(file)).toBe('valuable local file\n')
  })
})
