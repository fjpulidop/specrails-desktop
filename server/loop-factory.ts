/**
 * Built-in "factory" loops — the app-owned loops that replace the old rail modes
 * (`implement` / `batch-implement` / `ultracode`). They appear in the Loops
 * gallery as read-only (locked) entries the user can run on a rail or "Fork to
 * edit" into an editable custom loop.
 *
 * Each carries the legacy `mode` it maps to. In phase A the rail launch routes a
 * factory loop to the EXISTING engine via that mode (QueueManager slash command /
 * ultracode prompt) — the graph here is the faithful representation used for the
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
  /** Rail mode this loop maps to: a legacy engine mode for back-compat routing,
   *  or `'loop'` for graph-native factory loops that ONLY run through the
   *  LoopRunManager (no legacy fallback — launch 403s when Loops are disabled). */
  mode: 'implement' | 'batch-implement' | 'ultracode' | 'loop'
  /** claude-only (ultracode). */
  claudeOnly?: boolean
  /** Faithful graph for preview + fork seed. */
  graph: LoopGraph
}

const GREEN_GOAL = 'Stop only when the latest verification step reports {{const:VERIFICATION_PASS}} and the history proves the spec is implemented with all required tests/build checks passing.'

// Factory loops run the WHOLE architect→developer→reviewer pipeline inside a
// single AI step (`/specrails:implement` etc.), so they need far more headroom
// than the engine defaults (loop 30 min / step 15 min): a real implement can run
// for a long time. 360 min loop deadline, 60 min per AI step.
const FACTORY_MAX_ITERATIONS = 12
const FACTORY_LOOP_TIMEOUT_MIN = 360
const FACTORY_AI_STEP_TIMEOUT_MIN = 60

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
    id: 'factory:ultracode',
    // Renamed from "Ultracode": the mode hands the spec straight to the model
    // with full freedom — no pipeline, it works like a regular coding agent.
    // The id/mode strings stay 'ultracode' (wire + rail back-compat).
    name: 'Freestyle',
    description: 'Hands the spec straight to the model with full freedom — no pipeline, it works like a regular coding agent, then verify + refine until green. Claude only.',
    mode: 'ultracode',
    claudeOnly: true,
    graph: fixLoopGraph(['{{cmd:ultracode}}'], GREEN_GOAL, FACTORY_MAX_ITERATIONS, FACTORY_LOOP_TIMEOUT_MIN, FACTORY_AI_STEP_TIMEOUT_MIN),
  },
  {
    id: 'factory:openspec',
    name: 'OpenSpec Lifecycle',
    description: 'Ticket-to-archive OpenSpec lifecycle: generate artifacts (opsx:ff) → implement (opsx:apply) → verify (opsx:verify); on FAIL loop back and amend the same change, on PASS archive it unattended.',
    mode: 'loop',
    graph: opsxLifecycleGraph(),
  },
]

const FACTORY_BY_ID = new Map(FACTORY_LOOPS.map((f) => [f.id, f]))

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
  if (mode === 'ultracode') return FACTORY_BY_ID.get('factory:ultracode')
  return undefined
}
