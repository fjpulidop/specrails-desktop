/**
 * rails-as-loops — client helpers mapping a rail's chosen Loop ⇄ the legacy
 * `mode`. A rail now "picks a Loop"; the factory loops map back to the modes the
 * server still understands (back-compat), and custom loops derive `mode='loop'`.
 */
import type { RailMode } from '../components/RailControls'

/** Factory loop id for each legacy mode (the rail's built-in loops). */
export const FACTORY_LOOP_ID: Record<Exclude<RailMode, 'loop'>, string> = {
  implement: 'factory:implement',
  'batch-implement': 'factory:batch',
  freestyle: 'factory:freestyle',
}

/**
 * The built-in loops offered in the rail picker. Defined CLIENT-SIDE (not fetched)
 * because they ARE the always-available rail modes — they must work even when the
 * Loops section feature is off. `labelKey` reuses the existing `railControls.*`
 * i18n; `requiresFreestyle` hides Freestyle when the active adapter lacks it.
 */
export const FACTORY_RAIL_LOOPS: { id: string; labelKey: string; requiresFreestyle?: boolean; requiresLoops?: boolean }[] = [
  { id: 'factory:implement', labelKey: 'railControls.implement' },
  { id: 'factory:batch', labelKey: 'railControls.batch' },
  { id: 'factory:freestyle', labelKey: 'railControls.freestyle', requiresFreestyle: true },
  // Graph-native built-in: runs only through the LoopRunManager, so it is
  // offered only while the Loops feature is enabled.
  { id: 'factory:sdd-quick-openspec', labelKey: 'railControls.openspec', requiresLoops: true },
]

/** The factory loop id a legacy `mode` maps to ('' for the custom `loop` mode). */
export function factoryIdForMode(mode: RailMode): string {
  return mode === 'loop' ? '' : FACTORY_LOOP_ID[mode]
}

/** Derive the legacy `mode` from a chosen loop id (factory → its mode; any custom
 *  loop → 'loop'). */
export function deriveRailMode(loopId: string | null | undefined): RailMode {
  if (loopId === 'factory:implement') return 'implement'
  if (loopId === 'factory:batch') return 'batch-implement'
  if (loopId === 'factory:freestyle') return 'freestyle'
  return 'loop'
}

/** The loop id a rail should treat as selected: the explicit pick, else the
 *  factory loop matching its (legacy) mode — so a mode-only rail still resolves. */
export function effectiveLoopId(selectedLoopId: string | null | undefined, mode: RailMode): string {
  return selectedLoopId || factoryIdForMode(mode)
}
