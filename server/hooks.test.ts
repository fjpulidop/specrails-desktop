import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import { createHooksRouter, getPhaseStates, getPhaseDefinitions, setActivePhases, resetPhases, dropPhaseScope } from './hooks'
const PID = 'test-project'
import type { WsMessage, PhaseName, PhaseDefinition } from './types'

// The hooks module uses module-level state, so we need a fresh import for isolation.
// Since we can't easily re-import, we'll use resetPhases to clean up between tests.

function createApp(broadcast: (msg: WsMessage) => void) {
  const app = express()
  app.use(express.json())
  app.use('/hooks', createHooksRouter(PID, broadcast))
  return app
}

// Per-project phase state now persists in a Map keyed by projectId; drop the
// test project's scope before every test so each starts from the defaults
// (replaces the old reliance on module-singleton reset).
beforeEach(() => { dropPhaseScope(PID) })

describe('getPhaseStates', () => {
  let broadcast: ReturnType<typeof vi.fn>

  beforeEach(() => {
    broadcast = vi.fn()
    // Reset all phases to idle before each test
    resetPhases(PID, broadcast)
    broadcast.mockClear()
  })

  it('returns all phases as idle initially', () => {
    const states = getPhaseStates(PID)
    expect(states).toEqual({
      architect: 'idle',
      developer: 'idle',
      reviewer: 'idle',
      ship: 'idle',
    })
  })

  it('returns a copy, not a reference', () => {
    const states = getPhaseStates(PID)
    states.architect = 'running'
    expect(getPhaseStates(PID).architect).toBe('idle')
  })
})

describe('resetPhases', () => {
  it('broadcasts a phase message for each phase', () => {
    const broadcast = vi.fn()
    resetPhases(PID, broadcast)

    expect(broadcast).toHaveBeenCalledTimes(4)
    const phases: PhaseName[] = ['architect', 'developer', 'reviewer', 'ship']
    for (const phase of phases) {
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'phase',
          phase,
          state: 'idle',
          timestamp: expect.any(String),
        })
      )
    }
  })

  it('sets all phases back to idle', async () => {
    const broadcast = vi.fn()
    // First, transition a phase to running via the router
    const app = createApp(broadcast)
    const { default: request } = await import('supertest')
    await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_start', agent: 'architect' })

    expect(getPhaseStates(PID).architect).toBe('running')

    resetPhases(PID, broadcast)
    expect(getPhaseStates(PID).architect).toBe('idle')
  })
})

