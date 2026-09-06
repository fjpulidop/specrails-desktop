import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, type DbInstance } from './db'
import { createPrDelivery, transitionDecision, type PrDecision } from './rail-pr-store'
import { defaultGitRunner } from './worktree-manager'
import type { RepositoryProject } from './project-repositories'
import type { RepositoryDeliverySnapshot } from './multi-repo-execution-store'
import { resolveRepositoryDeliveryBases } from './multi-repo-bases'

let root: string
let db: DbInstance
let project: RepositoryProject
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-repository-bases-'))
  db = initDb(':memory:')
  project = { id: 'p', path: path.join(root, 'web'), repositories: ['web', 'api'].map((id, index) => {
    const cwd = path.join(root, id)
    fs.mkdirSync(cwd)
    git(cwd, 'init', '-b', 'main')
    git(cwd, 'config', 'user.name', 'Test')
    git(cwd, 'config', 'user.email', 'test@example.invalid')
    git(cwd, 'commit', '--allow-empty', '-m', 'Initial')
    return { id, projectId: 'p', name: id, path: cwd, isPrimary: index === 0, kind: 'git', integrationBranch: 'main', addedAt: '' }
  }) }
})
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })

function delivered(repositoryId: string, branch = 'chunk-1'): RepositoryDeliverySnapshot {
  const repo = project.repositories!.find((r) => r.id === repositoryId)!
  git(repo.path, 'checkout', '-b', branch)
  fs.writeFileSync(path.join(repo.path, `${branch}.txt`), repositoryId)
  git(repo.path, 'add', '.')
  git(repo.path, 'commit', '-m', branch)
  const sha = git(repo.path, 'rev-parse', 'HEAD')
  git(repo.path, 'checkout', 'main')
  return { repositoryId, name: repositoryId, path: repo.path, deliveryId: `${repositoryId}-${branch}`, branch,
    baseBranch: 'main', deliverySha: sha, decision: 'on_review', implementationOutcome: 'succeeded',
    deliveryOutcome: 'ready', statusCode: null, statusDetail: null, prUrl: null, prNumber: null, worktreeIds: [], runIds: [] }
}

function group(id: string, repositories: RepositoryDeliverySnapshot[], decision: PrDecision = 'on_review') {
  createPrDelivery(db, { id, railIndex: Number(id.slice(1)), railKey: id, ticketIds: [1], baseBranch: 'main', loopName: 'Batch', originSurface: 'dashboard' })
  transitionDecision(db, id, 'building', decision, {
    executionManifest: { version: 1, groupId: id, projectId: 'p', primaryRepositoryId: 'web', artifactRepositoryId: 'web',
      selectedRepositoryIds: repositories.map((r) => r.repositoryId), repositories: [] }, repositoryDeliveries: repositories,
  })
}

describe('durable per-repository milestone bases', () => {
  it('resolves each member head without looking for an API branch in the web checkout', async () => {
    const web = delivered('web', 'web-1'); const api = delivered('api', 'api-1')
    group('d1', [web, api])
    expect(await resolveRepositoryDeliveryBases(db, project, ['web', 'api'], ['d1'], defaultGitRunner)).toEqual({
      repositoryBaseBranches: { web: 'web-1', api: 'api-1' }, repositoryBaseShas: { web: web.deliverySha, api: api.deliverySha },
    })
    expect(await resolveRepositoryDeliveryBases(db, project, ['api'], ['d1'], defaultGitRunner)).toMatchObject({ repositoryBaseBranches: { api: 'api-1' } })
  })

  it('retains the previous member base when a later chunk does not change that member', async () => {
    const web = delivered('web'); const api = delivered('api')
    group('d1', [web, api])
    group('d2', [{ ...web, decision: 'no_changes', branch: null, deliverySha: null }, delivered('api', 'api-2')])
    const bases = await resolveRepositoryDeliveryBases(db, project, ['web', 'api'], ['d1', 'd2'], defaultGitRunner)
    expect(bases.repositoryBaseBranches).toEqual({ web: 'chunk-1', api: 'api-2' })
  })

  it('rejects moved or deleted branches instead of silently starting on unrelated code', async () => {
    const entry = delivered('api'); group('d1', [entry])
    git(entry.path, 'branch', '-f', entry.branch!, 'main')
    await expect(resolveRepositoryDeliveryBases(db, project, ['api'], ['d1'], defaultGitRunner)).rejects.toThrow('changed')
    git(entry.path, 'branch', '-D', entry.branch!)
    await expect(resolveRepositoryDeliveryBases(db, project, ['api'], ['d1'], defaultGitRunner)).rejects.toThrow('Missing base')
  })

  it('uses the integration branch for an accepted chunk and verifies ancestry', async () => {
    const entry = delivered('api')
    git(entry.path, 'merge', '--ff-only', entry.branch!)
    git(entry.path, 'commit', '--allow-empty', '-m', 'Later integration')
    group('d1', [{ ...entry, decision: 'merged', baseBranch: 'earlier-chunk', integrationBranch: 'main' }])
    const bases = await resolveRepositoryDeliveryBases(db, project, ['api'], ['d1'], defaultGitRunner)
    expect(bases.repositoryBaseBranches).toEqual({ api: 'main' })
    expect(bases.repositoryBaseShas.api).toBe(git(entry.path, 'rev-parse', 'main'))
    git(entry.path, 'reset', '--hard', 'HEAD~2')
    await expect(resolveRepositoryDeliveryBases(db, project, ['api'], ['d1'], defaultGitRunner)).rejects.toThrow('no longer contains')
  })

  it('rejects malformed, missing and unfinished delivery histories', async () => {
    for (const value of [[], '', [''], [42], Array(101).fill('d1')]) {
      await expect(resolveRepositoryDeliveryBases(db, project, ['web'], value, defaultGitRunner)).rejects.toThrow('baseDeliveryIds')
    }
    await expect(resolveRepositoryDeliveryBases(db, project, ['web'], ['other-project'], defaultGitRunner)).rejects.toThrow('Unknown base')
    group('d1', [], 'building')
    await expect(resolveRepositoryDeliveryBases(db, project, ['web'], ['d1'], defaultGitRunner)).rejects.toThrow('not ready')
    expect(await resolveRepositoryDeliveryBases(db, project, ['web'], undefined, defaultGitRunner)).toEqual({ repositoryBaseBranches: {}, repositoryBaseShas: {} })
  })

  it('supports a legacy primary-only chunk before a multi-repository chunk', async () => {
    const entry = delivered('web')
    createPrDelivery(db, { id: 'legacy', railIndex: 1, railKey: 'legacy', ticketIds: [1], baseBranch: 'main', loopName: 'Batch', originSurface: 'dashboard' })
    transitionDecision(db, 'legacy', 'building', 'on_review', { branch: entry.branch, deliverySha: entry.deliverySha })
    expect(await resolveRepositoryDeliveryBases(db, project, ['web', 'api'], ['legacy'], defaultGitRunner)).toMatchObject({ repositoryBaseBranches: { web: 'chunk-1' } })
  })
})
