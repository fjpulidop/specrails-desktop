import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from './db'
import { recordProvenanceForJob } from './file-provenance'
import { listCodeActivity, parseCodeActivityQuery, type CodeActivityPathFilter } from './code-activity'
import { createCodeExplorerRouter, filterCodeExplorerActivityPaths } from './code-explorer-router'
import { createProjectRouter } from './project-router'
import type { ProjectContext, ProjectRegistry } from './project-registry'
import type { ProjectRepository, RepositoryProject } from './project-repositories'

let db: DbInstance, root: string, project: RepositoryProject, repositories: ProjectRepository[]
beforeEach(() => {
  db = initDb(':memory:')
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-activity-'))
  repositories = ['frontend', 'backend'].map((id, index) => {
    const directory = path.join(root, id)
    fs.mkdirSync(directory)
    return { id, projectId: 'p', name: id, path: directory, isPrimary: index === 0, kind: 'folder', integrationBranch: null, addedAt: '' }
  })
  project = { id: 'p', path: repositories[0].path, repositories }
})
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
function record(repositoryId: string | undefined, filePath = 'src/index.ts', at = 10, ticketId = 7, jobId = 'run') {
  return recordProvenanceForJob(db, 'p', jobId, ticketId, [{ path: filePath, status: 'M' }], at,
    new Map([[filePath, { patch: `+${repositoryId ?? 'legacy'}`, truncated: repositoryId === 'backend' }]]), repositoryId)[0]
}
const allow: CodeActivityPathFilter = async (_repository, paths) => ({ allowed: new Set(paths) })
function app() {
  const context = { project: { ...project, slug: 'p', provider: 'claude' }, db, desktopDb: db,
    broadcast: vi.fn(), fileSummaryManager: { enqueue: vi.fn(), attachWatcher: vi.fn(), detachWatcher: vi.fn() } } as unknown as ProjectContext
  const registry = { getContext: () => context, getProjectRow: () => context.project, touchProject: vi.fn() } as unknown as ProjectRegistry
  return express().use('/projects', createProjectRouter(registry))
}

describe('bounded recorded code activity', () => {
  it('keeps identical paths, legacy primary records and stored patch metadata distinct', async () => {
    const legacy = record(undefined)
    const frontend = record('frontend')
    const backend = record('backend')
    record('foreign')
    const result = await listCodeActivity(db, project, { ticketId: 7 }, filterCodeExplorerActivityPaths)
    expect(result).toMatchObject({ nextCursor: null, truncated: false, warnings: [] })
    expect(result.entries.map(row => [row.id, row.repositoryId, row.hasPatch, row.patchTruncated])).toEqual([
      [backend.id, 'backend', true, true], [frontend.id, 'frontend', true, false], [legacy.id, 'frontend', true, false],
    ])
    expect(result.entries.every(row => row.path === 'src/index.ts')).toBe(true)
    expect(fs.existsSync(path.join(repositories[1].path, 'src/index.ts'))).toBe(false)
    expect((await listCodeActivity(db, project, { repositoryId: 'backend' }, allow)).entries.map(row => row.id)).toEqual([backend.id])
  })
  it('pages a stable timestamp/id snapshot without duplicates or late/backdated inserts', async () => {
    const older = record('frontend', 'old.ts', 1)
    const middle = record('frontend', 'middle.ts', 2)
    const newer = record('backend', 'new.ts', 2)
    const first = await listCodeActivity(db, project, { limit: 1 }, allow)
    expect(first.entries[0].id).toBe(newer.id)
    record('backend', 'late-new.ts', 3)
    record('frontend', 'late-backdated.ts', 0)
    const second = await listCodeActivity(db, project, { limit: 1, cursor: first.nextCursor! }, allow)
    const third = await listCodeActivity(db, project, { limit: 1, cursor: second.nextCursor! }, allow)
    expect(second.entries.map(row => row.id)).toEqual([middle.id])
    expect(third.entries.map(row => row.id)).toEqual([older.id])
    expect(third.nextCursor).toBeNull()
    await expect(listCodeActivity(db, project, { ticketId: 7, cursor: first.nextCursor! }, allow)).rejects.toThrow('invalid_activity_cursor')
    await expect(listCodeActivity(db, { ...project, repositories: [repositories[0]] }, { cursor: first.nextCursor! }, allow)).rejects.toThrow('invalid_activity_cursor')
  })
  it('filters denied paths and external symlinks without requiring historical files to exist', async () => {
    for (const file of ['.env', 'dist/build.js', 'dir/credentials.pem', '../outside.ts', 'linked.ts', 'gone.ts']) record('backend', file)
    fs.writeFileSync(path.join(root, 'outside.ts'), 'private')
    fs.symlinkSync(path.join(root, 'outside.ts'), path.join(repositories[1].path, 'linked.ts'))
    const result = await listCodeActivity(db, project, {}, filterCodeExplorerActivityPaths)
    expect(result.entries.map(row => row.path)).toEqual(['gone.ts'])
  })
  it('applies batched ignore results to every repository, including empty filtered pages', async () => {
    const old = record('frontend', 'public.ts', 1)
    for (let i = 0; i < 210; i++) record('backend', `ignored-${i}.ts`, 2)
    const filter = vi.fn<CodeActivityPathFilter>(async (_repo, paths) => ({ allowed: new Set(paths.filter(file => !file.startsWith('ignored-'))) }))
    const result = await listCodeActivity(db, project, { limit: 1 }, filter)
    expect(result.entries.map(row => row.id)).toEqual([old.id])
    expect(result.nextCursor).toBeNull()
    expect(filter.mock.calls.every(([, paths]) => paths.length <= 200)).toBe(true)
  })
  it('bounds scans through excluded history and allows advancing past it', async () => {
    const visible = record('frontend', 'public.ts', 1)
    const insert = db.prepare("INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at, repository_id) VALUES (?, 7, 'run', 'modified', 2, 'frontend')")
    db.transaction(() => { for (let i = 0; i < 2001; i++) insert.run(`.excluded-${i}`) })()
    const first = await listCodeActivity(db, project, { limit: 1 }, async (_repo, paths) => ({ allowed: new Set(paths.filter(file => !file.startsWith('.'))) }))
    expect(first.entries).toEqual([])
    expect(first).toMatchObject({ truncated: true, warnings: ['scan-limit'], nextCursor: expect.any(String) })
    const next = await listCodeActivity(db, project, { limit: 1, cursor: first.nextCursor! }, filterCodeExplorerActivityPaths)
    expect(next.entries.map(row => row.id)).toEqual([visible.id])
  })
  it('reports unavailable membership and ignore-policy failures instead of a complete empty result', async () => {
    record('backend')
    fs.rmSync(repositories[1].path, { recursive: true })
    const unavailable = await listCodeActivity(db, project, {}, filterCodeExplorerActivityPaths)
    expect(unavailable).toMatchObject({ entries: [], truncated: true, warnings: ['repository-unavailable:backend'] })
    const unverified = await listCodeActivity(db, project, {}, async () => ({ allowed: new Set(), incomplete: true }))
    expect(unverified).toMatchObject({ entries: [], truncated: true, warnings: ['ignore-unverified:backend'] })
  })
  it('validates bounded input and scope without accepting array query values or foreign cursors', async () => {
    for (const query of [{ limit: '101' }, { limit: '0' }, { limit: '1.5' }, { ticketId: '-1' }, { jobId: ['a', 'b'] }, { repositoryId: 'backend' }]) {
      expect(() => parseCodeActivityQuery(query, 'frontend')).toThrow()
    }
    await expect(listCodeActivity(db, project, { repositoryId: 'foreign' }, allow)).rejects.toThrow('repository_not_found')
    await expect(listCodeActivity(db, project, { cursor: 'garbage' }, allow)).rejects.toThrow('invalid_activity_cursor')
  })
})

