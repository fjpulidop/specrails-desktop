import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { initDb, type DbInstance } from '../../../db'
import { createPrDelivery } from './rail-pr-store'
import { __resetMergePreviewCache, mergeTreeSupported, previewPairMerge, type MergePreviewExec } from './merge-preview-git'
import { __resetMergePreviewSummaries, computeMergePreviews, peekMergePreview } from './merge-preview'
import { compareForMergeBack, mergePreviewNeedsAttention, worstStatus } from '../domain/merge-preview'

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim()

let tmp: string
let repo: string
let db: DbInstance

function commitOn(branch: string, from: string, file: string, content: string): string {
  git(repo, 'checkout', '-q', '-B', branch, from)
  fs.writeFileSync(path.join(repo, file), content)
  git(repo, 'add', file)
  git(repo, 'commit', '-qm', `${branch}: ${file}`)
  const sha = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'checkout', '-q', 'main')
  return sha
}

function looseObjects(): number {
  return Number(git(repo, 'count-objects').split(' ')[0])
}

function delivery(railIndex: number, branch: string, finalSha: string, decision = 'on_review'): string {
  const row = createPrDelivery(db, { railIndex, loopId: null, railKey: `k${railIndex}`, ticketIds: [railIndex + 1], baseBranch: 'main', loopName: 'L', originSurface: 'dashboard' })
  db.prepare('UPDATE rail_pr_deliveries SET decision = ?, branches = ? WHERE id = ?')
    .run(decision, JSON.stringify([{ ticketId: railIndex + 1, branch, succeeded: true, finalSha }]), row.id)
  return row.id
}

const project = () => ({ id: 'p1', path: repo, slug: 'p1', name: 'P' }) as never

