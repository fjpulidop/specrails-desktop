import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { CUSTOM_ROLE_ID, RUNTIME_ROLES, type RuntimeRoleDescriptor } from '../lib/agent-runtime'

const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm'
export function CustomRuntimeRoles({ roles = {}, provider, supported, onChange, renderEngine }: {
  roles?: Record<string, RuntimeRoleDescriptor>
  provider: string
  supported: boolean
  onChange(roles: Record<string, RuntimeRoleDescriptor>): void
  renderEngine(id: string): ReactNode
}) {
  const { t } = useTranslation('agentRuntime')
  const [id, setId] = useState(''), [error, setError] = useState(false)
  const custom = Object.entries(roles).filter(([key]) => !(RUNTIME_ROLES as readonly string[]).includes(key))
  function add() {
    if (!CUSTOM_ROLE_ID.test(id) || id === 'fixer' || (RUNTIME_ROLES as readonly string[]).includes(id) || Object.prototype.hasOwnProperty.call(roles, id)) { setError(true); return }
    onChange({ ...roles, [id]: { provider, access: 'read', artifacts: 'none' } }); setId(''); setError(false)
  }
  return <section className="space-y-3" aria-labelledby="custom-runtime-roles">
    <div><h3 id="custom-runtime-roles" className="text-sm font-medium">{t('customRoles.title')}</h3><p className="text-xs text-muted-foreground">{t('customRoles.hint')}</p></div>
    {!supported && <p className="text-xs text-muted-foreground">{t('customRoles.unsupported')}</p>}
    {custom.map(([key, role]) => {
      const update = (value: Partial<RuntimeRoleDescriptor>) => onChange({ ...roles, [key]: { ...role, ...value } })
      return <fieldset key={key} className="space-y-3 rounded-lg border p-3" aria-label={key}>
        <legend className="px-1 font-mono text-sm">{key}</legend>
        <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={() => { const next = { ...roles }; delete next[key]; onChange(next) }}>{t('customRoles.remove', { id: key })}</Button></div>
        <fieldset disabled={!supported} className="space-y-3">
          {renderEngine(key)}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">{t('customRoles.access')}<select className={selectClass} value={role.access} onChange={event => update({ access: event.target.value as RuntimeRoleDescriptor['access'] })}><option value="read">{t('customRoles.read')}</option><option value="write">{t('customRoles.write')}</option></select></label>
            <label className="space-y-1 text-xs">{t('customRoles.artifacts')}<select className={selectClass} value={role.artifacts} onChange={event => update({ artifacts: event.target.value as RuntimeRoleDescriptor['artifacts'] })}><option value="none">{t('customRoles.none')}</option><option value="tasks-checkboxes">{t('customRoles.tasks')}</option><option value="all">{t('customRoles.all')}</option></select></label>
          </div>
          <label className="block space-y-1 text-xs">{t('customRoles.skill')}<select className={selectClass} value={role.openspecSkill ?? ''} onChange={event => update({ openspecSkill: (event.target.value || undefined) as RuntimeRoleDescriptor['openspecSkill'] })}><option value="">{t('customRoles.noSkill')}</option>{['openspec-ff-change', 'openspec-apply-change', 'openspec-verify-change'].map(skill => <option key={skill} value={skill}>{skill}</option>)}</select></label>
          <label className="block space-y-1 text-xs">{t('customRoles.prompt')}<textarea className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={role.prompt ?? ''} rows={5} maxLength={20000} onChange={event => update({ prompt: event.target.value || undefined })} /></label>
        </fieldset>
      </fieldset>
    })}
    <fieldset disabled={!supported || !provider} className="flex items-end gap-2"><label className="min-w-0 flex-1 space-y-1 text-xs">{t('customRoles.id')}<Input value={id} maxLength={64} placeholder="security-reviewer" onChange={event => { setId(event.target.value); setError(false) }} /></label><Button variant="secondary" onClick={add}>{t('customRoles.add')}</Button></fieldset>
    {error && <p role="alert" className="text-xs text-destructive">{t('customRoles.invalidId')}</p>}
  </section>
}
