// Which engine (provider · model · effort) a milestone's NEXT rail runs on.
//
// The Blueprint popover keeps a project-owned "usual configuration for the
// following iterations" (`blueprint.milestone_generation`) and, per milestone,
// "use another configuration only for M<n>" (recorded when that milestone's
// specs are generated with it). A launch chain lives for hours: freezing the
// engine chosen at Launch made every later rail ignore what the popover shows.
// New rails use what the popover shows:
//
//   1. the milestone's own configuration ("only for M<n>"), if set;
//   2. at Launch (no rail launched yet), the engine chosen in the launch controls;
//   3. otherwise the CURRENT usual configuration, whenever it was saved
//      (a value saved before stamps existed counts too);
//   4. otherwise the Launch choice (`milestone_launch_chains.engine_config`);
//   5. none (legacy chains: the rails' own defaults).
//
// Continuing an existing run in place never switches its engine (that is what
// the provider-switch on a usage limit is for). Pure reads of `queue_state`.

import type { DbInstance } from '../../../db'

export interface MilestoneEngine {
  provider: string
  model: string
  reasoningEffort: string | null
}

/** Where the next rail's engine comes from (see the module header). */
export type MilestoneEngineSource = 'milestone' | 'usual' | 'launch'

export interface ResolvedMilestoneEngine extends MilestoneEngine {
  source: MilestoneEngineSource
}

const USUAL_KEY = 'blueprint.milestone_generation'
const overrideKey = (milestoneId: string): string => `blueprint.milestone_engine:${milestoneId.toLowerCase()}`

export function isMilestoneEngine(value: unknown): value is MilestoneEngine {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return typeof v.provider === 'string' && !!v.provider && typeof v.model === 'string' && !!v.model
    && (v.reasoningEffort === null || typeof v.reasoningEffort === 'string')
}

const pick = (e: MilestoneEngine): MilestoneEngine => ({ provider: e.provider, model: e.model, reasoningEffort: e.reasoningEffort })

export function sameEngine(a: MilestoneEngine | null | undefined, b: MilestoneEngine | null | undefined): boolean {
  return !!a && !!b && a.provider === b.provider && a.model === b.model && (a.reasoningEffort ?? null) === (b.reasoningEffort ?? null)
}

function readJson(db: DbInstance, key: string): unknown {
  const row = db.prepare('SELECT value FROM queue_state WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return null
  try { return JSON.parse(row.value) } catch { return null }
}

export interface StampedEngine {
  engine: MilestoneEngine
  /** When the person saved it (ISO); null for a value saved before stamps existed. */
  savedAt: string | null
}

function readStamped(db: DbInstance, key: string): StampedEngine | null {
  const value = readJson(db, key)
  if (!isMilestoneEngine(value)) return null
  const savedAt = (value as { savedAt?: unknown }).savedAt
  return { engine: pick(value), savedAt: typeof savedAt === 'string' && Number.isFinite(Date.parse(savedAt)) ? savedAt : null }
}

function writeStamped(db: DbInstance, key: string, engine: MilestoneEngine, nowMs: number): void {
  db.prepare('INSERT OR REPLACE INTO queue_state (key, value) VALUES (?, ?)').run(key, JSON.stringify({ ...pick(engine), savedAt: new Date(nowMs).toISOString() }))
}

/** The usual configuration and when it was saved. */
export function readUsualMilestoneEngine(db: DbInstance): StampedEngine | null {
  return readStamped(db, USUAL_KEY)
}

export function saveUsualMilestoneEngine(db: DbInstance, engine: MilestoneEngine, nowMs: number = Date.now()): void {
  writeStamped(db, USUAL_KEY, engine, nowMs)
}

/** "Use another configuration only for M<n>": null when the milestone follows the usual one. */
export function readMilestoneEngineOverride(db: DbInstance, milestoneId: string): StampedEngine | null {
  return readStamped(db, overrideKey(milestoneId))
}

export function saveMilestoneEngineOverride(db: DbInstance, milestoneId: string, engine: MilestoneEngine | null, nowMs: number = Date.now()): void {
  if (engine) writeStamped(db, overrideKey(milestoneId), engine, nowMs)
  else db.prepare('DELETE FROM queue_state WHERE key = ?').run(overrideKey(milestoneId))
}

/**
 * Record the engine a milestone's specs are generated with: one that differs
 * from the usual configuration is that milestone's own ("only for M<n>");
 * the usual one clears a previous override.
 */
export function recordMilestoneGenerationEngine(db: DbInstance, milestoneId: string, engine: MilestoneEngine, nowMs: number = Date.now()): void {
  const usual = readUsualMilestoneEngine(db)?.engine ?? null
  saveMilestoneEngineOverride(db, milestoneId, usual && sameEngine(usual, engine) ? null : engine, nowMs)
}

/** Pure: the next rail's engine from the choices (module header order). */
export function resolveMilestoneEngine(input: {
  override: StampedEngine | null
  usual: StampedEngine | null
  launch: MilestoneEngine | null
  /** No rail launched yet: the launch controls' choice runs the first rail. */
  atLaunch: boolean
}): ResolvedMilestoneEngine | null {
  if (input.override) return { ...input.override.engine, source: 'milestone' }
  if (input.atLaunch && input.launch) return { ...pick(input.launch), source: 'launch' }
  if (input.usual) return { ...input.usual.engine, source: 'usual' }
  if (input.launch) return { ...pick(input.launch), source: 'launch' }
  return null
}

/** Read and resolve for one chain row; `invalid` when it falls back to an unreadable launch choice. */
export function readNextRailEngine(db: DbInstance, chain: { milestone_id: string; engine_config: string | null; launched: string }): ResolvedMilestoneEngine | null | 'invalid' {
  let launch: MilestoneEngine | null = null
  let invalid = false
  if (chain.engine_config != null) {
    try {
      const parsed: unknown = JSON.parse(chain.engine_config)
      if (isMilestoneEngine(parsed)) launch = parsed
      else invalid = true
    } catch { invalid = true }
  }
  let override: StampedEngine | null = null
  let usual: StampedEngine | null = null
  try { override = readMilestoneEngineOverride(db, chain.milestone_id) } catch { override = null }
  try { usual = readUsualMilestoneEngine(db) } catch { usual = null }
  let atLaunch = false
  try { const parsed: unknown = JSON.parse(chain.launched || '[]'); atLaunch = Array.isArray(parsed) && parsed.length === 0 } catch { atLaunch = false }
  const resolved = resolveMilestoneEngine({ override, usual, launch, atLaunch })
  return !resolved && invalid ? 'invalid' : resolved
}
