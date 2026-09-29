/**
 * Editable built-in loops — the effectful coordinator between the code-owned
 * factory defaults (`loop-factory.ts`, whose graph variant depends on the
 * selected Core's capabilities) and the app-global `loops` rows that make the
 * built-ins real, editable loops (desktop migration 31).
 *
 * - Seeding (`ensureBuiltinLoops`) inserts one Published row per built-in whose
 *   id IS the canonical factory id, and refreshes an UNEDITED row when the
 *   default variant changed (Core upgraded/downgraded). User edits are never
 *   overwritten. When Core cannot be loaded, missing rows are inserted with the
 *   legacy variant and existing rows are left alone until Core is known again.
 * - Resolution (`resolveBuiltinLoop`) is what every launch door uses for a
 *   `factory:*` id: an edited Published row runs its graph; an edited Draft runs
 *   its last Published snapshot, so rails never break mid-edit; an unedited or
 *   missing row runs the current code default (identical to the old behavior).
 *
 * `factory:batch` and the retired aliases are never seeded; aliases resolve to
 * the canonical built-in they point at.
 */
import type { DbInstance } from '../../../db'
import { listAdapters } from '../../../providers/registry'
import { loadCoreAgentRuntime } from '../../agent-runtime/runtime/agent-runtime-loader'
import { factoryLoopsForCapabilities, getFactoryLoop, type FactoryLoop } from './loop-factory'
import type { LoopGraph } from './loop-graph'
import {
  getBuiltinLoop,
  readPublishedLoopGraph,
  restoreBuiltinLoop,
  seedBuiltinLoops,
  type BuiltinLoopDefault,
  type BuiltinSeedResult,
  type LoopDefinition,
} from './loops-store'

/** Built-ins that exist as editable rows. Batch is an alias, never seeded. */
export const EDITABLE_BUILTIN_LOOP_IDS: readonly string[] = ['factory:implement', 'factory:freestyle', 'factory:sdd-quick-openspec']

export interface BuiltinLoopEnvironment {
  /** Selected Core capabilities; throws when Core cannot be loaded. */
  loadCapabilities?: () => Promise<Record<string, number> | undefined>
  /** True when some provider can run the provider-owned Freestyle built-in. */
  freestyleAvailable?: () => boolean
}

export interface CoreCapabilityProbe {
  capabilities: Record<string, number> | undefined
  /** False when Core could not be loaded (capabilities are then unknown). */
  known: boolean
}

async function defaultCapabilities(): Promise<Record<string, number> | undefined> {
  return (await loadCoreAgentRuntime()).api?.capabilities
}

function defaultFreestyleAvailable(): boolean {
  return listAdapters().some(adapter => adapter.capabilities.freestyle === true)
}

export async function probeCoreCapabilities(env: BuiltinLoopEnvironment = {}): Promise<CoreCapabilityProbe> {
  try { return { capabilities: await (env.loadCapabilities ?? defaultCapabilities)(), known: true } }
  catch { return { capabilities: undefined, known: false } }
}

function toDefault(factory: FactoryLoop): BuiltinLoopDefault {
  return { id: factory.id, name: factory.name, description: factory.description, graph: factory.graph }
}

/** Current defaults of the seeded built-ins for these capabilities. */
export function builtinLoopDefaults(capabilities: Record<string, number> | undefined, freestyleAvailable: boolean): BuiltinLoopDefault[] {
  return factoryLoopsForCapabilities(capabilities)
    .filter(factory => EDITABLE_BUILTIN_LOOP_IDS.includes(factory.id))
    .filter(factory => factory.requiredCapability !== 'freestyle' || freestyleAvailable)
    .map(toDefault)
}

/** Idempotent, concurrency-safe seeding/refresh. Returns the capability probe. */
export async function ensureBuiltinLoops(db: DbInstance, env: BuiltinLoopEnvironment = {}): Promise<CoreCapabilityProbe & BuiltinSeedResult> {
  const probe = await probeCoreCapabilities(env)
  const defaults = builtinLoopDefaults(probe.capabilities, (env.freestyleAvailable ?? defaultFreestyleAvailable)())
  return { ...probe, ...seedBuiltinLoops(db, defaults, { refresh: probe.known }) }
}

export interface ResolvedBuiltinLoop {
  /** Canonical factory id (aliases are resolved). */
  id: string
  name: string
  description: string
  mode: FactoryLoop['mode']
  graph: LoopGraph
  /** `default`: code default (row missing or unedited); `edited`: the row's
   *  Published graph; `published-snapshot`: last Published graph of a Draft. */
  source: 'default' | 'edited' | 'published-snapshot'
  row?: LoopDefinition
}

/** Resolve a `factory:*` id to the graph a launch must run. Read-only. */
export function resolveBuiltinLoop(
  db: DbInstance | undefined,
  loopId: string,
  capabilities: Record<string, number> | undefined,
): ResolvedBuiltinLoop | undefined {
  const factory = getFactoryLoop(loopId, capabilities)
  if (!factory) return undefined
  const base = { id: factory.id, name: factory.name, description: factory.description, mode: factory.mode, graph: factory.graph, source: 'default' as const }
  const row = db ? getBuiltinLoop(db, factory.id) : undefined
  if (!row) return base
  const named = { ...base, name: row.name, description: row.description ?? factory.description, row }
  if (!row.builtinModified) return named
  if (row.status === 'published') return { ...named, graph: row.graph, source: 'edited' }
  const snapshot = readPublishedLoopGraph(db!, row.id)
  return snapshot ? { ...named, graph: snapshot, source: 'published-snapshot' } : named
}

/** Reset a built-in row to its current default variant (Published). */
export async function restoreBuiltin(db: DbInstance, id: string, env: BuiltinLoopEnvironment = {}): Promise<LoopDefinition | undefined> {
  const row = getBuiltinLoop(db, id)
  if (!row) return undefined
  const probe = await probeCoreCapabilities(env)
  const factory = getFactoryLoop(id, probe.capabilities)
  return factory ? restoreBuiltinLoop(db, toDefault(factory)) : undefined
}
