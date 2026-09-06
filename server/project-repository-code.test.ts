import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import express from 'express'
import request from 'supertest'
import { EventEmitter } from 'node:events'
import { initDb, type DbInstance } from './db'
import { migrateRepositoryProvenance } from './project-repository-provenance'
import { recordProvenanceForJob, getProvenanceDiff, listProvenanceByPath } from './file-provenance'
import { getFileStory } from './file-story'
import { FileStoryManager } from './file-story-manager'
import { FileSummaryManager, repositorySummaryRoot, readSummary, writeSummary, __resetDesktopSummaryStateForTests, type GenerateOutput } from './file-summary-manager'
import { discoverProjectCode } from './project-code-discovery'
import { createCodeExplorerRouter, gitIgnoredSet } from './code-explorer-router'
import { createProjectRouter } from './project-router'
import type { ProjectContext, ProjectRegistry } from './project-registry'
import type { ProjectRepository, RepositoryProject } from './project-repositories'

let root: string, db: DbInstance, repositories: ProjectRepository[], project: RepositoryProject
const disposals: Array<() => void> = []
const write = (dir: string, relative: string, contents: string) => {
  const target = path.join(dir, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
}
const output = (summary = 'Summary'): GenerateOutput => ({ summary, model: 'test-model', provider: 'claude', costUsd: 0.01, tokensIn: 5, tokensOut: 5, durationMs: 1 })
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-repository-code-'))
  db = initDb(':memory:')
  migrateRepositoryProvenance(db)
  __resetDesktopSummaryStateForTests()
  repositories = ['app', 'api'].map((id, index) => {
    const directory = path.join(root, id)
    write(directory, 'src/index.ts', `export const name = '${id}'; // needle\n`)
    return { id, projectId: 'p', name: id, path: directory, isPrimary: index === 0, kind: 'folder', integrationBranch: null, addedAt: '' }
  })
  project = { id: 'p', name: 'Shared product', path: repositories[0].path, repositories }
})
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('repository code discovery', () => {
  it('finds identical relative paths with separate addresses and one result limit', async () => {
    const all = await discoverProjectCode(project, { kind: 'find', query: 'index.ts' })
    expect(all.matches.map(match => match.repositoryId)).toEqual(['app', 'api'])
    expect(all.matches.every(match => match.path === 'src/index.ts')).toBe(true)
    const limited = await discoverProjectCode(project, { kind: 'find', query: 'index.ts', limit: 1 })
    expect(limited.matches).toHaveLength(1)
    expect(limited.truncated).toBe(true)
  })

  it('searches non-Git context folders and distinguishes missing members from empty results', async () => {
    write(repositories[1].path, 'server.ts', 'only-backend-symbol')
    const found = await discoverProjectCode(project, { kind: 'search', query: 'only-backend-symbol' })
    expect(found.matches).toMatchObject([{ repositoryId: 'api', path: 'server.ts', lineNumber: 1 }])
    fs.rmSync(repositories[1].path, { recursive: true })
    const missing = await discoverProjectCode(project, { kind: 'search', query: 'absent' })
    expect(missing.truncated).toBe(true)
    expect(missing.repositories).toContainEqual(expect.objectContaining({ repositoryId: 'api', status: 'unavailable' }))
  })

  it('enforces a shared scan budget and keeps oversize or incomplete results explicit', async () => {
    const many = await discoverProjectCode(project, { kind: 'search', query: 'needle', limit: 1 })
    expect(many.matches).toHaveLength(1)
    expect(many.scan.unscannedRepositories).toBe(1)
    expect(many.truncationReasons).toContain('unscanned-repositories')
    await expect(discoverProjectCode(project, { kind: 'search', query: 'needle', path: '../api' })).rejects.toThrow('invalid_discovery_path')
    await expect(discoverProjectCode(project, { kind: 'find', query: 'x', limit: 0 })).rejects.toThrow('invalid_discovery_limit')
  })

  it('never follows external symlinks or reads a gitignored explicit file', async () => {
    const dir = repositories[0].path
    execFileSync('git', ['init', '-q'], { cwd: dir })
    write(dir, '.gitignore', 'ignored.txt\n')
    write(dir, 'ignored.txt', 'private-symbol')
    write(root, 'outside.txt', 'private-symbol')
    fs.symlinkSync(path.join(root, 'outside.txt'), path.join(dir, 'linked.txt'))
    expect((await discoverProjectCode(project, { kind: 'search', query: 'private-symbol' })).matches).toEqual([])
    expect((await discoverProjectCode(project, { kind: 'search', query: 'private-symbol', path: 'ignored.txt' })).matches).toEqual([])
  })
  it('fails closed if the shared budget cannot verify Git ignore rules', async () => {
    execFileSync('git', ['init', '-q'], { cwd: repositories[0].path })
    const ignored = await gitIgnoredSet(repositories[0].path, ['private.txt', 'public.ts'], 0)
    expect(ignored.incomplete).toBe(true)
    expect([...ignored]).toEqual(['private.txt', 'public.ts'])
    const folder = await gitIgnoredSet(repositories[1].path, ['readable.txt'], 0)
    expect(folder.size).toBe(0)
  })
})

