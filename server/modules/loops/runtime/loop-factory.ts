/**
 * Built-in "factory" loops — the app-owned loops that replace the old rail modes.
 * Only Implement (and the platform-run Intent -> Spec) is built in. Freestyle and
 * Quick SDD (OpenSpec) were retired as built-ins: they are ordinary gallery
 * templates now (`loop-templates.ts`) and the app never offers or launches them
 * by itself. Their ids stay recognised ONLY as retired ids so persisted data and
 * stale clients get a clear answer (see `RETIRED_FACTORY_LOOP_IDS`).
 *
 * These are the code DEFAULTS; `builtin-loops.ts` seeds Implement as an editable
 * loop row (same id) and resolves launches to an edited, published row when one
 * exists.
 *
 * Each carries the canonical rail `mode` it maps to. The rail launch routes a
 * factory loop to the matching engine via that mode — the graph here is the
 * faithful representation used for the gallery preview and as the seed when
 * forked into a custom loop.
 *
 * IDs are namespaced `factory:<mode-ish>` so they never collide with user loop ids
 * (which are random) and the rail resolver can recognise a factory loop.
 */
import { coreFactoryGraph } from './loop-core-factory'
import { flowSpecGraph } from './loop-flow-spec-recipe'
import type { LoopGraph } from './loop-graph'

export interface FactoryLoop {
  /** Stable namespaced id, e.g. `factory:implement`. */
  id: string
  name: string
  description: string
  /** Rail mode this loop maps to: a canonical engine mode,
   *  or `'loop'` for graph-native factory loops that ONLY run through the
   *  LoopRunManager (no QueueManager fallback — launch 403s when Loops are disabled). */
  mode: 'implement' | 'loop'
  /** Core runtime capability the loop needs (listed only when advertised). */
  requiredCoreCapability?: 'deriveChange'
  /**
   * False for a loop the platform runs on its OWN initiative and a user must
   * never start by hand — it is listed for discovery (preview/fork) but has no
   * launch path.
   */
  launchable?: boolean
  /** Faithful graph for preview + fork seed. */
  graph: LoopGraph
}

// Factory loops run the WHOLE architect→developer→reviewer pipeline inside a
// single AI step (`/specrails:implement` etc.), so no fixed wall-clock budget is
// honest — a legit implement outran the old 60-min step cap and got killed
// mid-run. Built-in loops therefore run UNTIMED (0 = no timeout, both the run
// deadline and the per-step watchdog); maxIterations and the optional cost cap
// remain the runaway guards.
const FACTORY_MAX_ITERATIONS = 12
const FACTORY_LOOP_TIMEOUT_MIN = 0
const FACTORY_AI_STEP_TIMEOUT_MIN = 0

/** Core owns the complete implementation/review cycle. Desktop runs it once. */
function coreImplementationGraph(command: 'implement'): LoopGraph {
  return {
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 } },
      { id: 'main-1', type: 'ai-step', position: { x: 0, y: 110 }, data: { operation: 'core-implementation', prompt: `{{cmd:${command}}}` } },
      { id: 'done', type: 'end', position: { x: 0, y: 220 }, data: { outcome: 'success' } },
    ],
    edges: [
      { id: 'e-start', source: 'start', target: 'main-1' },
      { id: 'e-main-1', source: 'main-1', target: 'done' },
    ],
    config: {
      maxIterations: FACTORY_MAX_ITERATIONS,
      timeoutMinutes: FACTORY_LOOP_TIMEOUT_MIN,
      aiStepTimeoutMinutes: FACTORY_AI_STEP_TIMEOUT_MIN,
    },
  }
}

/** Intent -> Spec (Intent mode, arch section 4.8): derives the spec of an Intent session
 *  worktree. Only an Intent session hand-off launches it (the rails route answers 400
 *  `flow_id_required` otherwise); listed with `launchable: false`. */
export const FLOW_SPEC_LOOP_ID = 'factory:flow-spec'

const FLOW_SPEC_FACTORY: FactoryLoop = {
  id: FLOW_SPEC_LOOP_ID,
  name: 'Intent → Spec',
  description: 'Derives the spec of code built in an Intent session: writes the OpenSpec change from the diff and the conversation, verifies it, reviews coverage and archives it.',
  mode: 'loop',
  requiredCoreCapability: 'deriveChange',
  launchable: false,
  graph: flowSpecGraph(),
}

/** Core advertises the workflow engine and the derive-change piece. */
export function supportsFlowSpec(capabilities?: Record<string, number>): boolean {
  return capabilities?.engineV2 === 1 && capabilities.workflowDefinitions === 1 && capabilities.deriveChange === 1
}

