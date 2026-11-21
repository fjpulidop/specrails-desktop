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

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })

describe('resolveMilestoneEngine', () => {
  it('milestone override > the launch choice at Launch > the current usual configuration > the launch choice > none', () => {
    const stamped = { engine: CODEX, savedAt: '2026-11-21T09:00:00.000Z' }
    const legacy = { engine: CODEX, savedAt: null }
    const own = { engine: { provider: 'claude', model: 'opus', reasoningEffort: null }, savedAt: '2026-11-21T08:00:00.000Z' }
    expect(resolveMilestoneEngine({ override: own, usual: stamped, launch: CLAUDE, atLaunch: true })).toEqual({ ...own.engine, source: 'milestone' })
    expect(resolveMilestoneEngine({ override: null, usual: stamped, launch: CLAUDE, atLaunch: true })).toEqual({ ...CLAUDE, source: 'launch' })
    expect(resolveMilestoneEngine({ override: null, usual: stamped, launch: CLAUDE, atLaunch: false })).toEqual({ ...CODEX, source: 'usual' })
    // Whenever it was saved: a value saved before stamps existed counts too.
    expect(resolveMilestoneEngine({ override: null, usual: legacy, launch: CLAUDE, atLaunch: false })).toEqual({ ...CODEX, source: 'usual' })
    expect(resolveMilestoneEngine({ override: null, usual: null, launch: CLAUDE, atLaunch: false })).toEqual({ ...CLAUDE, source: 'launch' })
    expect(resolveMilestoneEngine({ override: null, usual: null, launch: null, atLaunch: false })).toBeNull()
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

  it('readNextRailEngine flags an unreadable launch choice only when nothing else applies', () => {
    const chain = { milestone_id: 'm1', engine_config: '{broken', launched: '[{"chunk":1}]' }
    expect(readNextRailEngine(db, chain)).toBe('invalid')
    saveUsualMilestoneEngine(db, CODEX)
    expect(readNextRailEngine(db, chain)).toEqual({ ...CODEX, source: 'usual' })
    expect(readNextRailEngine(db, { ...chain, engine_config: JSON.stringify(CLAUDE), launched: '[]' })).toEqual({ ...CLAUDE, source: 'launch' })
  })
})
