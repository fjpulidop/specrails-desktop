import { beforeEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import {
  readMilestoneEngineOverride,
  readNextRailEngine,
  readUsualMilestoneEngine,
  recordMilestoneGenerationEngine,
  resolveMilestoneEngine,
  saveUsualMilestoneEngine,
} from './milestone-engine-preference'
import { readMilestoneGenerationSelection, saveMilestoneGenerationSelection } from './milestone-generation-settings'

const CLAUDE = { provider: 'claude', model: 'sonnet', reasoningEffort: null }
const CODEX = { provider: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'high' }
const created = '2026-11-21T07:18:00.000Z'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })

describe('resolveMilestoneEngine', () => {
  it('milestone override > usual saved after the chain started > launch choice > none', () => {
    const later = { engine: CODEX, savedAt: '2026-11-21T09:00:00.000Z' }
    const earlier = { engine: CODEX, savedAt: '2026-11-21T07:00:00.000Z' }
    const own = { engine: { provider: 'claude', model: 'opus', reasoningEffort: null }, savedAt: '2026-11-21T08:00:00.000Z' }
    expect(resolveMilestoneEngine({ override: own, usual: later, launch: CLAUDE, chainCreatedAt: created })).toEqual({ ...own.engine, source: 'milestone' })
    expect(resolveMilestoneEngine({ override: null, usual: later, launch: CLAUDE, chainCreatedAt: created })).toEqual({ ...CODEX, source: 'usual' })
    expect(resolveMilestoneEngine({ override: null, usual: earlier, launch: CLAUDE, chainCreatedAt: created })).toEqual({ ...CLAUDE, source: 'launch' })
    // A value saved before stamps existed cannot be ordered against the launch: the launch choice stands.
    expect(resolveMilestoneEngine({ override: null, usual: { engine: CODEX, savedAt: null }, launch: CLAUDE, chainCreatedAt: created })).toEqual({ ...CLAUDE, source: 'launch' })
    expect(resolveMilestoneEngine({ override: null, usual: null, launch: null, chainCreatedAt: created })).toBeNull()
  })
})

describe('stored preferences', () => {
  it('the usual configuration is stamped, and the generation settings read it without the stamp', () => {
    saveMilestoneGenerationSelection(db, CODEX, Date.parse('2026-11-21T09:00:00.000Z'))
    expect(readUsualMilestoneEngine(db)).toEqual({ engine: CODEX, savedAt: '2026-11-21T09:00:00.000Z' })
    expect(readMilestoneGenerationSelection(db)).toEqual(CODEX)
  })

  it('a legacy unstamped value still reads (savedAt null)', () => {
    db.prepare("INSERT INTO queue_state (key, value) VALUES ('blueprint.milestone_generation', ?)").run(JSON.stringify(CODEX))
    expect(readUsualMilestoneEngine(db)).toEqual({ engine: CODEX, savedAt: null })
    expect(readMilestoneGenerationSelection(db)).toEqual(CODEX)
  })

  it('generating a milestone with another engine records its own configuration; the usual one clears it', () => {
    saveUsualMilestoneEngine(db, CLAUDE)
    recordMilestoneGenerationEngine(db, 'M2', CODEX)
    expect(readMilestoneEngineOverride(db, 'm2')?.engine).toEqual(CODEX)
    recordMilestoneGenerationEngine(db, 'm2', CLAUDE)
    expect(readMilestoneEngineOverride(db, 'm2')).toBeNull()
  })

  it('readNextRailEngine flags an unreadable launch choice only when nothing newer applies', () => {
    const chain = { milestone_id: 'm1', created_at: created, engine_config: '{broken' }
    expect(readNextRailEngine(db, chain)).toBe('invalid')
    saveUsualMilestoneEngine(db, CODEX, Date.parse('2026-11-21T09:00:00.000Z'))
    expect(readNextRailEngine(db, chain)).toEqual({ ...CODEX, source: 'usual' })
    expect(readNextRailEngine(db, { ...chain, engine_config: null, created_at: '2026-11-21T10:00:00.000Z' })).toBeNull()
  })
})