describe('repository provenance and summaries', () => {
  function record(repositoryId?: string, patch = '+change') {
    return recordProvenanceForJob(db, 'p', 'shared-run', 1, [{ path: 'src/index.ts', status: 'M' }], Date.now(), new Map([['src/index.ts', { patch, truncated: false }]]), repositoryId)[0]
  }
  it('migrates idempotently and only exposes legacy rows in primary history', () => {
    const legacy = record(undefined, '+legacy')
    const app = record('app', '+app')
    const api = record('api', '+api')
    migrateRepositoryProvenance(db)
    const primary = { repositoryId: 'app', includeLegacy: true }
    expect(new Set(listProvenanceByPath(db, 'p', 'src/index.ts', primary).map(row => row.id))).toEqual(new Set([legacy.id, app.id]))
    expect(listProvenanceByPath(db, 'p', 'src/index.ts', { repositoryId: 'api' }).map(row => row.id)).toEqual([api.id])
    expect(getProvenanceDiff(db, 'p', 'shared-run', 'src/index.ts', primary)?.patch).toBe('+app')
    expect(getProvenanceDiff(db, 'p', 'shared-run', 'src/index.ts', { repositoryId: 'api' })?.patch).toBe('+api')
    expect(getFileStory(db, 'src/index.ts', undefined, { repositoryId: 'api' }).map(row => row.provenanceId)).toEqual([api.id])
  })
  it('rejects a story ID from a different repository even when its path matches', async () => {
    const app = record('app')
    const generate = vi.fn(async () => output())
    const manager = new FileStoryManager({ db, broadcast: vi.fn(), generate, monthlyBudgetUsd: () => 5, monthToDateSpend: () => 0 })
    expect(await manager.explain({ projectId: 'p', relPath: 'src/index.ts', provenanceId: app.id, repository: { repositoryId: 'api' } })).toBe('skipped:not-found')
    expect(generate).not.toHaveBeenCalled()
  })
  it('does not coalesce two repository files and stores separate summaries under the shared artifact root', async () => {
    const broadcast = vi.fn()
    const generate = vi.fn(async input => output(input.contents))
    const manager = new FileSummaryManager({ db, broadcast, generate, monthlyBudgetUsd: () => 5, monthToDateSpend: () => 0 })
    disposals.push(() => manager.dispose())
    await Promise.all(repositories.map(repository => manager.enqueue({ projectId: 'p', projectSlug: 'p', repositoryId: repository.id, projectPath: repository.path, summaryRoot: repositorySummaryRoot(root, repository), relPath: 'src/index.ts', triggeredBy: { kind: 'user', id: 'manual', ticketId: null } })))
    expect(generate).toHaveBeenCalledTimes(2)
    expect(repositorySummaryRoot(root, repositories[0])).toBe(root)
    for (const repository of repositories) {
      expect(readSummary(repositorySummaryRoot(root, repository), 'src/index.ts')?.summary).toContain(`'${repository.id}'`)
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'file.summary_updated', projectId: 'p', repositoryId: repository.id }))
    }
  })
  it('keeps concurrent repository summaries within one project budget', async () => {
    let release!: (value: GenerateOutput) => void
    const generate = vi.fn(() => new Promise<GenerateOutput>(resolve => { release = resolve }))
    const manager = new FileSummaryManager({ db, broadcast: vi.fn(), generate, monthlyBudgetUsd: () => 0.01, monthToDateSpend: () => 0 })
    disposals.push(() => manager.dispose())
    const enqueue = (repository: ProjectRepository) => manager.enqueue({ projectId: 'p', projectSlug: 'p', repositoryId: repository.id, projectPath: repository.path, summaryRoot: repositorySummaryRoot(root, repository), relPath: 'src/index.ts', triggeredBy: { kind: 'user', id: 'manual', ticketId: null } })
    const first = enqueue(repositories[0])
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    expect(await enqueue(repositories[1])).toBe('skipped:budget')
    release(output())
    await first
    expect(generate).toHaveBeenCalledTimes(1)
  })
  it('keeps source watchers separate and detaches only the selected repository', () => {
    const close = [vi.fn(), vi.fn()]
    let index = 0
    const fsWatch = vi.fn(() => Object.assign(new EventEmitter(), { close: close[index++] }))
    const manager = new FileSummaryManager({ db, broadcast: vi.fn(), generate: async () => output(), monthlyBudgetUsd: () => 5, monthToDateSpend: () => 0, watchEngine: 'native', fsWatch: fsWatch as never })
    disposals.push(() => manager.dispose())
    for (const repository of repositories) manager.attachWatcher('p', repository.path, repositorySummaryRoot(root, repository), repository.id)
    expect(fsWatch).toHaveBeenCalledTimes(2)
    manager.detachWatcher('p', 'api')
    expect(close[1]).toHaveBeenCalledTimes(1)
    expect(close[0]).not.toHaveBeenCalled()
    expect(manager.watcherStatus('p', 'app')).toBe('native')
  })
})

