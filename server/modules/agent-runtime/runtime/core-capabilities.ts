/**
 * Phase-3 capabilities of the active Core (feedback-2026-10): architect
 * clarifications, requirement traceability, baseline on
 * touch and the project rules inventory (all contract 5.7). Every Desktop surface built on
 * them is gated here: a Core that does not announce a capability leaves the
 * surface exactly as it was before the program.
 *
 * Any failure (no Core, an unreadable `runtime api`) reads as "nothing
 * announced". The loader is imported lazily so callers do not initialize the
 * runtime at module load.
 */
export interface CorePhase3Capabilities {
  architectClarifications: boolean
  specTrace: boolean
  baselineOnTouch: boolean
  rulesInventory: boolean
}

export const NO_PHASE3_CAPABILITIES: CorePhase3Capabilities = Object.freeze({
  architectClarifications: false, specTrace: false, baselineOnTouch: false, rulesInventory: false,
})

/** Pure projection of a `runtime api` capability map. */
export function phase3CapabilitiesFrom(capabilities: Record<string, unknown> | null | undefined): CorePhase3Capabilities {
  const on = (key: keyof CorePhase3Capabilities): boolean => capabilities?.[key] === 1
  return { architectClarifications: on('architectClarifications'), specTrace: on('specTrace'), baselineOnTouch: on('baselineOnTouch'), rulesInventory: on('rulesInventory') }
}

export async function corePhase3Capabilities(): Promise<CorePhase3Capabilities> {
  try {
    const { loadCoreAgentRuntime } = await import('./agent-runtime-loader')
    return phase3CapabilitiesFrom((await loadCoreAgentRuntime()).api?.capabilities as Record<string, unknown> | undefined)
  } catch {
    return { ...NO_PHASE3_CAPABILITIES }
  }
}
