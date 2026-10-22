import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import { createRailsRouter } from './rails-router'
import { setRailTickets } from './rails-store'

const { mockRepoStatus, mockLaunchIsolated } = vi.hoisted(() => ({ mockRepoStatus: vi.fn(), mockLaunchIsolated: vi.fn() }))
vi.mock('../../agent-runtime/runtime/agent-runtime-loader', () => ({ loadCoreAgentRuntime: async () => ({ api: { capabilities: {} } }) }))
vi.mock('../../../worktree-manager', async (importActual) => ({
  ...(await (importActual as () => Promise<Record<string, unknown>>)()),
  repoIsolationStatus: mockRepoStatus,
}))
vi.mock('./rail-isolated-launch', async (importActual) => ({
  ...(await (importActual as () => Promise<Record<string, unknown>>)()),
  launchIsolatedRail: mockLaunchIsolated,
}))

let db: DbInstance
let desktopDb: DbInstance
let repo: string
beforeEach(() => {
  db = initDb(':memory:')
  desktopDb = initDesktopDb(':memory:')
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rails-triage-'))
  mockRepoStatus.mockReset().mockResolvedValue('ok')
  mockLaunchIsolated.mockReset().mockResolvedValue(['run-1'])
})
afterEach(() => { db.close(); desktopDb.close(); fs.rmSync(repo, { recursive: true, force: true }) })

function writeTickets(triage: Record<number, unknown>) {
  fs.mkdirSync(path.join(repo, '.specrails'), { recursive: true })
  const tickets = Object.fromEntries([7, 8].map((id) => [String(id), {
    id, title: `T${id}`, description: 'D', status: 'todo', priority: null, labels: [], assignee: null, prerequisites: [],
    metadata: triage[id] ? { triage: triage[id] } : {}, origin_conversation_id: null, is_epic: false, parent_epic_id: null,
    execution_order: null, short_summary: null, created_at: 'x', updated_at: 'x', created_by: 'u', source: 'manual',
  }]))
  fs.writeFileSync(path.join(repo, '.specrails', 'local-tickets.json'), JSON.stringify({ schema_version: '1.5', revision: 1, last_updated: 'x', next_id: 9, tickets }))
}

function app() {
  const instance = express()
  instance.use(express.json())
  instance.use((req, _res, next) => {
    ;(req as unknown as { projectCtx: unknown }).projectCtx = {
      db, desktopDb, railJobs: new Map(), railLoopRuns: new Map(),
      project: { id: 'p1', slug: 'rails-triage-test', provider: 'claude', providers: ['claude'], path: repo },
      broadcast: () => {}, loopRunManager: { run: vi.fn(), cancel: vi.fn() },
      getTicketSpec: (id: number) => ({ id, title: 'T', description: 'D' }),
      onLoopRunFinished: () => {},
    }
    next()
  })
  instance.use('/rails', createRailsRouter())
  return instance
}

const ready = (loop: string) => ({ status: 'ready', size: 'S', recommendedLoop: loop, inputsHash: 'sha256:h', computedAt: 't' })

describe('rail launch records the triage loop choice', () => {
  it('passes the first triaged spec recommendation and the launched loop', async () => {
    writeTickets({ 8: ready('factory:sdd-quick-openspec') })
    setRailTickets(db, 0, [7, 8], 'implement')
    const res = await request(app()).post('/rails/0/launch').send({ loopId: 'factory:implement' })
    expect(res.status).toBe(202)
    expect(mockLaunchIsolated).toHaveBeenCalledWith(expect.objectContaining({
      loopChoice: { recommendedLoop: 'factory:sdd-quick-openspec', chosenLoop: 'factory:implement' },
    }))
  })

  it('records a null recommendation when no spec is triaged', async () => {
    writeTickets({})
    setRailTickets(db, 0, [7], 'implement')
    await request(app()).post('/rails/0/launch').send({ loopId: 'factory:implement' })
    expect(mockLaunchIsolated).toHaveBeenCalledWith(expect.objectContaining({ loopChoice: { recommendedLoop: null, chosenLoop: 'factory:implement' } }))
  })
})
