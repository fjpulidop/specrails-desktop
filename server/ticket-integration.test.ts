/**
 * Track E — Integration tests
 *
 * Verifies that REST endpoint operations are fully reflected on disk,
 * completing the app↔filesystem contract.
 *
 * Unlike ticket-store.test.ts (which asserts HTTP responses), these tests
 * read the actual JSON file from disk after each operation.
 *
 * Requires: chokidar installed (now available after SPEA-662 merge)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'
import { vi } from 'vitest'

import { createProjectRouter } from './project-router'
import { initDb } from './db'
import { initDesktopDb } from './desktop-db'
import { TicketWatcher } from './modules/specs/runtime/ticket-watcher'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import type { DbInstance } from './db'
import type { TicketStore } from './modules/specs/runtime/ticket-store'

// ─── Test infrastructure (mirrors ticket-store.test.ts) ───────────────────────

function makeQueueManager() {
  return {
    enqueue: vi.fn(() => ({ id: 'job-1', queuePosition: 0 })),
    cancel: vi.fn(() => 'canceled'),
    pause: vi.fn(),
    resume: vi.fn(),
    reorder: vi.fn(),
    getJobs: vi.fn(() => []),
    isPaused: vi.fn(() => false),
    getActiveJobId: vi.fn(() => null),
    phasesForCommand: vi.fn(() => []),
  }
}

function makeSetupManager() {
  return {
    isInstalling: vi.fn(() => false),
    isSettingUp: vi.fn(() => false),
    startInstall: vi.fn(),
    startSetup: vi.fn(),
    resumeSetup: vi.fn(),
    abort: vi.fn(),
    getCheckpointStatus: vi.fn(() => []),
    getInstallLog: vi.fn(() => []),
  }
}

function makeChatManager() {
  return { isActive: vi.fn(() => false), sendMessage: vi.fn(async () => {}), abort: vi.fn() }
}

function makeProposalManager() {
  return {
    isActive: vi.fn(() => false),
    startExploration: vi.fn(async () => {}),
    sendRefinement: vi.fn(async () => {}),
    createIssue: vi.fn(async () => {}),
    cancel: vi.fn(),
  }
}

function makeSpecLauncherManager() {
  return { isActive: vi.fn(() => false), launch: vi.fn(async () => {}), cancel: vi.fn() }
}

function makeContext(db: DbInstance, projectPath: string): ProjectContext & { broadcast: ReturnType<typeof vi.fn> } {
  const broadcast = vi.fn()
  return {
    project: { id: 'proj-1', slug: 'proj', name: 'Test Project', path: projectPath, db_path: ':memory:', added_at: '', last_seen_at: '' },
    db,
    queueManager: makeQueueManager() as any,
    chatManager: makeChatManager() as any,
    setupManager: makeSetupManager() as any,
    proposalManager: makeProposalManager() as any,
    specLauncherManager: makeSpecLauncherManager() as any,
    ticketWatcher: { notifyDesktopWrite: vi.fn(), start: vi.fn(), close: vi.fn() } as any,
    broadcast,
  } as any
}

function makeRegistry(contexts: Map<string, ProjectContext>): ProjectRegistry {
  const desktopDb = initDesktopDb(':memory:')
  return {
    desktopDb,
    getContext: vi.fn((id: string) => contexts.get(id)),
    getContextByPath: vi.fn(() => undefined),
    addProject: vi.fn() as any,
    removeProject: vi.fn(),
    touchProject: vi.fn(),
    listContexts: vi.fn(() => Array.from(contexts.values())),
  } as unknown as ProjectRegistry
}

function createApp(contexts: Map<string, ProjectContext> = new Map()) {
  const registry = makeRegistry(contexts)
  const router = createProjectRouter(registry)
  const app = express()
  app.use(express.json())
  app.use('/api/projects', router)
  return { app, registry }
}

function readDiskStore(tmpDir: string, contractPath?: string): TicketStore {
  const filePath = contractPath ?? path.join(tmpDir, '.specrails', 'local-tickets.json')
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TicketStore
}

// ─── Suite setup ──────────────────────────────────────────────────────────────

let db: DbInstance
let tmpDir: string

beforeEach(() => {
  db = initDb(':memory:')
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-integration-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── E1: POST /tickets → file on disk reflects correct JSON ───────────────────

describe('E1: POST /tickets persists correct JSON to disk', () => {
  it('creates the ticket file with correct schema_version and revision', async () => {
    const ctx = makeContext(db, tmpDir)
    const { app } = createApp(new Map([['proj-1', ctx]]))

    await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Disk test' })

    const store = readDiskStore(tmpDir)
    expect(store.schema_version).toBe('1.4')
    expect(store.revision).toBe(1)
    expect(typeof store.last_updated).toBe('string')
    expect(store.next_id).toBe(2)
  })

  it('persists ticket with all default fields to disk', async () => {
    const ctx = makeContext(db, tmpDir)
    const { app } = createApp(new Map([['proj-1', ctx]]))

    await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Defaults on disk' })

    const store = readDiskStore(tmpDir)
    const ticket = store.tickets['1']

    expect(ticket).toBeDefined()
    expect(ticket.id).toBe(1)
    expect(ticket.title).toBe('Defaults on disk')
    expect(ticket.status).toBe('todo')
    expect(ticket.priority).toBe('medium')
    expect(ticket.labels).toEqual([])
    expect(ticket.assignee).toBeNull()
    expect(ticket.prerequisites).toEqual([])
    expect(ticket.source).toBe('hub') // legacy on-disk wire value
    expect(typeof ticket.created_at).toBe('string')
    expect(typeof ticket.updated_at).toBe('string')
  })

  it('persists ticket with all explicit fields to disk', async () => {
    const ctx = makeContext(db, tmpDir)
    const { app } = createApp(new Map([['proj-1', ctx]]))

    await request(app).post('/api/projects/proj-1/tickets').send({
      title: 'Full ticket',
      description: 'Detailed description',
      status: 'in_progress',
      priority: 'critical',
      labels: ['bug', 'area:backend'],
      assignee: 'alice',
      prerequisites: [5, 6],
      metadata: { effort_level: 'Large' },
    })

    const store = readDiskStore(tmpDir)
    const ticket = store.tickets['1']

    expect(ticket.description).toBe('Detailed description')
    expect(ticket.status).toBe('in_progress')
    expect(ticket.priority).toBe('critical')
    expect(ticket.labels).toEqual(['bug', 'area:backend'])
    expect(ticket.assignee).toBe('alice')
    expect(ticket.prerequisites).toEqual([5, 6])
    expect(ticket.metadata.effort_level).toBe('Large')
  })

  it('increments revision and next_id for each successive POST', async () => {
    const ctx = makeContext(db, tmpDir)
    const { app } = createApp(new Map([['proj-1', ctx]]))

    await request(app).post('/api/projects/proj-1/tickets').send({ title: 'First' })
    await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Second' })
    await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Third' })

    const store = readDiskStore(tmpDir)
    expect(store.revision).toBe(3)
    expect(store.next_id).toBe(4)
    expect(Object.keys(store.tickets)).toHaveLength(3)
    expect(store.tickets['1'].title).toBe('First')
    expect(store.tickets['2'].title).toBe('Second')
    expect(store.tickets['3'].title).toBe('Third')
  })
})

// ─── E2: PATCH /tickets/:id → disk reflects update ───────────────────────────

describe('E2: PATCH /tickets/:id updates JSON on disk', () => {
  it('reflects updated fields in the JSON file', async () => {
    const ctx = makeContext(db, tmpDir)
    const { app } = createApp(new Map([['proj-1', ctx]]))

    await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Original' })
    await request(app).patch('/api/projects/proj-1/tickets/1').send({
      title: 'Updated',
      status: 'done',
      priority: 'high',
      labels: ['area:frontend'],
    })

    const store = readDiskStore(tmpDir)
    expect(store.revision).toBe(2)
    const ticket = store.tickets['1']
    expect(ticket.title).toBe('Updated')
    expect(ticket.status).toBe('done')
    expect(ticket.priority).toBe('high')
    expect(ticket.labels).toEqual(['area:frontend'])
  })

  it('merges metadata on disk (does not replace)', async () => {
    const ctx = makeContext(db, tmpDir)
    const { app } = createApp(new Map([['proj-1', ctx]]))

    await request(app).post('/api/projects/proj-1/tickets').send({
      title: 'Meta',
      metadata: { effort_level: 'Small', area: 'api' },
    })
    await request(app).patch('/api/projects/proj-1/tickets/1').send({
      metadata: { effort_level: 'Large' },
    })

    const store = readDiskStore(tmpDir)
    const ticket = store.tickets['1']
    expect(ticket.metadata.effort_level).toBe('Large')
    expect(ticket.metadata.area).toBe('api') // preserved
  })
})

// ─── E3: DELETE /tickets/:id → ticket absent from disk ───────────────────────

describe('E3: DELETE /tickets/:id removes ticket from JSON file', () => {
  it('removes the ticket key from the on-disk tickets map', async () => {
    const ctx = makeContext(db, tmpDir)
    const { app } = createApp(new Map([['proj-1', ctx]]))

    await request(app).post('/api/projects/proj-1/tickets').send({ title: 'To remove' })
    await request(app).delete('/api/projects/proj-1/tickets/1')

    const store = readDiskStore(tmpDir)
    expect(store.tickets['1']).toBeUndefined()
    expect(Object.keys(store.tickets)).toHaveLength(0)
  })

  it('increments revision after delete', async () => {
    const ctx = makeContext(db, tmpDir)
    const { app } = createApp(new Map([['proj-1', ctx]]))

    await request(app).post('/api/projects/proj-1/tickets').send({ title: 'T1' })
    await request(app).delete('/api/projects/proj-1/tickets/1')

    const store = readDiskStore(tmpDir)
    expect(store.revision).toBe(2)
  })

  it('leaves other tickets intact when one is deleted', async () => {
    const ctx = makeContext(db, tmpDir)
    const { app } = createApp(new Map([['proj-1', ctx]]))

    await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Keep me' })
    await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Delete me' })
    await request(app).delete('/api/projects/proj-1/tickets/2')

    const store = readDiskStore(tmpDir)
    expect(store.tickets['1']).toBeDefined()
    expect(store.tickets['2']).toBeUndefined()
    expect(store.tickets['1'].title).toBe('Keep me')
  })
})

// ─── E4: Integration-contract storagePath ────────────────────────────────────

describe('E4: App create uses custom storagePath from integration-contract.json', () => {
  it('writes the ticket to the path specified in integration-contract.json', async () => {
    const claudeDir = path.join(tmpDir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })

    // Write integration contract with custom path
    fs.writeFileSync(path.join(claudeDir, 'integration-contract.json'), JSON.stringify({
      schemaVersion: '1.0',
      ticketProvider: {
        type: 'local',
        storagePath: '.claude/local-tickets.json',
        capabilities: ['crud'],
      },
    }))

    const ctx = makeContext(db, tmpDir)
    const { app } = createApp(new Map([['proj-1', ctx]]))

    const res = await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Contract path ticket' })
    expect(res.status).toBe(201)

    // File should exist at the contract-specified path
    const contractFilePath = path.join(tmpDir, '.claude', 'local-tickets.json')
    expect(fs.existsSync(contractFilePath)).toBe(true)

    const store = readDiskStore(tmpDir, contractFilePath)
    expect(store.tickets['1'].title).toBe('Contract path ticket')
  })

  it('created ticket is readable via GET /tickets using the same path', async () => {
    const claudeDir = path.join(tmpDir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })

    fs.writeFileSync(path.join(claudeDir, 'integration-contract.json'), JSON.stringify({
      schemaVersion: '1.0',
      ticketProvider: {
        type: 'local',
        storagePath: '.claude/local-tickets.json',
      },
    }))

    const ctx = makeContext(db, tmpDir)
    const { app } = createApp(new Map([['proj-1', ctx]]))

    await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Roundtrip' })

    const getRes = await request(app).get('/api/projects/proj-1/tickets')
    expect(getRes.status).toBe(200)
    expect(getRes.body.tickets).toHaveLength(1)
    expect(getRes.body.tickets[0].title).toBe('Roundtrip')
  })
})

// ─── E5: External write → TicketWatcher broadcasts ───────────────────────────

describe('E5: External file write triggers TicketWatcher broadcast', () => {
  it('broadcasts ticket_updated when external process bumps revision', async () => {
    const broadcast = vi.fn()

    // Set up ticket file
    const storeDir = path.join(tmpDir, '.specrails')
    fs.mkdirSync(storeDir, { recursive: true })
    const filePath = path.join(storeDir, 'local-tickets.json')
    const initialStore = {
      schema_version: '1.0',
      revision: 1,
      last_updated: new Date().toISOString(),
      next_id: 2,
      tickets: {
        '1': {
          id: 1, title: 'Initial', description: '', status: 'todo', priority: 'medium',
          labels: [], assignee: null, prerequisites: [], metadata: {},
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          created_by: 'cli', source: 'manual',
        },
      },
    }
    fs.writeFileSync(filePath, JSON.stringify(initialStore), 'utf-8')

    const watcher = new TicketWatcher(tmpDir, 'proj-1', broadcast)
    watcher.start()

    // Wait for chokidar to be ready
    await new Promise((r) => setTimeout(r, 300))

    // Simulate external (CLI) write with bumped revision
    const updated = { ...initialStore, revision: 2 }
    fs.writeFileSync(filePath, JSON.stringify(updated), 'utf-8')

    // Wait for debounce (400ms) + awaitWriteFinish (200ms) + buffer
    await new Promise((r) => setTimeout(r, 1200))
    await watcher.close()

    expect(broadcast).toHaveBeenCalled()
    const msg = broadcast.mock.calls[0][0]
    expect(msg.type).toBe('ticket_updated')
    expect(msg.projectId).toBe('proj-1')
  })

  it('suppresses echo when watcher is notified of app revision', async () => {
    const broadcast = vi.fn()

    const storeDir = path.join(tmpDir, '.specrails')
    fs.mkdirSync(storeDir, { recursive: true })
    const filePath = path.join(storeDir, 'local-tickets.json')
    const initialStore = {
      schema_version: '1.0', revision: 1, last_updated: new Date().toISOString(),
      next_id: 1, tickets: {},
    }
    fs.writeFileSync(filePath, JSON.stringify(initialStore), 'utf-8')

    const watcher = new TicketWatcher(tmpDir, 'proj-1', broadcast)
    watcher.start()
    await new Promise((r) => setTimeout(r, 300))

    // App writes and pre-notifies watcher — should suppress the echo
    watcher.notifyDesktopWrite(2)
    const updated = { ...initialStore, revision: 2 }
    fs.writeFileSync(filePath, JSON.stringify(updated), 'utf-8')

    await new Promise((r) => setTimeout(r, 1200))
    await watcher.close()

    expect(broadcast).not.toHaveBeenCalled()
  })
})
