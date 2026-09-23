import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, type DbInstance } from './db'
import { createProfilesRouter } from './modules/agents/runtime/profiles-router'
import { createRefineSession, getRefineSession } from './modules/agents/runtime/agent-refine-db'
import type { ProjectContext } from './project-registry'

let projectPath: string
let db: DbInstance
let app: express.Express
let mgrStub: {
  startRefine: ReturnType<typeof vi.fn>
  sendTurn: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  toggleAutoTest: ReturnType<typeof vi.fn>
  apply: ReturnType<typeof vi.fn>
}

function writeAgent(id: string): void {
  const dir = path.join(projectPath, '.claude', 'agents')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.md`),
    `---\nname: ${id}\ndescription: "test"\nmodel: sonnet\ncolor: blue\nmemory: project\n---\n\n# Body\n`,
    'utf8',
  )
}

function mountApp(envOverride?: Record<string, string | undefined>): void {
  // Apply env override BEFORE constructing the router (which reads the flag at module load).
  // We achieve this by mutating process.env then re-importing via vi.resetModules() — but
  // the existing flag is read at the top of profiles-router.ts via process.env.SPECRAILS_AGENTS_SECTION.
  // For our gate test we set/unset the env var and re-create the app.
  if (envOverride) {
    for (const [k, v] of Object.entries(envOverride)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }

  app = express()
  app.use(express.json())
  const ctx: ProjectContext = {
    project: {
      id: 'proj-test',
      slug: 'proj-test',
      name: 'Test',
      path: projectPath,
      provider: 'claude',
      last_active: null,
      setup_session: null,
      agent_job_id: null,
    } as never,
    db,
    queueManager: {} as never,
    chatManager: {} as never,
    setupManager: {} as never,
    proposalManager: {} as never,
    agentRefineManager: mgrStub as never,
    specLauncherManager: {} as never,
    ticketWatcher: {} as never,
    broadcast: vi.fn(),
    railJobs: new Map(),
  }
  app.use(
    '/api/projects/:projectId/profiles',
    (req, _res, next) => {
      ;(req as never as { projectCtx: ProjectContext }).projectCtx = ctx
      next()
    },
    createProfilesRouter(),
  )
}

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-refine-routes-'))
  db = initDb(':memory:')
  mgrStub = {
    startRefine: vi.fn(async ({ agentId }) => ({ refineId: `r-${agentId}-1` })),
    sendTurn: vi.fn(async () => undefined),
    cancel: vi.fn(),
    toggleAutoTest: vi.fn(),
    apply: vi.fn(() => ({ ok: true, version: 2, body: '...' })),
  }
  delete process.env.SPECRAILS_AGENTS_SECTION
  mountApp()
})

afterEach(() => {
  fs.rmSync(projectPath, { recursive: true, force: true })
  db.close()
})

const BASE = '/api/projects/proj-test/profiles/catalog'

// ─── POST /catalog/:agentId/refine ────────────────────────────────────────────

describe('POST /catalog/:agentId/refine', () => {
  it('starts a session and returns 201 with refineId', async () => {
    writeAgent('custom-foo')
    const res = await request(app)
      .post(`${BASE}/custom-foo/refine`)
      .send({ instruction: 'tighten' })
    expect(res.status).toBe(201)
    expect(res.body.refineId).toBe('r-custom-foo-1')
    expect(mgrStub.startRefine).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'custom-foo', instruction: 'tighten', autoTest: true }),
    )
  })

  it('respects autoTest=false from body', async () => {
    writeAgent('custom-foo')
    const res = await request(app)
      .post(`${BASE}/custom-foo/refine`)
      .send({ instruction: 'tighten', autoTest: false })
    expect(res.status).toBe(201)
    expect(mgrStub.startRefine).toHaveBeenCalledWith(
      expect.objectContaining({ autoTest: false }),
    )
  })

  it('rejects empty instruction with 400', async () => {
    writeAgent('custom-foo')
    const res = await request(app).post(`${BASE}/custom-foo/refine`).send({ instruction: '   ' })
    expect(res.status).toBe(400)
    expect(mgrStub.startRefine).not.toHaveBeenCalled()
  })

  it('rejects upstream agent ids with 400 and reason=not_a_custom_agent', async () => {
    const res = await request(app).post(`${BASE}/sr-developer/refine`).send({ instruction: 'go' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('not_a_custom_agent')
  })

  it('forwards manager errors as the right HTTP status', async () => {
    writeAgent('custom-foo')
    mgrStub.startRefine.mockRejectedValueOnce(new Error('agent_not_found'))
    const res = await request(app).post(`${BASE}/custom-foo/refine`).send({ instruction: 'go' })
    expect(res.status).toBe(404)
  })
})

