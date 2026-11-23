import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { initDb, type DbInstance } from '../../../db'
import { createRailWorktree } from '../runtime/rail-worktrees-store'
import { registerRetainedWorktreeRoutes } from './retained-worktrees-http'
import type { ProjectContext } from '../../../project-registry'

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

let root: string
let repo: string
let db: DbInstance
let otherDb: DbInstance
let app: express.Express
let wt: string

function context(id: string, name: string, dir: string, database: DbInstance): ProjectContext {
  return { project: { id, name, path: dir, slug: id }, db: database, getTicketSpec: (ticketId: number) => ({ title: `Spec ${ticketId}` }) } as unknown as ProjectContext
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-retained-http-')))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  wt = path.join(root, 'wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt, 'HEAD')
  db = initDb(':memory:')
  otherDb = initDb(':memory:')
  createRailWorktree(db, { id: 'w1', railIndex: 1, ticketId: 7, branch: 'feat/x', worktreePath: wt, mergeState: 'needs-review' })
  db.prepare("UPDATE rail_worktrees SET updated_at = '2026-01-01 00:00:00'").run()
  const gitDir = path.join(repo, '.git', 'worktrees', 'wt')
  const then = new Date('2026-01-01T00:00:00Z')
  for (const file of ['index', 'HEAD', 'logs/HEAD']) if (fs.existsSync(path.join(gitDir, file))) fs.utimesSync(path.join(gitDir, file), then, then)
  const contexts = [context('p1', 'One', repo, db), context('p2', 'Two', path.join(root, 'empty'), otherDb)]
  app = express()
  app.use(express.json())
  const router = express.Router()
  registerRetainedWorktreeRoutes(router, {
    listContexts: () => contexts,
    getContext: (id: string) => contexts.find((ctx) => ctx.project.id === id),
  })
  app.use('/api', router)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('retained worktree routes', () => {
  it('lists every project with its items and labels', async () => {
    const res = await request(app).get('/api/worktrees/retained').expect(200)
    expect(res.body.projects).toEqual([{ projectId: 'p1', projectName: 'One' }, { projectId: 'p2', projectName: 'Two' }])
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0]).toMatchObject({ id: 'w1', projectId: 'p1', railIndex: 1, ticketId: 7, ticketTitle: 'Spec 7', branch: 'feat/x', evaluation: { label: 'nothing-to-lose' } })
  })

  it('scans sizes lazily and never for an unknown item', async () => {
    const first = await request(app).post('/api/worktrees/retained/sizes').send({ items: [{ projectId: 'p1', id: 'w1' }, { projectId: 'p2', id: 'w1' }] }).expect(200)
    expect(first.body.items[0].size.status).toBe('scanning')
    expect(first.body.items[1].size).toBeNull()
    let size = first.body.items[0].size
    for (let i = 0; i < 50 && size.status === 'scanning'; i++) {
      await new Promise((r) => setTimeout(r, 50))
      size = (await request(app).post('/api/worktrees/retained/sizes').send({ items: [{ projectId: 'p1', id: 'w1' }] })).body.items[0].size
    }
    expect(size.status).toBe('done')
    expect(size.bytes).toBeGreaterThan(0)
  })

  it('validates removal requests', async () => {
    await request(app).post('/api/worktrees/retained/remove').send({ items: 'nope' }).expect(400)
    await request(app).post('/api/worktrees/retained/remove').send({ items: [{ projectId: 'p1', id: 'w1', head: 'HEAD' }] }).expect(400)
  })

  it('removes a confirmed item through the release path and reports the rest', async () => {
    const head = git(wt, 'rev-parse', 'HEAD')
    const res = await request(app).post('/api/worktrees/retained/remove').send({ items: [
      { projectId: 'p1', id: 'w1', head, deleteBranch: true },
      { projectId: 'missing', id: 'w1', head, deleteBranch: false },
    ] }).expect(200)
    expect(res.body.results).toEqual([
      expect.objectContaining({ projectId: 'p1', id: 'w1', status: 'removed', branchDeleted: true }),
      expect.objectContaining({ projectId: 'missing', status: 'not-found' }),
    ])
    expect(fs.existsSync(wt)).toBe(false)
  })
})

describe('safety archive routes', () => {
  let home: string
  let previousHome: string | undefined
  let archivePath: string

  beforeEach(() => {
    previousHome = process.env.SPECRAILS_REGISTRY_HOME
    home = path.join(root, 'home')
    process.env.SPECRAILS_REGISTRY_HOME = home
    archivePath = path.join(home, '.specrails', 'projects', 'p1', 'worktrees', 'run-1', 'ticket-7.specrails-overlay-quarantine-Ab12Cd')
    fs.mkdirSync(path.join(archivePath, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(archivePath, 'CLAUDE.md'), 'edited\n')
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
    else process.env.SPECRAILS_REGISTRY_HOME = previousHome
  })

  it('lists archives per project and inspects one', async () => {
    const list = await request(app).get('/api/worktrees/quarantines').expect(200)
    expect(list.body.items).toEqual([expect.objectContaining({ projectId: 'p1', projectName: 'One', path: archivePath, fileCount: 1, worktreeName: 'ticket-7' })])
    expect(list.body.projects.map((project: { projectId: string }) => project.projectId)).toEqual(['p1', 'p2'])

    const inspect = await request(app).post('/api/worktrees/quarantines/inspect')
      .send({ items: [{ projectId: 'p1', path: archivePath }, { projectId: 'p2', path: archivePath }, { projectId: 'p1', path: `${archivePath}-gone` }] })
      .expect(200)
    expect(inspect.body.items.map((item: { status: string }) => item.status)).toEqual(['present', 'refused', 'refused'])
    expect(inspect.body.items[0].quarantine.files).toEqual([{ path: 'CLAUDE.md', kind: 'file', bytes: 7 }])
  })

  it('deletes only within the named project', async () => {
    const wrongProject = await request(app).post('/api/worktrees/quarantines/remove').send({ items: [{ projectId: 'p2', path: archivePath }] }).expect(200)
    expect(wrongProject.body.results[0]).toMatchObject({ status: 'refused', reason: 'outside-project' })
    expect(fs.existsSync(archivePath)).toBe(true)

    const ok = await request(app).post('/api/worktrees/quarantines/remove').send({ items: [{ projectId: 'p1', path: archivePath }] }).expect(200)
    expect(ok.body.results[0]).toMatchObject({ projectId: 'p1', status: 'deleted', fileCount: 1 })
    expect(fs.existsSync(archivePath)).toBe(false)

    const again = await request(app).post('/api/worktrees/quarantines/inspect').send({ items: [{ projectId: 'p1', path: archivePath }] }).expect(200)
    expect(again.body.items[0].status).toBe('missing')
    await request(app).post('/api/worktrees/quarantines/remove').send({ items: [] }).expect(400)
    await request(app).post('/api/worktrees/quarantines/remove').send({ items: [{ projectId: 'p1' }] }).expect(400)
  })
})
