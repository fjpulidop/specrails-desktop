import type { RuntimeAgent } from '../../settings/lib/agent-runtime'
import type { LoopAgentConfig } from './loops-api'

/** Core's per-turn ceiling when a role sets no `maxTurns` (mirrors the server's `CORE_DEFAULT_MAX_TURNS`). */
export const CORE_DEFAULT_MAX_TURNS = 100

const BUILTIN = ['architect', 'developer', 'reviewer'] as const

/** The engine a loop role runs: built-in agents, the fixer (falls back to the developer) or a custom role. */
export function roleAgent(value: LoopAgentConfig, role: string): RuntimeAgent | undefined {
  if (role === 'fixer') return value.fixer ?? value.agents.developer
  if ((BUILTIN as readonly string[]).includes(role)) return value.agents[role as typeof BUILTIN[number]]
  return value.roles?.[role]
}

/** Replace a role's engine, keeping a custom role's access/artifacts/prompt descriptor. */
export function withRoleAgent(value: LoopAgentConfig, role: string, next: RuntimeAgent): LoopAgentConfig {
  if (role === 'fixer') return { ...value, fixer: next }
  if ((BUILTIN as readonly string[]).includes(role)) return { ...value, agents: { ...value.agents, [role]: next } }
  return { ...value, roles: { ...value.roles, [role]: { ...value.roles![role], ...next } } }
}