// ─── POST /refine/:refineId/turn ─────────────────────────────────────────────

describe('POST /catalog/:agentId/refine/:refineId/turn', () => {
  beforeEach(() => {
    // The /turn route now verifies the session belongs to :agentId, so the
    // row must exist (matching the GET/PATCH/DELETE/apply sibling routes).
    createRefineSession(db, {
      id: 'r-1',
      agentId: 'custom-foo',
      baseVersion: 0,
      baseBodyHash: 'h',
      autoTest: true,
    })
  })

  it('proxies to manager.sendTurn and returns 200', async () => {
    const res = await request(app)
      .post(`${BASE}/custom-foo/refine/r-1/turn`)
      .send({ instruction: 'tighter' })
    expect(res.status).toBe(200)
    expect(mgrStub.sendTurn).toHaveBeenCalledWith({ refineId: 'r-1', instruction: 'tighter' })
  })

  it('returns 404 when the session belongs to a different agent', async () => {
    const res = await request(app)
      .post(`${BASE}/custom-bar/refine/r-1/turn`)
      .send({ instruction: 'x' })
    expect(res.status).toBe(404)
    expect(mgrStub.sendTurn).not.toHaveBeenCalled()
  })

  it('rejects empty instruction with 400', async () => {
    const res = await request(app)
      .post(`${BASE}/custom-foo/refine/r-1/turn`)
      .send({ instruction: '' })
    expect(res.status).toBe(400)
  })

  it('returns 404 when manager throws session_not_found', async () => {
    mgrStub.sendTurn.mockRejectedValueOnce(new Error('session_not_found'))
    const res = await request(app)
      .post(`${BASE}/custom-foo/refine/r-1/turn`)
      .send({ instruction: 'x' })
    expect(res.status).toBe(404)
  })

  it('returns 409 when manager throws turn_in_progress', async () => {
    mgrStub.sendTurn.mockRejectedValueOnce(new Error('turn_in_progress'))
    const res = await request(app)
      .post(`${BASE}/custom-foo/refine/r-1/turn`)
      .send({ instruction: 'x' })
    expect(res.status).toBe(409)
  })

  it('returns 409 when manager throws no_session_id', async () => {
    mgrStub.sendTurn.mockRejectedValueOnce(new Error('no_session_id'))
    const res = await request(app)
      .post(`${BASE}/custom-foo/refine/r-1/turn`)
      .send({ instruction: 'x' })
    expect(res.status).toBe(409)
  })
})

// ─── GET /refine and /refine/:refineId ───────────────────────────────────────

describe('GET refine endpoints', () => {
  it('lists sessions for an agent', async () => {
    createRefineSession(db, {
      id: 's1',
      agentId: 'custom-foo',
      baseVersion: 0,
      baseBodyHash: 'h',
      autoTest: true,
    })
    const res = await request(app).get(`${BASE}/custom-foo/refine`)
    expect(res.status).toBe(200)
    expect(res.body.sessions).toHaveLength(1)
    expect(res.body.sessions[0].id).toBe('s1')
  })

  it('returns a single session by id', async () => {
    createRefineSession(db, {
      id: 's1',
      agentId: 'custom-foo',
      baseVersion: 0,
      baseBodyHash: 'h',
      autoTest: true,
    })
    const res = await request(app).get(`${BASE}/custom-foo/refine/s1`)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('s1')
    expect(res.body.autoTest).toBe(true)
  })

  it('404s when the session belongs to a different agent', async () => {
    createRefineSession(db, {
      id: 's1',
      agentId: 'custom-foo',
      baseVersion: 0,
      baseBodyHash: 'h',
      autoTest: true,
    })
    const res = await request(app).get(`${BASE}/custom-bar/refine/s1`)
    expect(res.status).toBe(404)
  })

  it('404s on unknown id', async () => {
    const res = await request(app).get(`${BASE}/custom-foo/refine/missing`)
    expect(res.status).toBe(404)
  })
})

