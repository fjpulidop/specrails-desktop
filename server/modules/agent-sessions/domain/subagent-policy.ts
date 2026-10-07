import type { DriverDescriptor, SubagentRuntimeInput } from './protocol'

/**
 * Conversational surfaces whose agents run in Core sessions. Implement
 * pipelines are not a surface here: they never resolve a sub-agent policy, so
 * the "Allow sub-agents" setting cannot affect them.
 */
export type ConversationalSurface = 'mission' | 'explore' | 'refinement'

export type SubagentPolicy = 'enabled' | 'disabled'

export interface SubagentPolicyInput {
  surface: ConversationalSurface
  /** The project's "Allow sub-agents" setting; `null` when the conversation has no project. */
  projectAllows: boolean | null
  /** The app-global setting for conversations without a project. */
  globalAllows: boolean
}

/** The project setting decides; conversations without a project use the global one. */
export function resolveSubagentPolicy(input: SubagentPolicyInput): SubagentPolicy {
  const allowed = input.projectAllows ?? input.globalAllows
  return allowed ? 'enabled' : 'disabled'
}

/** "Run sub-agents with" as the user chose it; null = the mission agent's own provider. */
export interface SubagentRuntimeChoice {
  provider: string
  model: string
  effort: string | null
}

export interface SubagentRuntimeResolution {
  runtime: SubagentRuntimeInput
  /** Set when the choice cannot be honoured by the selected Core; sub-agents stay native. */
  unavailable?: 'delegation_unsupported' | 'driver_unavailable'
}

/**
 * Hybrid runtime (core-agent-sessions-host D9): native unless the user chose a
 * provider other than the mission's; then Core launches them. Overrides a
 * driver cannot apply are dropped (the UI never offers them).
 */
export function resolveSubagentRuntime(input: {
  choice: SubagentRuntimeChoice | null
  missionProvider: string
  drivers: readonly DriverDescriptor[]
  delegation: boolean
}): SubagentRuntimeResolution {
  const { choice } = input
  if (!choice) return { runtime: { mode: 'native' } }
  if (choice.provider === input.missionProvider) {
    const caps = input.drivers.find((driver) => driver.id === input.missionProvider)?.capabilities
    return {
      runtime: {
        mode: 'native',
        ...(caps?.subagentModel ? { model: choice.model } : {}),
        ...(caps?.subagentEffort && choice.effort ? { effort: choice.effort } : {}),
      },
    }
  }
  if (!input.delegation) return { runtime: { mode: 'native' }, unavailable: 'delegation_unsupported' }
  if (!input.drivers.some((driver) => driver.id === choice.provider)) return { runtime: { mode: 'native' }, unavailable: 'driver_unavailable' }
  return { runtime: { mode: 'delegated', driver: choice.provider, model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}) } }
}

