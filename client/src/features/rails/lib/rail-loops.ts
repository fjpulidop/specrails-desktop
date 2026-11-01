/**
 * rails-as-loops — client helpers mapping a rail's chosen Loop ⇄ the legacy
 * `mode`. A rail now "picks a Loop"; the factory loop maps back to the mode the
 * server still understands (back-compat), and custom loops derive `mode='loop'`.
 *
 * Implement is the ONLY built-in. Freestyle and Quick SDD (OpenSpec) are gallery
 * loops: the app never offers them on a rail by itself, and a pick that still
 * names a retired built-in id (persisted rail state, a stale card) is read as
 * Implement — see {@link migratedRailLoopId}.
 */
import type { RailMode } from '../components/RailControls'

/** Factory loop id for each legacy mode (the rail's built-in loops). */
export const FACTORY_LOOP_ID: Record<Exclude<RailMode, 'loop'>, string> = {
  implement: 'factory:implement',
}

/** Built-in loop ids that no longer exist (the server refuses them with
 *  `builtin_loop_retired`). Kept only to migrate persisted picks. */
export const RETIRED_RAIL_LOOP_IDS: readonly string[] = ['factory:freestyle', 'factory:sdd-quick-openspec', 'factory:openspec', 'factory:revision']

export function isRetiredRailLoopId(loopId: string | null | undefined): boolean {
  return typeof loopId === 'string' && RETIRED_RAIL_LOOP_IDS.includes(loopId)
}

/** A persisted/remote loop pick, with retired built-ins and the removed Batch
 *  loop read as Implement. Everything else (custom loop ids, null) is unchanged. */
export function migratedRailLoopId<T extends string | null | undefined>(loopId: T): T | 'factory:implement' {
  return isRetiredRailLoopId(loopId) || loopId === 'factory:batch' ? 'factory:implement' : loopId
}

/**
 * The built-in loops offered in the rail picker. Defined CLIENT-SIDE (not fetched)
 * because Implement IS the always-available rail mode — it must work even when the
 * Loops section feature is off. `labelKey` reuses the existing `railControls.*`
 * i18n.
 */
export const FACTORY_RAIL_LOOPS: { id: string; labelKey: string; descriptionKey: string }[] = [
  { id: 'factory:implement', labelKey: 'railControls.implement', descriptionKey: 'railControls.loopDescriptions.implement' },
]

/** The factory loop id a legacy `mode` maps to ('' for the custom `loop` mode). */
export function factoryIdForMode(mode: RailMode): string {
  return mode === 'loop' ? '' : FACTORY_LOOP_ID[mode]
}

/** Derive the legacy `mode` from a chosen loop id (factory → its mode; any custom
 *  loop → 'loop'). */
export function deriveRailMode(loopId: string | null | undefined): RailMode {
  // `factory:batch` is the removed Batch loop and the retired built-ins fall back
  // to Implement.
  if (loopId === 'factory:implement' || loopId === 'factory:batch' || isRetiredRailLoopId(loopId)) return 'implement'
  return 'loop'
}

/** The loop id a rail should treat as selected: the explicit pick, else the
 *  spec triage recommendation (launch-triage) while the rail is on its default
 *  mode, else the factory loop matching its (legacy) mode — so a mode-only rail
 *  still resolves. An explicit pick or an explicit non-default mode always wins. */
export function effectiveLoopId(selectedLoopId: string | null | undefined, mode: RailMode, hasAddenda = false, recommendedLoopId?: string | null): string {
  // Spec addenda run on Implement unless a loop was picked (the server's default too).
  if (!selectedLoopId && hasAddenda) return 'factory:implement'
  if (selectedLoopId && migratedRailLoopId(selectedLoopId) !== selectedLoopId) return 'factory:implement'
  return selectedLoopId || (mode === 'implement' && recommendedLoopId) || factoryIdForMode(mode)
}

/**
 * The triage recommendation a rail may preselect: only a loop the rail picker
 * actually offers (built-ins behind their gates; custom loops only with the
 * Loops section on). Anything else (e.g. Intent -> Spec) is never preselected.
 */
export function offeredRecommendation(
  loopId: string | null | undefined,
  opts: { loopsEnabled?: boolean } = {},
): string | null {
  if (!loopId) return null
  const loopsEnabled = opts.loopsEnabled ?? true
  if (loopId.startsWith('factory:')) return FACTORY_RAIL_LOOPS.some((f) => f.id === loopId) ? loopId : null
  return loopsEnabled ? loopId : null
}

/** The `selectedLoopId` a board adopts from a server-side loop run it did not
 *  launch: user loops (random ids) are selected so the rail header labels the
 *  run; built-ins (`factory:*`) keep the rail's own selection/mode. */
export function adoptedSelectedLoopId(loopId: string | null | undefined): string | undefined {
  return loopId && !loopId.startsWith('factory:') ? loopId : undefined
}
