/**
 * Built-in "factory" loops — the app-owned loops that replace the old rail modes
 * (`implement` / `batch-implement` / Freestyle's `freestyle` mode). They appear in the Loops
 * gallery as read-only (locked) entries the user can run on a rail or "Fork to
 * edit" into an editable custom loop.
 *
 * Each carries the canonical rail `mode` it maps to. The rail launch routes a
 * factory loop to the matching engine via that mode (QueueManager slash command /
 * Freestyle prompt) — the graph here is the faithful representation used for the
 * gallery preview and as the seed when forked into a custom loop.
 *
 * IDs are namespaced `factory:<mode-ish>` so they never collide with user loop ids
 * (which are random) and the rail resolver can recognise a factory loop.
 */
import type { LoopGraph } from './loop-graph'
import { fixLoopGraph, opsxLifecycleGraph } from './loop-templates'

export interface FactoryLoop {
  /** Stable namespaced id, e.g. `factory:implement`. */
  id: string
  name: string
  description: string
  /** Rail mode this loop maps to: a canonical engine mode,
   *  or `'loop'` for graph-native factory loops that ONLY run through the
   *  LoopRunManager (no QueueManager fallback — launch 403s when Loops are disabled). */
  mode: 'implement' | 'batch-implement' | 'freestyle' | 'loop'
  /** Provider capability required to launch this factory loop. */
  requiredCapability?: 'freestyle'
  /** Faithful graph for preview + fork seed. */
  graph: LoopGraph
}

const GREEN_GOAL = 'Stop only when the latest verification step reports {{const:VERIFICATION_PASS}} and the history proves the spec is implemented with all required tests/build checks passing.'

// Factory loops run the WHOLE architect→developer→reviewer pipeline inside a
// single AI step (`/specrails:implement` etc.), so no fixed wall-clock budget is
// honest — a legit implement outran the old 60-min step cap and got killed
// mid-run. Built-in loops therefore run UNTIMED (0 = no timeout, both the run
// deadline and the per-step watchdog); maxIterations and the optional cost cap
// remain the runaway guards.
const FACTORY_MAX_ITERATIONS = 12
const FACTORY_LOOP_TIMEOUT_MIN = 0
const FACTORY_AI_STEP_TIMEOUT_MIN = 0

const SDD_QUICK_OPENSPEC_FACTORY: FactoryLoop = {
  id: 'factory:sdd-quick-openspec',
  name: 'SDD Quick (OpenSpec)',
  description: 'Quick spec-driven OpenSpec lifecycle for small contract-governed changes: amend artifacts, apply, verify, and archive only after PASS.',
  mode: 'loop',
  graph: opsxLifecycleGraph(),
}

export const FACTORY_LOOPS: FactoryLoop[] = [
  {
    id: 'factory:implement',
    name: 'Implement',
    description: 'Fully autonomous: implement the spec, verify, and refine (fix) on failure — looping until all tests pass.',
    mode: 'implement',
    graph: fixLoopGraph(['{{cmd:implement}}'], GREEN_GOAL, FACTORY_MAX_ITERATIONS, FACTORY_LOOP_TIMEOUT_MIN, FACTORY_AI_STEP_TIMEOUT_MIN),
  },
  {
    id: 'factory:batch',
    name: 'Batch Implement',
    description: 'Batch-implement all the rail\'s tickets at once, then verify + refine on failure until green.',
    mode: 'batch-implement',
    graph: fixLoopGraph(['{{cmd:batch}}'], GREEN_GOAL, FACTORY_MAX_ITERATIONS, FACTORY_LOOP_TIMEOUT_MIN, FACTORY_AI_STEP_TIMEOUT_MIN),
  },
  {
    id: 'factory:freestyle',
    // User-facing name for the canonical freestyle mode: it hands the spec straight to the model
    // with full freedom — no pipeline, it works like a regular coding agent.
    // The id/mode strings are the canonical rail contract.
    name: 'Freestyle',
    description: 'Hands the spec straight to the model with full freedom — no pipeline, it works like a regular coding agent, then verify + refine until green.',
    mode: 'freestyle',
    requiredCapability: 'freestyle',
    graph: fixLoopGraph(['{{cmd:freestyle}}'], GREEN_GOAL, FACTORY_MAX_ITERATIONS, FACTORY_LOOP_TIMEOUT_MIN, FACTORY_AI_STEP_TIMEOUT_MIN),
  },
  SDD_QUICK_OPENSPEC_FACTORY,
]

const FACTORY_ALIASES = new Map<string, FactoryLoop>([
  ['factory:openspec', SDD_QUICK_OPENSPEC_FACTORY],
])

const FACTORY_BY_ID = new Map<string, FactoryLoop>([
  ...FACTORY_LOOPS.map((f) => [f.id, f] as const),
  ...FACTORY_ALIASES,
])

export function getFactoryLoop(id: string): FactoryLoop | undefined {
  return FACTORY_BY_ID.get(id)
}

/** True for any `factory:*` loop id. */
export function isFactoryLoopId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('factory:')
}

/** Map a factory loop id → its legacy rail mode (for back-compat routing). */
export function factoryLoopMode(id: string): FactoryLoop['mode'] | undefined {
  return FACTORY_BY_ID.get(id)?.mode
}

/** Map a legacy rail mode → the matching factory loop (so a legacy rail with a
 *  `mode` and no selected loop resolves to a factory loop on read). */
export function factoryLoopForMode(mode: string): FactoryLoop | undefined {
  if (mode === 'implement') return FACTORY_BY_ID.get('factory:implement')
  if (mode === 'batch-implement') return FACTORY_BY_ID.get('factory:batch')
  if (mode === 'freestyle') return FACTORY_BY_ID.get('factory:freestyle')
  return undefined
}
