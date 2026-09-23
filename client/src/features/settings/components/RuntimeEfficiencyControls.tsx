import { useTranslation } from 'react-i18next'
import type { AgentRuntimeConfig, RuntimeAgent, RuntimeAgentRole } from '../lib/agent-runtime'
import { Input } from '../../../components/ui/input'

export interface RoleCapability {
  role: RuntimeAgentRole; tier: 'base' | 'escalation'; provider: string; model: string | null
  transport: string; continuation: 'supported' | 'unsupported' | 'unknown'
  effortSupport: 'supported' | 'unsupported' | 'unknown'; supportedEfforts: string[] | null
}
const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm'
function Effort({ value, capability, onChange }: { value?: string; capability?: RoleCapability; onChange(value?: string): void }) {
  const { t } = useTranslation('agentRuntime')
  const levels = capability?.effortSupport === 'supported' ? capability.supportedEfforts ?? [] : []
  return <label className="block space-y-1 text-xs">{t('efficiency.effort')}
    <select aria-label={t('efficiency.effort')} className={selectClass} value={value ?? ''} onChange={event => onChange(event.target.value || undefined)}>
      <option value="">{t('efficiency.providerDefault')}</option>
      {levels.map(level => <option key={level} value={level}>{level}</option>)}
      {value && !levels.includes(value) && <option value={value}>{value} — {t('efficiency.unconfirmed')}</option>}
    </select>
    <span className="block text-muted-foreground">{capability?.effortSupport === 'supported' ? capability.transport : t('efficiency.unknownSupport')}</span>
  </label>
}
export function RuntimeRoleEfficiency({ role, agent, capabilities, onChange }: { role: RuntimeAgentRole; agent: RuntimeAgent; capabilities: RoleCapability[]; onChange(agent: RuntimeAgent): void }) {
  const { t } = useTranslation('agentRuntime')
  const capability = (tier: 'base' | 'escalation') => capabilities.find(item => item.role === role && item.tier === tier && item.provider === agent.provider && item.model === ((tier === 'base' ? agent.model : agent.escalation?.model) ?? null))
  return <div className="mt-3 space-y-3 border-t pt-3">
    <Effort value={agent.effort} capability={capability('base')} onChange={effort => onChange({ ...agent, effort })} />
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(agent.escalation)} disabled={!agent.model} onChange={event => onChange({ ...agent, escalation: event.target.checked ? { model: '' } : undefined })} />{t('efficiency.escalation')}</label>
    <p className="text-xs text-muted-foreground">{t(`efficiency.triggers.${role}`)} {!agent.model && t('efficiency.baseRequired')}</p>
    {agent.escalation && <div className="grid gap-3 sm:grid-cols-2">
      <label className="block space-y-1 text-xs">{t('efficiency.escalationModel')}<Input value={agent.escalation.model} onChange={event => onChange({ ...agent, escalation: { ...agent.escalation!, model: event.target.value, effort: undefined } })} /></label>
      <Effort value={agent.escalation.effort} capability={capability('escalation')} onChange={effort => onChange({ ...agent, escalation: { ...agent.escalation!, effort } })} />
    </div>}
  </div>
}
export function RuntimeEfficiencyControls({ config, onChange }: { config: AgentRuntimeConfig; onChange(config: AgentRuntimeConfig): void }) {
  const { t } = useTranslation('agentRuntime')
  const policy = config.efficiency ?? { schemaVersion: 1 as const }
  return <section className="space-y-3" aria-label={t('efficiency.title')}>
    <h3 className="text-sm font-medium">{t('efficiency.title')}</h3>
    <p className="text-xs text-muted-foreground">{t('efficiency.scope')}</p>
    <div className="grid gap-3 sm:grid-cols-3">{(['contextMode', 'reviewMode', 'planning'] as const).map(key => <label key={key} className="block space-y-1 text-xs">{t(`efficiency.${key}`)}
      <select className={selectClass} value={policy[key] ?? (key === 'planning' ? 'proportional' : 'incremental')} onChange={event => onChange({ ...config, efficiency: { ...policy, [key]: event.target.value } })}>
        <option value={key === 'planning' ? 'proportional' : 'incremental'}>{t('efficiency.adaptive')}</option><option value="full">{t('efficiency.full')}</option>
      </select>
    </label>)}</div>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={policy.acceptDeveloperChecks !== false} onChange={event => onChange({ ...config, efficiency: { ...policy, acceptDeveloperChecks: event.target.checked } })} />{t('efficiency.developerChecks')}</label>
    <label className="block space-y-1 text-xs">{t('efficiency.concurrency')}<Input type="number" min="1" max="4" step="1" value={policy.verification?.maxConcurrency ?? 1} onChange={event => onChange({ ...config, efficiency: { ...policy, verification: { ...policy.verification, maxConcurrency: Number(event.target.value) } } })} /></label>
    <p className="text-xs text-muted-foreground">{t('efficiency.concurrencyHint')}</p>
  </section>
}
