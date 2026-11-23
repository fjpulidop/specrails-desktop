import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express, { Router } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDb } from './db'
import { registerAppResourceRoutes } from './app-resources-router'
import { createRailWorktree } from './modules/delivery/runtime/rail-worktrees-store'
import { runPortLeases } from './modules/terminals/runtime/run-port-leases'

const ORIG_HOME = process.env.SPECRAILS_REGISTRY_HOME
let home = ''
afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
  else process.env.SPECRAILS_REGISTRY_HOME = ORIG_HOME
  fs.rmSync(home, { recursive: true, force: true })
})
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ports-route-')))
  process.env.SPECRAILS_REGISTRY_HOME = home
})

describe('GET /api/resources/ports', () => {
  it('labels each listening port with its rail run and flags squatters', async () => {
    const worktree = path.join(home, '.specrails', 'projects', 'app', 'worktrees', 'run-1', 'ticket-7')
    fs.mkdirSync(worktree, { recursive: true })
    const lease = runPortLeases.lease(worktree)!
    const db = initDb(':memory:')
    createRailWorktree(db, { id: 'w1', railIndex: 1, ticketId: 7, runId: 'run-1', branch: 'feat/7-x', worktreePath: worktree })
    const registry = { listContexts: () => [{ db, project: { id: 'p1', name: 'Web app' } }], getProjectRow: () => undefined, desktopDb: undefined }
    const app = express()
    const router = Router()
    registerAppResourceRoutes(router, registry as never, {
      readProcessTable: async () => [],
      readListeners: async () => ({ supported: true, scannedAt: 5, listeners: [
        { port: lease.start, host: '*', pid: 10, command: 'node', cwd: path.join(worktree, 'web') },
        { port: lease.start + 1, host: '*', pid: 11, command: 'python', cwd: '/tmp' },
        { port: 5432, host: '*', pid: 12, command: 'postgres', cwd: '/' },
      ] }),
    })
    app.use('/api', router)
    const res = await request(app).get('/api/resources/ports').expect(200)
    const run = { projectId: 'p1', projectName: 'Web app', railIndex: 1, ticketId: 7, branch: 'feat/7-x', runId: 'run-1' }
    expect(res.body.supported).toBe(true)
    expect(res.body.ports).toEqual([
      expect.objectContaining({ port: lease.start, confidence: 'cwd', squatting: false, worktreePath: worktree, assigned: { start: lease.start, end: lease.end }, run }),
      expect.objectContaining({ port: lease.start + 1, confidence: 'none', squatting: true, run }),
    ])
    expect(res.body.leases).toEqual([{ worktreePath: worktree, start: lease.start, end: lease.end, run }])
  })
})
