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
import { fixLoopGraph } from './loop-templates'

export interface FactoryLoop {
  /** Stable namespaced id, e.g. `factory:implement`. */
  id: string
  name: string
  description: string
  /** Legacy rail mode this loop maps to (for back-compat routing). */
  mode: 'implement' | 'batch-implement' | 'ultracode'
  /** claude-only (ultracode). */
  claudeOnly?: boolean
  /** Faithful graph for preview + fork seed. */
  graph: LoopGraph
}

const GREEN_GOAL = 'The verification step reported {{const:VERIFICATION_PASS}} — the spec is implemented and all tests pass.'

export const FACTORY_LOOPS: FactoryLoop[] = [
  {
    id: 'factory:implement',
    name: 'Implement',
    description: 'Fully autonomous: implement the spec, verify, and refine (fix) on failure — looping until all tests pass.',
    mode: 'implement',
    graph: fixLoopGraph(['{{cmd:implement}}'], GREEN_GOAL),
  },
  {
    id: 'factory:batch',
    name: 'Batch Implement',
    description: 'Batch-implement all the rail\'s tickets at once, then verify + refine on failure until green.',
    mode: 'batch-implement',
    graph: fixLoopGraph(['{{cmd:batch}}'], GREEN_GOAL),
  },
  {
    id: 'factory:ultracode',
    name: 'Ultracode',
    description: 'Autonomous per-ticket implementation (no pipeline), then verify + refine until green. Claude only.',
    mode: 'ultracode',
    claudeOnly: true,
    graph: fixLoopGraph(['{{cmd:ultracode}}'], GREEN_GOAL),
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