describe('activity and aggregate provenance HTTP policy', () => {
  it('exposes project and scoped activity without starting any explanation generator', async () => {
    record('frontend')
    record('backend')
    const server = app()
    const aggregate = await request(server).get('/projects/p/code/activity?ticketId=7')
    expect(aggregate.status).toBe(200)
    expect(aggregate.body.entries.map((entry: { repositoryId: string }) => entry.repositoryId)).toEqual(['backend', 'frontend'])
    const scoped = await request(server).get('/projects/p/repositories/backend/code/activity?ticketId=7')
    expect(scoped.body.entries).toHaveLength(1)
    expect(scoped.body.entries[0].repositoryId).toBe('backend')
    expect((await request(server).get('/projects/p/code/activity?repositoryId=frontend')).body.entries).toHaveLength(1)
    expect((await request(server).get('/projects/p/repositories/foreign/code/activity')).status).toBe(404)
    expect((await request(server).get('/projects/p/repositories/backend/code/activity?repositoryId=frontend')).status).toBe(400)
    expect((await request(server).get('/projects/p/code/activity?limit=101')).status).toBe(400)
  })
  it('keeps stored patches readable for absent files and excludes denied aggregate metadata', async () => {
    record('backend', 'deleted.ts')
    record('backend', '.env')
    record('backend', 'node_modules/generated.js')
    const server = app()
    const provenance = await request(server).get('/projects/p/repositories/backend/code/provenance?ticketId=7')
    expect(provenance.status).toBe(200)
    expect(provenance.body.map((row: { path: string }) => row.path)).toEqual(['deleted.ts'])
    const byJob = await request(server).get('/projects/p/repositories/backend/code/provenance?jobId=run')
    expect(byJob.body.map((row: { path: string }) => row.path)).toEqual(['deleted.ts'])
    const patch = await request(server).get('/projects/p/repositories/backend/code/diff?jobId=run&path=deleted.ts')
    expect(patch.body).toMatchObject({ patch: '+backend', truncated: true })
    expect((await request(server).get('/projects/p/repositories/backend/code/diff?jobId=run&path=.env')).status).toBe(403)
  })
  it('supports a standalone mounted code router with legacy primary history', async () => {
    record(undefined, 'old.ts')
    const server = express().use('/code', createCodeExplorerRouter({ db, projectId: 'p', projectPath: repositories[0].path,
      broadcast: vi.fn(), fileSummaryManager: { enqueue: vi.fn(), attachWatcher: vi.fn() }, aiTransformProvider: 'claude' }))
    const result = await request(server).get('/code/activity')
    expect(result.status).toBe(200)
    expect(result.body.entries[0]).toMatchObject({ repositoryId: 'primary-p', path: 'old.ts' })
  })
})
