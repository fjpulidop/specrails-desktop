import type { LoopAgentConfig } from './loop-agents'
import type { LoopGraph } from './loop-graph'

/** Ceiling older Cores apply when a role sets no `maxTurns` (Core `cli-executor`). */
export const LEGACY_CORE_DEFAULT_MAX_TURNS = 100

/** Core's ceiling when a role sets no `maxTurns`: none (`null`) for a Core advertising `unlimitedTurns`, else the legacy 100. */
export function coreDefaultMaxTurns(capabilities?: Record<string, number>): number | null {
  return capabilities?.unlimitedTurns === 1 ? null : LEGACY_CORE_DEFAULT_MAX_TURNS
}

export interface LoopStepTurnLimit {
  /** Canvas node id (e.g. `developer`). */
  stepId: string
  label?: string
  /** Agent role the step runs (e.g. `build` for the Implement Developer step). */
  role: string
  /** `null` = no turn limit. */
  maxTurns: number | null
  source: 'step' | 'role' | 'core-default'
}

type RoleEngine = { maxTurns?: number } | undefined

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** The agent role a canvas step runs, mirroring the definition compiler. */
export function loopStepRole(id: string, kind: unknown, params: Record<string, unknown>): string | undefined {
  if (kind === 'prompt') return id === 'fix' ? 'fixer' : id === 'prepare' ? 'architect' : params.access === 'read' ? 'reviewer' : 'developer'
  if ((kind === 'role-turn' || kind === 'decider') && typeof params.roleId === 'string') return params.roleId
  if (kind === 'implementation-step' && ['architect', 'developer', 'reviewer', 'fixer'].includes(String(params.phase))) return String(params.phase)
  return undefined
}

function roleEngine(agents: LoopAgentConfig | undefined, role: string): RoleEngine {
  if (!agents) return undefined
  if (role === 'fixer') return agents.fixer ?? agents.agents.developer
  if (role === 'architect' || role === 'developer' || role === 'reviewer') return agents.agents[role]
  return agents.roles?.[role]
}

/** Effective per-step turn ceiling: step engine override, then the loop role, then Core's default. */
export function loopTurnLimits(graph: LoopGraph, capabilities?: Record<string, number>): LoopStepTurnLimit[] {
  const coreDefault = coreDefaultMaxTurns(capabilities)
  const agents = graph.config.agents as LoopAgentConfig | undefined
  const limits: LoopStepTurnLimit[] = []
  const visit = (body: LoopGraph) => {
    for (const node of body.nodes) {
      if (node.type !== 'core') continue
      const params = object(node.data?.params) ? node.data!.params! : {}
      const role = loopStepRole(node.id, node.data?.kind, params)
      if (!role) continue
      const label = typeof node.data?.label === 'string' ? node.data.label : undefined
      const stepTurns = object(params.engine) ? params.engine.maxTurns : undefined
      const roleTurns = roleEngine(agents, role)?.maxTurns
      const [maxTurns, source] = typeof stepTurns === 'number' ? [stepTurns, 'step' as const]
        : typeof roleTurns === 'number' ? [roleTurns, 'role' as const] : [coreDefault, 'core-default' as const]
      limits.push({ stepId: node.id, ...(label ? { label } : {}), role, maxTurns, source })
    }
  }
  visit(graph)
  for (const component of Object.values(graph.components ?? {})) visit(component)
  return limits
}

const TURN_LIMIT = /reached the configured limit of (\d+) turns for ([\w:-]+)/

/** Appends where to raise the limit to Core's turn-limit failure; other messages pass through. */
export function withTurnLimitHint(message: string, stepId?: string): string {
  const match = message.match(TURN_LIMIT)
  if (!match) return message
  const step = stepId ? `the "${stepId}" step` : `the step that runs role "${match[2]}"`
  return `${message} To raise it: Loops ▸ this loop ▸ select ${step} ▸ "Maximum turns" (role "${match[2]}", currently ${match[1]}), save and publish. Project Settings do not change loop runs.`
}
