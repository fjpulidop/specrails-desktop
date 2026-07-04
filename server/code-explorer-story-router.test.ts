import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, type DbInstance } from './db'
import { createCodeExplorerRouter } from './code-explorer-router'
import { recordProvenanceForJob, type StoredPatch } from './file-provenance'
import { setContributionSummary } from './file-story'
import type { ExplainResult } from './file-story-manager'

const PATCH = [
  'diff --git a/hello.ts b/hello.ts',
  '--- a/hello.ts',
  '+++ b/hello.ts',
  '@@ -1 +1,2 @@',
  '+export const y = 2',
  ' export const x = 1',
  '',
].join('\n')

let projectPath: string
let db: DbInstance
let app: express.Express
let explainSpy: ReturnType<typeof vi.fn>

function mountApp(withStoryManager = true): void {
  app = express()
  app.use(express.json())
  explainSpy = vi.fn(async (): Promise<ExplainResult> => 'generated')
  const router = createCodeExplorerRouter({
    db,
    projectPath,
    projectId: 'proj-test',
    broadcast: vi.fn(),
    fileSummaryManager: { enqueue: vi.fn(async () => 'enqueued' as const) as never, attachWatcher: vi.fn() as never },
    getTicketSpec: (id: number) => (id === 7 ? { id, title: 'Login screen', status: 'done' } : undefined),
    ...(withStoryManager ? { fileStoryManager: { explain: explainSpy as never } } : {}),
  })
  app.use('/api/projects/proj-test/code', router)
}

function seedIntervention(rel = 'hello.ts', ticketId: number | null = 7): number {
  const patches = new Map<string, StoredPatch>([[rel, { patch: PATCH, truncated: false }]])
  const rows = recordProvenanceForJob(db, 'proj-test', 'job-a', ticketId, [{ path: rel, status: 'M' }], 1000, patches)
  return rows[0].id
}

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'code-explorer-story-'))
  fs.writeFileSync(path.join(projectPath, 'hello.ts'), 'export const x = 1\n', 'utf8')
  db = initDb(':memory:')
  delete process.env.SPECRAILS_CODE_EXPLORER
  mountApp()
})

afterEach(() => {
  fs.rmSync(projectPath, { recursive: true, force: true })
  db.close()
  delete process.env.SPECRAILS_CODE_EXPLORER
})

describe('GET /file/story', () => {
  it('returns the chronological story with stats, ticket enrichment, and summary', async () => {
    const provenanceId = seedIntervention()
    setContributionSummary(db, provenanceId, 'Added the second export.', 'haiku', '2026-07-01T00:00:00.000Z')

    const res = await request(app).get('/api/projects/proj-test/code/file/story?path=hello.ts')
    expect(res.status).toBe(200)
    expect(res.body.path).toBe('hello.ts')
    expect(res.body.story).toHaveLength(1)
    const entry = res.body.story[0]
    expect(entry.provenanceId).toBe(provenanceId)
    expect(entry.jobId).toBe('job-a')
    expect(entry.kind).toBe('modified')
    expect(entry.addedLines).toBe(1)
    expect(entry.removedLines).toBe(0)
    expect(entry.hasPatch).toBe(true)
    expect(entry.summary).toBe('Added the second export.')
    expect(entry.ticket).toEqual({ id: 7, title: 'Login screen', status: 'done' })
  })

  it('returns an empty story for an untouched file', async () => {
    const res = await request(app).get('/api/projects/proj-test/code/file/story?path=hello.ts')
    expect(res.status).toBe(200)
    expect(res.body.story).toEqual([])
  })

  it('still tells the story of a deleted file', async () => {
    seedIntervention('gone.ts')
    const res = await request(app).get('/api/projects/proj-test/code/file/story?path=gone.ts')
    expect(res.status).toBe(200)
    expect(res.body.story).toHaveLength(1)
  })

  it('400s without a path and on traversal; 403s on the deny-list', async () => {
    expect((await request(app).get('/api/projects/proj-test/code/file/story')).status).toBe(400)
    expect((await request(app).get('/api/projects/proj-test/code/file/story?path=../../etc/passwd')).status).toBe(400)
    expect((await request(app).get('/api/projects/proj-test/code/file/story?path=.env')).status).toBe(403)
  })

  it('404s when the feature flag is off', async () => {
    process.env.SPECRAILS_CODE_EXPLORER = 'false'
    expect((await request(app).get('/api/projects/proj-test/code/file/story?path=hello.ts')).status).toBe(404)
  })
})

describe('POST /file/story/explain', () => {
  it('delegates to the story manager and returns ok', async () => {
    const provenanceId = seedIntervention()
    const res = await request(app)
      .post('/api/projects/proj-test/code/file/story/explain?path=hello.ts')
      .send({ provenanceId })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(explainSpy).toHaveBeenCalledWith({
      projectId: 'proj-test',
      relPath: 'hello.ts',
      provenanceId,
      overrideBudget: false,
    })
  })

  it('forwards overrideBudget and surfaces the budget skip as 200 + skipped', async () => {
    const provenanceId = seedIntervention()
    explainSpy.mockResolvedValueOnce('skipped:budget')
    const res = await request(app)
      .post('/api/projects/proj-test/code/file/story/explain?path=hello.ts')
      .send({ provenanceId, overrideBudget: true })
    expect(res.status).toBe(200)
    expect(res.body.skipped).toBe('budget')
    expect(explainSpy.mock.calls[0][0].overrideBudget).toBe(true)
  })

  it('maps not-found to 404 and failure to 500', async () => {
    const provenanceId = seedIntervention()
    explainSpy.mockResolvedValueOnce('skipped:not-found')
    expect((await request(app)
      .post('/api/projects/proj-test/code/file/story/explain?path=hello.ts')
      .send({ provenanceId })).status).toBe(404)
    explainSpy.mockResolvedValueOnce('failed')
    expect((await request(app)
      .post('/api/projects/proj-test/code/file/story/explain?path=hello.ts')
      .send({ provenanceId })).status).toBe(500)
  })

  it('validates provenanceId and guards the path', async () => {
    expect((await request(app)
      .post('/api/projects/proj-test/code/file/story/explain?path=hello.ts')
      .send({})).status).toBe(400)
    expect((await request(app)
      .post('/api/projects/proj-test/code/file/story/explain?path=hello.ts')
      .send({ provenanceId: -1 })).status).toBe(400)
    expect((await request(app)
      .post('/api/projects/proj-test/code/file/story/explain?path=../../x')
      .send({ provenanceId: 1 })).status).toBe(400)
    expect((await request(app)
      .post('/api/projects/proj-test/code/file/story/explain?path=.env')
      .send({ provenanceId: 1 })).status).toBe(403)
    expect(explainSpy).not.toHaveBeenCalled()
  })

  it('404s when no story manager is wired', async () => {
    mountApp(false)
    const res = await request(app)
      .post('/api/projects/proj-test/code/file/story/explain?path=hello.ts')
      .send({ provenanceId: 1 })
    expect(res.status).toBe(404)
  })
})
