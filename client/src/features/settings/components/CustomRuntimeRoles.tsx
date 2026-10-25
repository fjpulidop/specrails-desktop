import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { CUSTOM_ROLE_ID, RUNTIME_ROLES, type RuntimeRoleDescriptor } from '../lib/agent-runtime'
import { SettingsSelect } from './SettingsSelect'

export function CustomRuntimeRoles({ roles = {}, provider, supported, onChange, renderEngine, visibleRoleIds, manageRoles = true }: {
  manageRoles?: boolean
  visibleRoleIds?: string[]
  roles?: Record<string, RuntimeRoleDescriptor>
  provider: string
  supported: boolean
  onChange(roles: Record<string, RuntimeRoleDescriptor>): void
  renderEngine(id: string): ReactNode
}) {
  const { t } = useTranslation('agentRuntime')
  const [id, setId] = useState(''), [error, setError] = useState(false)
  const custom = Object.entries(roles).filter(([key]) => !(RUNTIME_ROLES as readonly string[]).includes(key) && (!visibleRoleIds || visibleRoleIds.includes(key)))
  function add() {
    if (!CUSTOM_ROLE_ID.test(id) || id === 'fixer' || (RUNTIME_ROLES as readonly string[]).includes(id) || Object.prototype.hasOwnProperty.call(roles, id)) { setError(true); return }
    onChange({ ...roles, [id]: { provider, access: 'read', artifacts: 'none' } }); setId(''); setError(false)
  }
  return <section className="space-y-3" aria-labelledby="custom-runtime-roles">
    {manageRoles && <div><h3 id="custom-runtime-roles" className="text-sm font-medium">{t('customRoles.title')}</h3><p className="text-xs text-muted-foreground">{t('customRoles.hint')}</p></div>}
    {!supported && <p className="text-xs text-muted-foreground">{t('customRoles.unsupported')}</p>}
    {custom.map(([key, role]) => {
      const update = (value: Partial<RuntimeRoleDescriptor>) => onChange({ ...roles, [key]: { ...role, ...value } })
      return <fieldset key={key} className="space-y-3 rounded-lg border p-3" aria-label={key}>
        <legend className="px-1 font-mono text-sm">{key}</legend>
        {manageRoles && <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={() => { const next = { ...roles }; delete next[key]; onChange(next) }}>{t('customRoles.remove', { id: key })}</Button></div>}
        <fieldset disabled={!supported} className="space-y-3">
          {renderEngine(key)}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">{t('customRoles.access')}<SettingsSelect aria-label={t('customRoles.access')} value={role.access} onChange={value => update({ access: value as RuntimeRoleDescriptor['access'] })} options={[{ value: 'read', label: t('customRoles.read') }, { value: 'write', label: t('customRoles.write') }]} /></label>
            <label className="space-y-1 text-xs">{t('customRoles.artifacts')}<SettingsSelect aria-label={t('customRoles.artifacts')} value={role.artifacts} onChange={value => update({ artifacts: value as RuntimeRoleDescriptor['artifacts'] })} options={[{ value: 'none', label: t('customRoles.none') }, { value: 'tasks-checkboxes', label: t('customRoles.tasks') }, { value: 'all', label: t('customRoles.all') }]} /></label>
          </div>
          <label className="block space-y-1 text-xs">{t('customRoles.skill')}<SettingsSelect aria-label={t('customRoles.skill')} value={role.openspecSkill ?? ''} onChange={value => update({ openspecSkill: (value || undefined) as RuntimeRoleDescriptor['openspecSkill'] })} options={[{ value: '', label: t('customRoles.noSkill') }, ...['openspec-ff-change', 'openspec-apply-change', 'openspec-verify-change'].map(skill => ({ value: skill, label: skill }))]} /></label>
          <label className="block space-y-1 text-xs">{t('customRoles.prompt')}<textarea className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={role.prompt ?? ''} rows={5} maxLength={20000} onChange={event => update({ prompt: event.target.value || undefined })} /></label>
        </fieldset>
      </fieldset>
    })}
    {manageRoles && <fieldset disabled={!supported || !provider} className="flex items-end gap-2"><label className="min-w-0 flex-1 space-y-1 text-xs">{t('customRoles.id')}<Input value={id} maxLength={64} placeholder="security-reviewer" onChange={event => { setId(event.target.value); setError(false) }} /></label><Button variant="secondary" onClick={add}>{t('customRoles.add')}</Button></fieldset>}
    {error && <p role="alert" className="text-xs text-destructive">{t('customRoles.invalidId')}</p>}
  </section>
}