/** Legacy persisted id of the removed Revision loop. It is never listed or run;
 *  delivery evidence still reads it from historical units. */
export const FACTORY_REVISION_LOOP_ID = 'factory:revision'

/** Freestyle, retired as a built-in (now the `freestyle` gallery template). */
export const RETIRED_FREESTYLE_LOOP_ID = 'factory:freestyle'
/** Quick SDD, retired as a built-in (now the `quick-sdd-openspec` gallery template). */
export const RETIRED_QUICK_SDD_LOOP_ID = 'factory:sdd-quick-openspec'

/** Ids of factory loops that no longer exist. Persisted rails, jobs and loop runs
 *  may still carry them (and `factory:openspec` / `factory:revision`, the old
 *  aliases of Quick SDD): history keeps rendering, but nothing launches them. */
export const RETIRED_FACTORY_LOOP_IDS: readonly string[] = [
  RETIRED_FREESTYLE_LOOP_ID, RETIRED_QUICK_SDD_LOOP_ID, 'factory:openspec', FACTORY_REVISION_LOOP_ID,
]

/** Display names of retired ids, for historical views only. */
export const RETIRED_FACTORY_LOOP_NAMES: Readonly<Record<string, string>> = {
  [RETIRED_FREESTYLE_LOOP_ID]: 'Freestyle',
  [RETIRED_QUICK_SDD_LOOP_ID]: 'SDD Quick (OpenSpec)',
  'factory:openspec': 'SDD Quick (OpenSpec)',
  [FACTORY_REVISION_LOOP_ID]: 'SDD Quick (OpenSpec)',
}

/** The loop a retired id or the `freestyle` rail mode falls back to when the
 *  fallback is allowed (stored rail configuration). */
export const RETIRED_FACTORY_REPLACEMENT_ID = 'factory:implement'

export function isRetiredFactoryLoopId(id: unknown): boolean {
  return typeof id === 'string' && RETIRED_FACTORY_LOOP_IDS.includes(id)
}


export const FACTORY_LOOPS: FactoryLoop[] = [
  {
    id: 'factory:implement',
    name: 'Implement',
    description: 'Implements every spec on the rail in one run: plan, implement, review and verify, fixing failures until the checks pass.',
    mode: 'implement',
    graph: coreImplementationGraph('implement'),
  },
]

const FACTORY_ALIASES = new Map<string, FactoryLoop>([
  // Batch was removed: `implement` already runs every rail ticket in one aggregate run.
  ['factory:batch', FACTORY_LOOPS.find(f => f.id === 'factory:implement')!],
])

const FACTORY_BY_ID = new Map<string, FactoryLoop>([
  ...FACTORY_LOOPS.map((f) => [f.id, f] as const),
  [FLOW_SPEC_FACTORY.id, FLOW_SPEC_FACTORY],
  ...FACTORY_ALIASES,
])

/** Factory loops the selected Core can run. Intent -> Spec exists only with
 *  `deriveChange` (no legacy variant: the graph is Core pieces only). */
export function factoryLoopsForCapabilities(capabilities?: Record<string, number>): FactoryLoop[] {
  if (capabilities?.engineV2 !== 1 || capabilities.workflowDefinitions !== 1) return FACTORY_LOOPS
  const loops = FACTORY_LOOPS.map(factory => ({ ...factory, graph: coreFactoryGraph('implement', capabilities.implementationSteps === 1, capabilities.workflowAgentSteps === 1, capabilities) }))
  return supportsFlowSpec(capabilities) ? [...loops, { ...FLOW_SPEC_FACTORY, graph: flowSpecGraph() }] : loops
}

export function getFactoryLoop(id: string, capabilities?: Record<string, number>): FactoryLoop | undefined {
  const legacy = FACTORY_BY_ID.get(id)
  if (!legacy) return undefined
  return factoryLoopsForCapabilities(capabilities).find(factory => factory.id === legacy.id)
}

/** Canonical id of a factory loop or alias, independent of Core capabilities. */
export function canonicalFactoryLoopId(id: string): string | undefined {
  return FACTORY_BY_ID.get(id)?.id
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
export function factoryLoopForMode(mode: string, capabilities?: Record<string, number>): FactoryLoop | undefined {
  if (mode === 'implement') return getFactoryLoop('factory:implement', capabilities)
  // Removed Batch mode: stored `batch-implement` / `batch` rails resolve to Implement.
  if (mode === 'batch-implement' || mode === 'batch') return getFactoryLoop('factory:implement', capabilities)
  // `freestyle` is a retired mode: no factory loop answers it.
  return undefined
}
