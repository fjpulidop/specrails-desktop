import { useTranslation } from 'react-i18next'
import { agentRoleField, readAgentRoleMetadata, setAgentRoleMetadata, type AgentRoleField } from '../lib/agent-role-metadata'

const fieldClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm'

/** Metadata defaults belong to the agent file; project settings can override them. */
export function AgentRoleFields({ body, onChange }: { body: string; onChange(body: string): void }) {
  const { t } = useTranslation('agentRuntime')
  let metadata: Record<string, unknown>
  try { metadata = readAgentRoleMetadata(body).metadata }
  catch { return <p role="alert" className="px-4 py-2 text-xs text-destructive">{t('studioRole.invalid')}</p> }
  const update = (field: AgentRoleField, value: string) => onChange(setAgentRoleMetadata(body, field, value))
  const select = (field: AgentRoleField, label: string, options: Array<[string, string]>, fallback = '') => <label className="space-y-1 text-xs">{label}
    <select className={fieldClass} value={agentRoleField(metadata, field) || fallback} onChange={event => update(field, event.target.value)}>
      {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  </label>
  const input = (field: AgentRoleField, label: string, numeric = false) => <label className="space-y-1 text-xs">{label}
    <input className={fieldClass} type={numeric ? 'number' : 'text'} min={numeric ? 1 : undefined} step={numeric ? 1 : undefined} maxLength={numeric ? undefined : 256} placeholder={t('efficiency.providerDefault')} value={agentRoleField(metadata, field)} onChange={event => update(field, event.target.value)} />
  </label>
  return <details className="border-b border-border px-4 py-2" open>
    <summary className="cursor-pointer text-xs font-medium">{t('studioRole.title')}</summary>
    <p className="my-2 text-xs text-muted-foreground">{t('studioRole.hint')}</p>
    <div className="grid gap-2 sm:grid-cols-3">
      {select('access', t('customRoles.access'), [['read', t('customRoles.read')], ['write', t('customRoles.write')]], 'read')}
      {select('artifacts', t('customRoles.artifacts'), [['none', t('customRoles.none')], ['tasks-checkboxes', t('customRoles.tasks')], ['all', t('customRoles.all')]], 'none')}
      {select('openspecSkill', t('customRoles.skill'), [['', t('customRoles.noSkill')], ...['openspec-ff-change', 'openspec-apply-change', 'openspec-verify-change'].map(skill => [skill, skill] as [string, string])])}
      {input('engine.provider', t('agents.provider'))}
      {input('engine.model', t('agents.model'))}
      {input('engine.effort', t('efficiency.effort'))}
      {input('engine.maxTurns', t('agents.maxTurns', { turns: 100 }), true)}
      {select('engine.thinking', t('agents.thinking'), [['', t('efficiency.providerDefault')], ['off', t('agents.thinking_off')], ['on', t('agents.thinking_on')]])}
      {input('engine.escalation.model', t('efficiency.escalationModel'))}
      {input('engine.escalation.effort', t('studioRole.escalationEffort'))}
    </div>
    <p className="mt-2 text-xs text-muted-foreground">{t('customRoles.escalationHint')}</p>
  </details>
}
