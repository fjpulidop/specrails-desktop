import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { initDesktopDb, addProject, getProject, addProjectRepository, updateProjectRepository, removeProjectRepository, listProjectRepositories, removeProject } from './desktop-db'
import { assertDistinctRepositories, getProjectRepositories, inspectRepositoryPath, resolveProjectRepository, resolveRepositoryProject, validateTicketRepositoryIds, type RepositoryProject } from './project-repositories'
import type { DbInstance } from './db'

let temp: string
let db: DbInstance
const mkdir = (name: string): string => { const dir = path.join(temp, name); fs.mkdirSync(dir, { recursive: true }); return dir }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

beforeEach(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-repositories-')); db = initDesktopDb(':memory:') })
afterEach(() => { if (db.open) db.close(); fs.rmSync(temp, { recursive: true, force: true }) })

describe('project repository membership', () => {
  it('creates stable primary membership and preserves legacy project fields', () => {
    const primary = mkdir('primary'), secondary = mkdir('secondary')
    const project = addProject(db, { id: 'logical', slug: 'logical', name: 'Logical', path: primary, repositories: [{ path: secondary, name: 'Backend' }] })
    expect(project.primaryRepositoryId).toBe('primary-logical')
    expect(project.path).toBe(primary)
    expect(project.repositories).toMatchObject([{ id: 'primary-logical', projectId: 'logical', isPrimary: true }, { name: 'Backend', isPrimary: false, kind: 'folder', available: true }])
    expect(getProject(db, project.id)?.repositories).toEqual(project.repositories)
  })

  it('backfills v25 without changing IDs, histories, settings or missing primary paths, and survives reopen', () => {
    db.close()
    const file = path.join(temp, 'desktop.sqlite')
    db = initDesktopDb(file)
    const original = addProject(db, { id: 'legacy', slug: 'same-slug', name: 'Legacy', path: path.join(temp, 'missing') })
    db.exec("DROP TABLE project_repositories; DELETE FROM schema_migrations WHERE version = 26; INSERT INTO desktop_settings VALUES ('sentinel', 'keep')")
    db.close()
    db = initDesktopDb(file)
    expect(getProject(db, 'legacy')).toMatchObject({ id: original.id, slug: original.slug, path: original.path, db_path: original.db_path, added_at: original.added_at, primaryRepositoryId: 'primary-legacy', repositories: [{ id: 'primary-legacy', available: false }] })
    expect(db.prepare("SELECT value FROM desktop_settings WHERE key = 'sentinel'").get()).toEqual({ value: 'keep' })
    db.close(); db = initDesktopDb(file)
    expect(listProjectRepositories(db, 'legacy')).toHaveLength(1)
  })

  it('rolls back the whole registration for invalid or overlapping additional roots', () => {
    const primary = mkdir('primary'), nested = mkdir('primary/subdir')
    expect(() => addProject(db, { id: 'bad', slug: 'bad', name: 'Bad', path: primary, repositories: [{ path: nested }] })).toThrow('distinct')
    expect(getProject(db, 'bad')).toBeUndefined()
    expect(() => addProject(db, { id: 'missing', slug: 'missing', name: 'Missing', path: primary, repositories: [{ path: path.join(temp, 'absent') }] })).toThrow('unavailable')
    expect(getProject(db, 'missing')).toBeUndefined()
  })

  it('rejects symlink aliases and linked worktrees of the same Git repository', () => {
    const primary = mkdir('git')
    git(primary, 'init'); git(primary, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial')
    const linked = path.join(temp, 'linked')
    git(primary, 'worktree', 'add', '-b', 'linked', linked)
    const alias = path.join(temp, 'alias'); fs.symlinkSync(primary, alias)
    const project = addProject(db, { id: 'git-project', slug: 'git-project', name: 'Git', path: primary })
    expect(project.repositories?.[0].kind).toBe('git')
    expect(() => addProjectRepository(db, project.id, { path: alias })).toThrow('distinct')
    expect(() => addProjectRepository(db, project.id, { path: linked })).toThrow('distinct')
  })

  it('shares physical repos across projects without merging their memberships or backlog files', () => {
    const rootA = mkdir('a'), rootB = mkdir('b'), shared = mkdir('shared')
    fs.writeFileSync(path.join(shared, 'local-tickets.json'), '{"sentinel":true}')
    const a = addProject(db, { id: 'a', slug: 'a', name: 'A', path: rootA })
    const b = addProject(db, { id: 'b', slug: 'b', name: 'B', path: rootB })
    const aa = addProjectRepository(db, a.id, { path: shared })
    const bb = addProjectRepository(db, b.id, { path: shared })
    expect(aa.id).not.toBe(bb.id)
    expect(() => resolveProjectRepository(getProject(db, 'a')!, bb.id)).toThrow('does not belong')
    removeProjectRepository(db, a.id, aa.id)
    expect(listProjectRepositories(db, b.id)).toHaveLength(2)
    expect(fs.readFileSync(path.join(shared, 'local-tickets.json'), 'utf8')).toBe('{"sentinel":true}')
  })

  it('preserves membership IDs on edits and removes only associations', () => {
    const primary = mkdir('a'), secondary = mkdir('b'), relocated = mkdir('relocated')
    const project = addProject(db, { id: 'a', slug: 'a', name: 'A', path: primary })
    const repo = addProjectRepository(db, project.id, { path: secondary })
    expect(updateProjectRepository(db, project.id, repo.id, { path: relocated, name: 'API', integrationBranch: 'develop' })).toMatchObject({ id: repo.id, name: 'API', integrationBranch: 'develop', path: fs.realpathSync(relocated) })
    expect(() => updateProjectRepository(db, project.id, 'primary-a', { path: primary })).toThrow('primary')
    expect(() => removeProjectRepository(db, project.id, 'primary-a')).toThrow('primary')
    removeProjectRepository(db, project.id, repo.id)
    expect(fs.existsSync(relocated)).toBe(true)
    removeProject(db, project.id)
    expect(listProjectRepositories(db, project.id)).toEqual([])
    expect(fs.existsSync(primary)).toBe(true)
  })
})

describe('strict scope and path resolution', () => {
  it('defaults only omitted scope to the stable primary, rejecting malformed and foreign IDs', () => {
    const project: RepositoryProject = { id: 'legacy', path: mkdir('legacy') }
    expect(getProjectRepositories(project)[0].id).toBe('primary-legacy')
    expect(resolveProjectRepository(project).id).toBe('primary-legacy')
    expect(validateTicketRepositoryIds(project, undefined)).toBeUndefined()
    expect(validateTicketRepositoryIds(project, ['primary-legacy'])).toEqual(['primary-legacy'])
    for (const invalid of [null, [], '', [''], [1], ['foreign'], ['primary-legacy', 'primary-legacy']]) expect(() => validateTicketRepositoryIds(project, invalid)).toThrow()
    expect(() => resolveProjectRepository(project, '')).toThrow()
  })

  it('honors pinned project, preserves unscoped primary resolution and reports ambiguous shared secondary paths', () => {
    const a = addProject(db, { id: 'a', slug: 'a', name: 'A', path: mkdir('a') })
    const b = addProject(db, { id: 'b', slug: 'b', name: 'B', path: mkdir('b') })
    const shared = mkdir('shared')
    addProjectRepository(db, a.id, { path: shared }); addProjectRepository(db, b.id, { path: shared })
    addProjectRepository(db, a.id, { path: b.path })
    const projects = [getProject(db, a.id)!, getProject(db, b.id)!]
    expect(resolveRepositoryProject(projects, b.path)?.id).toBe('b')
    expect(resolveRepositoryProject(projects, b.path, a.id)?.id).toBe('a')
    expect(() => resolveRepositoryProject(projects, path.join(shared, 'src'))).toThrow('several projects')
    expect(resolveRepositoryProject(projects, path.join(shared, 'src'), b.id)?.id).toBe('b')
    expect(resolveRepositoryProject(projects, path.join(temp, 'ab'))).toBeUndefined()
  })

  it('rejects non-directory roots and invalid repository input', () => {
    const file = path.join(temp, 'file'); fs.writeFileSync(file, 'x')
    expect(() => inspectRepositoryPath({ path: file })).toThrow('unavailable')
    expect(() => inspectRepositoryPath({ path: temp, name: '' })).toThrow('name')
    expect(() => inspectRepositoryPath({ path: temp, integrationBranch: 'bad\nbranch' })).toThrow('integrationBranch')
    expect(() => assertDistinctRepositories([inspectRepositoryPath({ path: temp }), inspectRepositoryPath({ path: mkdir('nested') })])).toThrow('distinct')
  })
})