// ─── PATCH /refine/:refineId ─────────────────────────────────────────────────

describe('PATCH /catalog/:agentId/refine/:refineId', () => {
  it('toggles autoTest and returns the updated session', async () => {
    createRefineSession(db, {
      id: 's1',
      agentId: 'custom-foo',
      baseVersion: 0,
      baseBodyHash: 'h',
      autoTest: true,
    })
    const res = await request(app)
      .patch(`${BASE}/custom-foo/refine/s1`)
      .send({ autoTest: false })
    expect(res.status).toBe(200)
    expect(mgrStub.toggleAutoTest).toHaveBeenCalledWith('s1', false)
  })

  it('404s on unknown id', async () => {
    const res = await request(app).patch(`${BASE}/custom-foo/refine/nope`).send({ autoTest: false })
    expect(res.status).toBe(404)
  })
})

// ─── DELETE /refine/:refineId ────────────────────────────────────────────────

describe('DELETE /catalog/:agentId/refine/:refineId', () => {
  it('cancels via manager and returns ok', async () => {
    createRefineSession(db, {
      id: 's1',
      agentId: 'custom-foo',
      baseVersion: 0,
      baseBodyHash: 'h',
      autoTest: true,
    })
    const res = await request(app).delete(`${BASE}/custom-foo/refine/s1`)
    expect(res.status).toBe(200)
    expect(mgrStub.cancel).toHaveBeenCalledWith('s1')
  })

  it('404s on unknown id', async () => {
    const res = await request(app).delete(`${BASE}/custom-foo/refine/nope`)
    expect(res.status).toBe(404)
    expect(mgrStub.cancel).not.toHaveBeenCalled()
  })
})

// ─── POST /refine/:refineId/apply ────────────────────────────────────────────

describe('POST /catalog/:agentId/refine/:refineId/apply', () => {
  beforeEach(() => {
    createRefineSession(db, {
      id: 's1',
      agentId: 'custom-foo',
      baseVersion: 0,
      baseBodyHash: 'h',
      autoTest: true,
    })
  })

  it('returns 200 and the applied version on success', async () => {
    const res = await request(app).post(`${BASE}/custom-foo/refine/s1/apply`).send({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.version).toBe(2)
    expect(mgrStub.apply).toHaveBeenCalledWith({ refineId: 's1', force: false })
  })

  it('forwards force=true to the manager', async () => {
    await request(app).post(`${BASE}/custom-foo/refine/s1/apply`).send({ force: true })
    expect(mgrStub.apply).toHaveBeenCalledWith({ refineId: 's1', force: true })
  })

  it('returns 409 with reason=disk_changed', async () => {
    mgrStub.apply.mockReturnValueOnce({ ok: false, reason: 'disk_changed' })
    const res = await request(app).post(`${BASE}/custom-foo/refine/s1/apply`).send({})
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('disk_changed')
  })

  it('returns 409 with reason=name_changed', async () => {
    mgrStub.apply.mockReturnValueOnce({ ok: false, reason: 'name_changed' })
    const res = await request(app).post(`${BASE}/custom-foo/refine/s1/apply`).send({})
    expect(res.status).toBe(409)
    expect(res.body.reason).toBe('name_changed')
  })

  it('returns 404 when reason=agent_not_found', async () => {
    mgrStub.apply.mockReturnValueOnce({ ok: false, reason: 'agent_not_found' })
    const res = await request(app).post(`${BASE}/custom-foo/refine/s1/apply`).send({})
    expect(res.status).toBe(404)
  })

  it('returns 400 for other apply failures', async () => {
    mgrStub.apply.mockReturnValueOnce({ ok: false, reason: 'invalid_state' })
    const res = await request(app).post(`${BASE}/custom-foo/refine/s1/apply`).send({})
    expect(res.status).toBe(400)
  })

  it('404s when the path agent does not match the session', async () => {
    const res = await request(app).post(`${BASE}/custom-other/refine/s1/apply`).send({})
    expect(res.status).toBe(404)
  })
})

// ─── Persistence + retention is covered in agent-refine-db.test.ts.
// ─── Manager unit logic is covered in agent-refine-manager.test.ts.
// This file validates only the route adapters.

// Keep last so the env var is reset on next file's beforeEach.
afterEach(() => {
  delete process.env.SPECRAILS_AGENTS_SECTION
})