describe('POST /hooks/events', () => {
  let broadcast: ReturnType<typeof vi.fn>
  let app: express.Express
  let request: any

  beforeEach(async () => {
    broadcast = vi.fn()
    resetPhases(PID, broadcast)
    broadcast.mockClear()
    app = createApp(broadcast)
    const mod = await import('supertest')
    request = mod.default
  })

  it('transitions phase to running on agent_start', async () => {
    const res = await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_start', agent: 'architect' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(getPhaseStates(PID).architect).toBe('running')
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'phase',
        phase: 'architect',
        state: 'running',
      })
    )
  })

  it('transitions phase to done on agent_stop', async () => {
    await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_start', agent: 'developer' })
    broadcast.mockClear()

    const res = await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_stop', agent: 'developer' })

    expect(res.status).toBe(200)
    expect(getPhaseStates(PID).developer).toBe('done')
  })

  it('transitions phase to error on agent_error', async () => {
    const res = await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_error', agent: 'reviewer' })

    expect(res.status).toBe(200)
    expect(getPhaseStates(PID).reviewer).toBe('error')
  })

  it('ignores unknown agent names gracefully', async () => {
    const res = await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_start', agent: 'unknown_agent' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('ignores unknown event types gracefully', async () => {
    const res = await request(app)
      .post('/hooks/events')
      .send({ event: 'unknown_event', agent: 'architect' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('handles missing body gracefully', async () => {
    const res = await request(app)
      .post('/hooks/events')
      .send({})

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('handles all four phases', async () => {
    const phases: PhaseName[] = ['architect', 'developer', 'reviewer', 'ship']
    for (const phase of phases) {
      await request(app)
        .post('/hooks/events')
        .send({ event: 'agent_start', agent: phase })
      expect(getPhaseStates(PID)[phase]).toBe('running')
    }
  })

  it('can transition through full lifecycle: idle -> running -> done', async () => {
    expect(getPhaseStates(PID).ship).toBe('idle')

    await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_start', agent: 'ship' })
    expect(getPhaseStates(PID).ship).toBe('running')

    await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_stop', agent: 'ship' })
    expect(getPhaseStates(PID).ship).toBe('done')
  })

  it('can transition from running to error', async () => {
    await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_start', agent: 'architect' })
    expect(getPhaseStates(PID).architect).toBe('running')

    await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_error', agent: 'architect' })
    expect(getPhaseStates(PID).architect).toBe('error')
  })
})

describe('getPhaseDefinitions', () => {
  it('returns the default phase definitions', () => {
    const defs = getPhaseDefinitions(PID)
    expect(defs).toHaveLength(4)
    expect(defs.map((d: PhaseDefinition) => d.key)).toEqual(['architect', 'developer', 'reviewer', 'ship'])
  })

  it('returns a copy, not a reference', () => {
    const defs = getPhaseDefinitions(PID)
    defs.push({ key: 'extra', label: 'Extra', description: 'Extra phase' })
    expect(getPhaseDefinitions(PID)).toHaveLength(4)
  })
})

describe('setActivePhases', () => {
  const DEFAULT_PHASES: PhaseDefinition[] = [
    { key: 'architect', label: 'Architect', description: 'Architect phase' },
    { key: 'developer', label: 'Developer', description: 'Developer phase' },
    { key: 'reviewer', label: 'Reviewer', description: 'Reviewer phase' },
    { key: 'ship', label: 'Ship', description: 'Ship phase' },
  ]

  beforeEach(() => {
    setActivePhases(PID, DEFAULT_PHASES, vi.fn())
  })

  it('replaces active phases with new definitions', () => {
    const custom: PhaseDefinition[] = [
      { key: 'plan', label: 'Plan', description: 'Planning phase' },
      { key: 'build', label: 'Build', description: 'Build phase' },
    ]
    setActivePhases(PID, custom, vi.fn())

    const defs = getPhaseDefinitions(PID)
    expect(defs).toHaveLength(2)
    expect(defs[0].key).toBe('plan')
  })

  it('initializes new phases to idle state', () => {
    const custom: PhaseDefinition[] = [
      { key: 'plan', label: 'Plan', description: 'Planning phase' },
    ]
    setActivePhases(PID, custom, vi.fn())

    expect(getPhaseStates(PID).plan).toBe('idle')
  })

  it('broadcasts idle state for each new phase', () => {
    const broadcast = vi.fn()
    const custom: PhaseDefinition[] = [
      { key: 'plan', label: 'Plan', description: 'Planning phase' },
      { key: 'build', label: 'Build', description: 'Build phase' },
    ]
    setActivePhases(PID, custom, broadcast)

    expect(broadcast).toHaveBeenCalledTimes(2)
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'phase', phase: 'plan', state: 'idle' }))
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'phase', phase: 'build', state: 'idle' }))
  })

  it('removes old phase keys from state', () => {
    const custom: PhaseDefinition[] = [
      { key: 'custom1', label: 'Custom1', description: 'Custom phase 1' },
    ]
    setActivePhases(PID, custom, vi.fn())

    const states = getPhaseStates(PID)
    expect(states.architect).toBeUndefined()
    expect(states.custom1).toBe('idle')
  })
})

describe('POST /hooks/events with db and activeJobRef', () => {
  beforeEach(() => {
    // Restore defaults after each test
    const defaults: PhaseDefinition[] = [
      { key: 'architect', label: 'Architect', description: 'Architect phase' },
      { key: 'developer', label: 'Developer', description: 'Developer phase' },
      { key: 'reviewer', label: 'Reviewer', description: 'Reviewer phase' },
      { key: 'ship', label: 'Ship', description: 'Ship phase' },
    ]
    setActivePhases(PID, defaults, vi.fn())
  })

  it('calls db.prepare when db and activeJobRef.current are provided', async () => {
    const broadcast = vi.fn()
    const mockDb = { prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })) } as any
    const activeJobRef = { current: 'job-123' }

    const app = express()
    app.use(express.json())
    app.use('/hooks', createHooksRouter(PID, broadcast, mockDb, activeJobRef))

    const { default: request } = await import('supertest')
    await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_start', agent: 'architect' })

    expect(mockDb.prepare).toHaveBeenCalled()
  })

  it('skips upsertPhase when activeJobRef.current is null', async () => {
    const broadcast = vi.fn()
    const mockDb = { prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })) } as any
    const activeJobRef = { current: null }

    const app = express()
    app.use(express.json())
    app.use('/hooks', createHooksRouter(PID, broadcast, mockDb, activeJobRef))

    const { default: request } = await import('supertest')
    await request(app)
      .post('/hooks/events')
      .send({ event: 'agent_start', agent: 'developer' })

    expect(mockDb.prepare).not.toHaveBeenCalled()
  })
})
