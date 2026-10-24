import { useTranslation } from 'react-i18next'
import type { AgentRuntimeConfig, RuntimeAgent } from '../lib/agent-runtime'
import { Input } from '../../../components/ui/input'
import { SettingsSelect } from './SettingsSelect'

export interface RoleCapability {
  role: string; tier: 'base' | 'escalation'; provider: string; model: string | null
  transport: string; continuation: 'supported' | 'unsupported' | 'unknown'
  effortSupport: 'supported' | 'unsupported' | 'unknown'; supportedEfforts: string[] | null
}
function Effort({ value, capability, onChange }: { value?: string; capability?: RoleCapability; onChange(value?: string): void }) {
  const { t } = useTranslation('agentRuntime')
  const levels = capability?.effortSupport === 'supported' ? capability.supportedEfforts ?? [] : []
  return <label className="block space-y-1 text-xs">{t('efficiency.effort')}
    <SettingsSelect
      aria-label={t('efficiency.effort')}
      value={value ?? ''}
      onChange={next => onChange(next || undefined)}
      options={[
        { value: '', label: t('efficiency.providerDefault') },
        ...levels.map(level => ({ value: level, label: level })),
        ...(value && !levels.includes(value) ? [{ value, label: `${value} — ${t('efficiency.unconfirmed')}` }] : []),
      ]}
    />
    <span className="block text-muted-foreground">{capability?.effortSupport === 'supported' ? capability.transport : t('efficiency.unknownSupport')}</span>
  </label>
}
export function RuntimeRoleEfficiency({ role, agent, capabilities, onChange }: { role: string; agent: RuntimeAgent; capabilities: RoleCapability[]; onChange(agent: RuntimeAgent): void }) {
  const { t } = useTranslation('agentRuntime')
  const capability = (tier: 'base' | 'escalation') => capabilities.find(item => item.role === role && item.tier === tier && item.provider === agent.provider && item.model === ((tier === 'base' ? agent.model : agent.escalation?.model) ?? null))
  return <div className="mt-3 space-y-3 border-t pt-3">
    <Effort value={agent.effort} capability={capability('base')} onChange={effort => onChange({ ...agent, effort })} />
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(agent.escalation)} disabled={!agent.model} onChange={event => onChange({ ...agent, escalation: event.target.checked ? { model: '' } : undefined })} />{t('efficiency.escalation')}</label>
    <p className="text-xs text-muted-foreground">{t(['architect', 'developer', 'reviewer', 'fixer'].includes(role) ? `efficiency.triggers.${role}` : 'customRoles.escalationHint')} {!agent.model && t('efficiency.baseRequired')}</p>
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
      <SettingsSelect
        aria-label={t(`efficiency.${key}`)}
        value={policy[key] ?? (key === 'planning' ? 'proportional' : 'incremental')}
        onChange={value => onChange({ ...config, efficiency: { ...policy, [key]: value } })}
        options={[{ value: key === 'planning' ? 'proportional' : 'incremental', label: t('efficiency.adaptive') }, { value: 'full', label: t('efficiency.full') }]}
      />
    </label>)}</div>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={policy.acceptDeveloperChecks !== false} onChange={event => onChange({ ...config, efficiency: { ...policy, acceptDeveloperChecks: event.target.checked } })} />{t('efficiency.developerChecks')}</label>
    <label className="block space-y-1 text-xs">{t('efficiency.concurrency')}<Input type="number" min="1" max="4" step="1" value={policy.verification?.maxConcurrency ?? 1} onChange={event => onChange({ ...config, efficiency: { ...policy, verification: { ...policy.verification, maxConcurrency: Number(event.target.value) } } })} /></label>
    <p className="text-xs text-muted-foreground">{t('efficiency.concurrencyHint')}</p>
  </section>
}