describe('repository code routes', () => {
  it('keeps content, provenance and summaries distinct at the HTTP boundary', async () => {
    const app = express()
    for (const repository of repositories) {
      const artifactRoot = repositorySummaryRoot(root, repository)
      writeSummary(artifactRoot, 'src/index.ts', { schemaVersion: 1, path: 'src/index.ts', fileHash: 'a'.repeat(64), summary: repository.name, language: 'en', generatedAt: '2026-01-01T00:00:00Z', generatedBy: { model: 'test', promptVersion: 1 }, triggeredBy: { kind: 'user', id: 'manual', ticketId: null } })
      recordProvenanceForJob(db, 'p', 'run', 1, [{ path: 'src/index.ts', status: 'M' }], 1, undefined, repository.id)
      app.use(`/${repository.id}`, createCodeExplorerRouter({ db, projectId: 'p', projectPath: repository.path, repositoryId: repository.id, includeLegacyProvenance: repository.isPrimary, resolveSummaryRoot: () => artifactRoot, broadcast: vi.fn(), fileSummaryManager: { enqueue: vi.fn(), attachWatcher: vi.fn() }, aiTransformProvider: 'claude' }))
    }
    for (const repository of repositories) {
      const file = await request(app).get(`/${repository.id}/file`).query({ path: 'src/index.ts' })
      expect(file.status).toBe(200)
      expect(file.body).toMatchObject({ repositoryId: repository.id, summary: { summary: repository.name }, provenance: [{ repositoryId: repository.id }] })
      expect(file.body.content).toContain(`'${repository.id}'`)
      expect((await request(app).get(`/${repository.id}/tree`).query({ filter: 'all' })).body.entries.every((entry: { repositoryId: string }) => entry.repositoryId === repository.id)).toBe(true)
    }
  })
  it('revalidates membership before using a cached router and keeps legacy routes on primary', async () => {
    const detachWatcher = vi.fn()
    const context = { project: { ...project, slug: 'p', provider: 'claude', providers: ['claude'] }, db, desktopDb: db, broadcast: vi.fn(), fileSummaryManager: { enqueue: vi.fn(), attachWatcher: vi.fn(), detachWatcher }, getTicketSpec: vi.fn() } as unknown as ProjectContext
    const registry = { getContext: () => context, getProjectRow: () => context.project, touchProject: vi.fn() } as unknown as ProjectRegistry
    const app = express().use('/projects', createProjectRouter(registry))
    const endpoint = '/projects/p/repositories/api/code/file?path=src/index.ts&startLine=1'
    expect((await request(app).get(endpoint)).body.content).toContain("'api'")
    expect((await request(app).get('/projects/p/code/file?path=src/index.ts&startLine=1')).body.content).toContain("'app'")
    const relocated = path.join(root, 'relocated-api')
    write(relocated, 'src/index.ts', 'relocated backend')
    context.project.repositories = [repositories[0], { ...repositories[1], path: relocated }]
    expect((await request(app).get(endpoint)).body.content).toBe('relocated backend')
    context.project.repositories = [repositories[0]]
    expect((await request(app).get(endpoint)).status).toBe(404)
    await request(app).get('/projects/p/code/file?path=src/index.ts&startLine=1')
    expect(detachWatcher).toHaveBeenCalledWith('p', 'api')
    expect((await request(app).get('/projects/p/repositories/foreign/code/file?path=src/index.ts')).status).toBe(404)
  })
  it('routes Git reads to the chosen member and refuses Git actions for context folders', async () => {
    for (const repository of repositories) {
      execFileSync('git', ['init', '-q', '-b', `${repository.id}-main`], { cwd: repository.path })
      execFileSync('git', ['add', '.'], { cwd: repository.path })
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'], { cwd: repository.path })
      execFileSync('git', ['branch', 'feature'], { cwd: repository.path })
      repository.kind = 'git'
    }
    const folder = { ...repositories[1], id: 'docs', name: 'Docs', path: path.join(root, 'docs'), kind: 'folder' as const }
    fs.mkdirSync(folder.path)
    project.repositories!.push(folder)
    const context = { project: { ...project, slug: 'p', provider: 'claude' }, db, desktopDb: db, broadcast: vi.fn(), fileSummaryManager: { enqueue: vi.fn(), attachWatcher: vi.fn(), detachWatcher: vi.fn() } } as unknown as ProjectContext
    const registry = { getContext: () => context, getProjectRow: () => context.project, touchProject: vi.fn() } as unknown as ProjectRegistry
    const app = express().use(express.json()).use('/projects', createProjectRouter(registry))
    expect((await request(app).get('/projects/p/git')).body).toMatchObject({ git: true, branch: 'app-main', repositoryId: 'app' })
    expect((await request(app).get('/projects/p/repositories/api/git')).body).toMatchObject({ git: true, branch: 'api-main', repositoryId: 'api' })
    expect((await request(app).get('/projects/p/repositories/docs/git')).body).toEqual({ git: false, repositoryId: 'docs' })
    expect((await request(app).get('/projects/p/repositories/docs/git/diagnostic?action=status')).status).toBe(409)
    expect((await request(app).get('/projects/p/repositories/foreign/git')).status).toBe(404)
    expect((await request(app).post('/projects/p/git/checkout').send({ branch: 'feature' })).status).toBe(400)
    expect((await request(app).post('/projects/p/repositories/api/git/checkout').send({ branch: 'feature', repositoryId: 'app' })).status).toBe(400)
    expect((await request(app).post('/projects/p/git/checkout').send({ branch: 'feature', repositoryId: 'foreign' })).status).toBe(404)
    expect((await request(app).post('/projects/p/repositories/docs/git/checkout').send({ branch: 'feature' })).status).toBe(409)
    const checkout = await request(app).post('/projects/p/repositories/api/git/checkout').send({ branch: 'feature', repositoryId: 'api' })
    expect(checkout.status).toBe(200)
    expect(checkout.body).toMatchObject({ repositoryId: 'api', branch: 'feature' })
    expect((await request(app).get('/projects/p/git')).body.branch).toBe('app-main')
  })
})
