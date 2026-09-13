import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RUNTIME_ROLES, type RuntimeRole } from '../../lib/agent-runtime'
import { Button } from '../ui/button'

type Prompts = Record<RuntimeRole, string>
type Overrides = Partial<Prompts>
interface Catalog { defaults: Prompts; overrides: Overrides }

export function RuntimeRolePrompts() {
  const { t } = useTranslation('agentRuntime')
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [draft, setDraft] = useState<Overrides>({})
  const [role, setRole] = useState<RuntimeRole>('architect')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let cancelled = false
    setError('')
    fetch('/api/runtime-role-prompts').then(async response => {
      const data = await response.json()
      if (!response.ok || !RUNTIME_ROLES.every(role => typeof data.defaults?.[role] === 'string')) throw new Error(data.message ?? t('loadFailed'))
      if (!cancelled) { setCatalog(data); setDraft(data.overrides); setSaved(false) }
    }).catch(error => { if (!cancelled) setError(error.message) })
    return () => { cancelled = true }
  }, [t, reload])
  const effective = (overrides: Overrides, role: RuntimeRole) => overrides[role] ?? catalog!.defaults[role]
  const dirty = Boolean(catalog && RUNTIME_ROLES.some(role => draft[role] !== catalog.overrides[role]))
  const invalid = Boolean(catalog && RUNTIME_ROLES.some(role => { const text = effective(draft, role); return !text.trim() || text.length > 20000 || text.includes('\0') }))
  function edit(role: RuntimeRole, text: string) {
    setDraft(previous => { const next = { ...previous }; if (text === catalog!.defaults[role]) delete next[role]; else next[role] = text; return next })
    setSaved(false)
  }
  async function save() {
    setBusy(true); setError(''); setSaved(false)
    try {
      const response = await fetch('/api/runtime-role-prompts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ overrides: draft }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message ?? t('saveFailed'))
      setCatalog(data); setDraft(data.overrides); setSaved(true)
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  return <section className="space-y-4 border-t border-border pt-6" aria-label={t('prompts.title')}>
    <div><h2 className="text-base font-medium">{t('prompts.title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('prompts.description')}</p></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!catalog && (error ? <Button variant="secondary" onClick={() => setReload(n => n + 1)}>{t('retry')}</Button> : <p role="status">{t('loading')}</p>)}
    {catalog && <fieldset disabled={busy} className="min-w-0 space-y-3">
      <div>
        <div role="tablist" aria-label={t('prompts.title')} className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-muted p-1">
          {RUNTIME_ROLES.map((item, index) => <button type="button" role="tab" key={item} id={`role-tab-${item}`} aria-controls={`role-panel-${item}`} aria-selected={role === item} tabIndex={role === item ? 0 : -1} className={`rounded-md px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${role === item ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground'}`} onClick={() => setRole(item)} onKeyDown={event => {
            const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1
            if (next < 0) return
            event.preventDefault(); setRole(RUNTIME_ROLES[next]); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
          }}>{t(`roles.${item}`)}</button>)}
        </div>
        {RUNTIME_ROLES.filter(item => item === role).map(role => <div key={role} role="tabpanel" id={`role-panel-${role}`} aria-labelledby={`role-tab-${role}`} className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor={`role-prompt-${role}`} className="text-sm font-medium">{t('prompts.definition', { role: t(`roles.${role}`) })}</label>
            <span className="text-xs text-muted-foreground">{t(draft[role] === undefined ? 'prompts.default' : 'prompts.custom')}</span>
          </div>
          <textarea id={`role-prompt-${role}`} value={effective(draft, role)} onChange={event => edit(role, event.target.value)} rows={18} maxLength={20000} spellCheck={false} className="block max-h-[420px] min-h-64 w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{effective(draft, role).length.toLocaleString()} / 20,000</span><Button type="button" variant="ghost" size="sm" disabled={draft[role] === undefined} onClick={() => edit(role, catalog.defaults[role])}>{t('prompts.restore')}</Button></div>
        </div>)}
      </div>
      <p className="text-xs text-muted-foreground">{t('prompts.contracts')}</p>
      {invalid && <p role="alert" className="text-sm text-destructive">{t('prompts.invalid')}</p>}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {saved && <p role="status" className="text-sm text-accent-success">{t('prompts.saved')}</p>}
        {dirty && <span className="text-xs text-muted-foreground">{t('prompts.unsaved')}</span>}
        <Button type="button" variant="ghost" disabled={!dirty} onClick={() => { setDraft(catalog.overrides); setError(''); setSaved(false) }}>{t('prompts.discard')}</Button>
        <Button type="button" disabled={busy || !dirty || invalid} onClick={() => void save()}>{t(busy ? 'saving' : 'prompts.save')}</Button>
      </div>
    </fieldset>}
  </section>
}
