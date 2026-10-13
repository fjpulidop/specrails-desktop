import { useTranslation } from 'react-i18next'
import { Input } from '../../../components/ui/input'
import type { RuntimeAgent } from '../../settings/lib/agent-runtime'
import { CORE_DEFAULT_MAX_TURNS, roleAgent, withRoleAgent } from '../lib/loop-role-agents'
import { nodeAgentRoles } from '../lib/core-authoring'
import type { LoopGraph, LoopAgentConfig } from '../lib/loops-api'

/** Role → the canvas steps that run it, in graph order (components included). */
function stepsByRole(graph: LoopGraph): Map<string, string[]> {
  const roles = new Map<string, string[]>()
  const visit = (body: LoopGraph) => {
    for (const node of body.nodes) {
      if (node.type !== 'core') continue
      const params = node.data?.params && typeof node.data.params === 'object' ? node.data.params as Record<string, unknown> : {}
      const label = typeof node.data?.label === 'string' && node.data.label ? node.data.label : node.id
      for (const role of nodeAgentRoles(node.id, node.data?.kind, params)) roles.set(role, [...roles.get(role) ?? [], label])
    }
  }
  visit(graph)
  for (const component of Object.values(graph.components ?? {})) visit(component)
  return roles
}

/** One place to read and set every AI step's turn ceiling for this loop. */
export function LoopTurnLimits({ graph, value, onChange }: { graph: LoopGraph; value: LoopAgentConfig; onChange(value: LoopAgentConfig): void }) {
  const { t } = useTranslation('agentRuntime')
  const rows = [...stepsByRole(graph)].filter(([role]) => roleAgent(value, role))
  if (!rows.length) return null
  return <details open className="rounded-md border border-border p-2" aria-label={t('loopAgents.turnLimits.title')}>
    <summary className="cursor-pointer text-sm font-medium">{t('loopAgents.turnLimits.title')}</summary>
    <p className="mt-2 text-xs text-muted-foreground">{t('loopAgents.turnLimits.hint', { turns: CORE_DEFAULT_MAX_TURNS })}</p>
    <div className="mt-3 space-y-2">
      {rows.map(([role, steps]) => {
        const agent = roleAgent(value, role)!
        return <label key={role} className="grid grid-cols-[1fr_6rem] items-center gap-2 text-xs">
          <span className="min-w-0">
            <span className="block truncate font-medium text-foreground">{steps.join(' · ')}</span>
            <span className="block truncate text-muted-foreground">{t('loopAgents.turnLimits.role', { role })}</span>
          </span>
          <Input type="number" min={1} inputMode="numeric" aria-label={t('loopAgents.turnLimits.input', { steps: steps.join(', '), role })}
            placeholder={String(CORE_DEFAULT_MAX_TURNS)} value={agent.maxTurns ?? ''}
            onChange={event => onChange(withRoleAgent(value, role, { ...agent, maxTurns: event.target.value ? Math.max(1, Math.floor(Number(event.target.value))) : undefined } as RuntimeAgent))} />
        </label>
      })}
    </div>
  </details>
}
