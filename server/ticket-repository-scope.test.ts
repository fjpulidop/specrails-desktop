import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, createConversation, addMessage, type DbInstance } from './db'
import { initDesktopDb, addProject } from './desktop-db'
import { createProjectRouter } from './project-router'
import { readStore, resolveTicketStoragePath } from './ticket-store'
import type { ProjectContext, ProjectRegistry } from './project-registry'

vi.mock('./contract-refine-runner', () => ({ runContractRefine: vi.fn().mockResolvedValue(undefined), runContractRefineForQuick: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./util/cli-prompt', async (actual) => ({ ...await actual<typeof import('./util/cli-prompt')>(), spawnAiCli: vi.fn(() => { throw new Error('No AI process is allowed in this test') }) }))

let temp: string, db: DbInstance, desktopDb: DbInstance, ctx: ProjectContext, app: express.Express
let scope: string[]
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-repository-scope-'))
  const primary = path.join(temp, 'app'), secondary = path.join(temp, 'api')
  fs.mkdirSync(primary); fs.mkdirSync(secondary)
  db = initDb(':memory:'); desktopDb = initDesktopDb(':memory:')
  const project = addProject(desktopDb, { id: 'p', slug: 'scope-project', name: 'Scope project', path: primary, repositories: [{ path: secondary }] })
  scope = project.repositories!.map((repo) => repo.id)
  ctx = { project, db, desktopDb, broadcast: vi.fn(), ticketWatcher: { notifyDesktopWrite: vi.fn() }, chatManager: { forgetSpecDraft: vi.fn(), forgetExploreLifecycle: vi.fn() } } as unknown as ProjectContext
  const registry = { desktopDb, touchProject: vi.fn(), getContext: (id: string) => id === 'p' ? ctx : undefined } as unknown as ProjectRegistry
  app = express(); app.use(express.json()); app.use('/api/projects', createProjectRouter(registry))
})
afterEach(() => { db.close(); desktopDb.close(); fs.rmSync(temp, { recursive: true, force: true }) })

describe('shared ticket repository scope', () => {
  it.each(['', '/generate-spec', '/save-as-draft', '/from-draft', '/from-prompt'])('rejects foreign selection before any authoring side effect at POST tickets%s', async (suffix) => {
    const response = await request(app).post(`/api/projects/p/tickets${suffix}`).send({ title: 'Scoped', idea: 'Scoped', description: 'Scoped', conversationId: 'none', repositoryIds: ['foreign-project-repository'] })
    expect(response.status).toBe(400)
    expect(response.body.code).toBe('invalid_repository_ids')
    expect(readStore(resolveTicketStoragePath(ctx.project.path)).tickets).toEqual({})
    expect(ctx.broadcast).not.toHaveBeenCalled()
  })

  it.each([[], ['primary-p', 'primary-p'], null, [7]].map((repositoryIds) => ({ repositoryIds })))('rejects malformed selection $repositoryIds', async ({ repositoryIds }) => {
    const response = await request(app).post('/api/projects/p/tickets').send({ title: 'Scoped', repositoryIds })
    expect(response.status).toBe(400)
    expect(response.body.code).toBe('invalid_repository_ids')
  })

  it('preserves selections through ordinary edits and rejects invalid PATCH without rewriting the shared store', async () => {
    const created = await request(app).post('/api/projects/p/tickets').send({ title: 'Both repos', repositoryIds: scope })
    expect(created.status).toBe(201)
    const file = resolveTicketStoragePath(ctx.project.path)
    const before = fs.readFileSync(file, 'utf8')
    const invalid = await request(app).patch('/api/projects/p/tickets/1').send({ title: 'Changed', repositoryIds: ['foreign'] })
    expect(invalid.status).toBe(400); expect(fs.readFileSync(file, 'utf8')).toBe(before)
    const edited = await request(app).patch('/api/projects/p/tickets/1').send({ title: 'Changed' })
    expect(edited.body.ticket.repositoryIds).toEqual(scope)
    const narrowed = await request(app).patch('/api/projects/p/tickets/1').send({ repositoryIds: [scope[1]] })
    expect(narrowed.body.ticket.repositoryIds).toEqual([scope[1]])
    const legacy = await request(app).post('/api/projects/p/tickets').send({ title: 'Legacy primary' })
    expect(legacy.body.ticket).not.toHaveProperty('repositoryIds')
  })

  it('keeps raw prompt and committed draft scopes in the same backlog sequence', async () => {
    const raw = await request(app).post('/api/projects/p/tickets/from-prompt').send({ description: 'Across app and API', repositoryIds: scope })
    expect(raw.status).toBe(201); expect(raw.body.ticket.repositoryIds).toEqual(scope)
    const committed = await request(app).post('/api/projects/p/tickets/from-draft').send({ title: 'API work', repositoryIds: [scope[1]] })
    expect(committed.status).toBe(201); expect(committed.body.ticket.id).toBe(2)
    expect(committed.body.ticket.repositoryIds).toEqual([scope[1]])
    expect(Object.keys(readStore(resolveTicketStoragePath(ctx.project.path)).tickets)).toEqual(['1', '2'])
  })

  it('preserves scope across save, update, commit, idempotent retry and continue editing', async () => {
    createConversation(db, { id: 'conversation', model: 'sonnet', kind: 'explore' })
    addMessage(db, { conversation_id: 'conversation', role: 'user', content: 'A feature across both repositories' })
    const saved = await request(app).post('/api/projects/p/tickets/save-as-draft').send({ conversationId: 'conversation', title: 'Feature', repositoryIds: scope })
    expect(saved.status).toBe(201); expect(saved.body.ticket.repositoryIds).toEqual(scope)
    const updated = await request(app).post('/api/projects/p/tickets/save-as-draft').send({ conversationId: 'conversation', title: 'Refined feature' })
    expect(updated.body.ticket.repositoryIds).toEqual(scope)
    const committed = await request(app).post('/api/projects/p/tickets/from-draft').send({ conversationId: 'conversation', draftTicketId: 1, title: 'Final feature' })
    expect(committed.status).toBe(201); expect(committed.body.ticket.repositoryIds).toEqual(scope)
    const retry = await request(app).post('/api/projects/p/tickets/from-draft').send({ conversationId: 'conversation', title: 'Retry', repositoryIds: [scope[0]] })
    expect(retry.body.ticket.id).toBe(1); expect(retry.body.ticket.repositoryIds).toEqual(scope)
    const editing = await request(app).post('/api/projects/p/tickets/save-as-draft').send({ conversationId: 'conversation', editTicketId: 1, repositoryIds: [scope[1]] })
    expect(editing.status).toBe(200); expect(editing.body.ticket.repositoryIds).toEqual([scope[1]])
    expect(Object.keys(readStore(resolveTicketStoragePath(ctx.project.path)).tickets)).toEqual(['1'])
  })
})