beforeEach(() => {
  __resetMergePreviewCache()
  __resetMergePreviewSummaries()
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-merge-preview-')))
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'api.ts'), 'export const a = 1\nexport const b = 2\n')
  fs.writeFileSync(path.join(repo, 'other.ts'), 'x\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  git(repo, 'gc', '-q') // pack everything: later loose objects are the preview's fault
  db = initDb(':memory:')
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('merge-tree pair preview', () => {
  it('reports clean, conflicting and already-landed merges without writing objects into the repository', async () => {
    expect(await mergeTreeSupported()).toBe(true)
    const clean = commitOn('feat/clean', 'main', 'new.ts', 'new\n')
    const conflict = commitOn('feat/conflict', 'main', 'api.ts', 'export const a = 100\nexport const b = 2\n')
    // The base moves and edits the same line.
    const baseMoved = commitOn('main', 'main', 'api.ts', 'export const a = 42\nexport const b = 2\n')
    git(repo, 'gc', '-q')
    const before = looseObjects()

    expect(await previewPairMerge(repo, baseMoved, clean)).toEqual({ status: 'clean', files: [], fileCount: 0 })
    expect(await previewPairMerge(repo, baseMoved, conflict)).toEqual({ status: 'conflicts', files: ['api.ts'], fileCount: 1 })
    expect(looseObjects()).toBe(before)
    // A squash of the clean branch landed on the base: the merge result is the base itself.
    git(repo, 'merge', '-q', '--squash', 'feat/clean')
    git(repo, 'commit', '-qm', 'squash feat/clean')
    const squashed = git(repo, 'rev-parse', 'HEAD')
    expect((await previewPairMerge(repo, squashed, clean)).status).toBe('already_merged')

    // No scratch store survives.
    expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('specrails-merge-preview-'))).toEqual([])
    // The person's index and working tree are untouched.
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('writes merge results only to the scratch store', async () => {
    const a = commitOn('feat/a', 'main', 'a.ts', 'a\n')
    const b = commitOn('feat/b', 'main', 'b.ts', 'b\n')
    git(repo, 'gc', '-q')
    const before = looseObjects()
    expect((await previewPairMerge(repo, a, b)).status).toBe('clean')
    expect(looseObjects()).toBe(before)
  })

  it('caches by sha and does not cache unknown results', async () => {
    let calls = 0
    const failing: MergePreviewExec = async (args) => {
      calls++
      if (args[0] === '--version') return { code: 0, stdout: 'git version 2.50.1', stderr: '' }
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${tmp}/.git\n`, stderr: '' }
      return { code: 128, stdout: '', stderr: 'fatal: boom' }
    }
    const result = await previewPairMerge(repo, 'a'.repeat(40), 'b'.repeat(40), failing)
    expect(result).toMatchObject({ status: 'unknown', error: 'fatal: boom' })
    expect(calls).toBeGreaterThan(0)
  })

  it('reports Git without merge-tree --write-tree as unsupported', async () => {
    const old: MergePreviewExec = async () => ({ code: 0, stdout: 'git version 2.37.1', stderr: '' })
    expect(await mergeTreeSupported(old)).toBe(false)
    expect(await previewPairMerge(repo, 'a'.repeat(40), 'b'.repeat(40), old)).toMatchObject({ status: 'unknown', error: 'merge_tree_unsupported' })
  })
})

describe('delivery merge previews', () => {
  it('previews each pending delivery against the current base, counts the base lead and finds colliding siblings', async () => {
    const one = commitOn('feat/1', 'main', 'api.ts', 'export const a = 1\nexport const b = 20\n')
    const two = commitOn('feat/2', 'main', 'api.ts', 'export const a = 1\nexport const b = 21\n')
    const three = commitOn('feat/3', 'main', 'docs.md', 'docs\n')
    commitOn('main', 'main', 'other.ts', 'y\n')
    commitOn('main', 'main', 'other2.ts', 'z\n')
    const d1 = delivery(0, 'feat/1', one)
    const d2 = delivery(1, 'feat/2', two)
    const d3 = delivery(2, 'feat/3', three)
    delivery(3, 'feat/gone', 'c'.repeat(40), 'merged') // terminal: not previewed

    const previews = await computeMergePreviews({ project: project(), db })
    const byId = new Map(previews.map((p) => [p.deliveryId, p]))
    expect(previews).toHaveLength(3)
    expect(byId.get(d1)).toMatchObject({ status: 'clean', baseRef: 'main', baseAdvancedBy: 2, siblings: [{ deliveryId: d2, railIndex: 1, files: ['api.ts'], fileCount: 1 }] })
    expect(byId.get(d2)!.siblings.map((s) => s.deliveryId)).toEqual([d1])
    expect(byId.get(d3)).toMatchObject({ status: 'clean', siblings: [] })
    expect(peekMergePreview('p1', d1)).toEqual({ status: 'clean', conflictFileCount: 0, siblingConflictCount: 1, baseAdvancedBy: 2 })
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('prefers the fetched origin/<base> over the local branch', async () => {
    const remote = path.join(tmp, 'remote.git')
    git(tmp, 'clone', '-q', '--bare', repo, remote)
    git(repo, 'remote', 'add', 'origin', remote)
    const head = commitOn('feat/x', 'main', 'api.ts', 'export const a = 7\nexport const b = 2\n')
    // Upstream moved the same line; only origin/main knows it.
    const clone = path.join(tmp, 'clone')
    git(tmp, 'clone', '-q', remote, clone)
    fs.writeFileSync(path.join(clone, 'api.ts'), 'export const a = 9\nexport const b = 2\n')
    git(clone, 'commit', '-qam', 'upstream')
    git(clone, 'push', '-q', 'origin', 'main')
    git(repo, 'fetch', '-q', 'origin')
    const id = delivery(0, 'feat/x', head)
    const [preview] = await computeMergePreviews({ project: project(), db })
    expect(preview).toMatchObject({ deliveryId: id, baseRef: 'origin/main', status: 'conflicts', conflictFiles: ['api.ts'], baseAdvancedBy: 1 })
  })
})

describe('merge preview rules', () => {
  it('orders clean candidates first, conflicting last, then by sibling conflicts', () => {
    const facts = [
      { ticketId: 1, baseConflicts: 3, siblingConflicts: 0 },
      { ticketId: 2, baseConflicts: 0, siblingConflicts: 2 },
      { ticketId: 3, baseConflicts: null, siblingConflicts: 0 },
      { ticketId: 4, baseConflicts: 0, siblingConflicts: 0 },
      { ticketId: 5, baseConflicts: 1, siblingConflicts: 0 },
    ]
    expect([...facts].sort(compareForMergeBack).map((f) => f.ticketId)).toEqual([4, 2, 3, 5, 1])
  })

  it('aggregates branch statuses worst-first and flags conflicts for attention', () => {
    expect(worstStatus(['clean', 'already_merged'])).toBe('clean')
    expect(worstStatus(['clean', 'unknown', 'conflicts'])).toBe('conflicts')
    expect(worstStatus([])).toBe('unknown')
    expect(mergePreviewNeedsAttention({ status: 'clean', siblingConflictCount: 1 })).toBe(true)
    expect(mergePreviewNeedsAttention({ status: 'already_merged', siblingConflictCount: 0 })).toBe(false)
  })
})

describe('merge-back order from the preview', () => {
  it('merges the candidate that is clean against the current base before the conflicting one', async () => {
    const { withMergePreview } = await import('./rail-merge-orchestrator')
    const { orderBranches } = await import('./merge-manager')
    const { defaultGitRunner } = await import('../../../worktree-manager')
    commitOn('feat/conflicting', 'main', 'api.ts', 'export const a = 5\nexport const b = 2\n')
    commitOn('feat/clean', 'main', 'docs.md', 'docs\n')
    commitOn('main', 'main', 'api.ts', 'export const a = 6\nexport const b = 2\n')
    const branches = [
      { ticketId: 1, branch: 'feat/conflicting', succeeded: true },
      { ticketId: 2, branch: 'feat/clean', succeeded: true },
    ]
    expect(orderBranches(branches).map((b) => b.ticketId)).toEqual([1, 2])
    const previewed = await withMergePreview(defaultGitRunner, repo, branches, previewPairMerge)
    expect(previewed.map((b) => b.preview)).toEqual([{ baseConflicts: 1, siblingConflicts: 0 }, { baseConflicts: 0, siblingConflicts: 0 }])
    expect(orderBranches(previewed).map((b) => b.ticketId)).toEqual([2, 1])
  })
})
