import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { repositoryApiBase } from '../../projects/lib/project-repositories'
import { modelsForProvider } from '../../loops/lib/loop-run-models'
import { isLocalEngineId, providerLabel } from '../../providers/lib/provider-capabilities'
import { useProviderDetection } from '../../providers/hooks/useProviderDetection'
import { Input } from '../../../components/ui/input'
import { ProviderTabs } from './ProviderTabs'
import { SettingsSelect } from './SettingsSelect'

import { notifyError } from '../../../lib/notify-error'
/**
 * Spec triage engine (launch-triage): the `triage` entry of the project's
 * loop-role engines (`GET/PUT /agent-runtime/loop-roles`). Absent ⇒ the
 * primary provider and its cheapest priced model. Triage is one structured
 * call per spec and takes no reasoning effort, so only provider and model
 * show. The file also holds the legacy `verifier` / `decider` roles (now
 * edited per loop): every save sends them back untouched, because the PUT
 * replaces the whole file.
 */
export interface RoleEngine { provider: string; model?: string; effort?: string }
type StoredRoles = Record<string, RoleEngine>


function readRoles(data: unknown): StoredRoles {
  const roles = (data as { roles?: unknown } | null)?.roles
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return {}
  const out: StoredRoles = {}
  for (const [role, entry] of Object.entries(roles as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || typeof (entry as RoleEngine).provider !== 'string') continue
    const { provider, model, effort } = entry as RoleEngine
    out[role] = { provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
  }
  return out
}

/** Loads the project's loop roles; `setTriage` saves optimistically and reverts with a toast on refusal. */
export function useTriageEngine(projectId: string): { engine: RoleEngine | null | undefined; failed: boolean; saving: boolean; setTriage: (engine: RoleEngine | null) => void } {
  const { t } = useTranslation('agentRuntime')
  const [roles, setRoles] = useState<StoredRoles | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const current = useRef<StoredRoles>({})
  const endpoint = `${repositoryApiBase(projectId)}/agent-runtime/loop-roles`

  useEffect(() => {
    let cancelled = false
    setRoles(null); setFailed(false)
    fetch(endpoint, { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('loop_roles')
      const next = readRoles(await response.json())
      if (cancelled) return
      current.current = next
      setRoles(next)
    }).catch(() => { if (!cancelled) { setRoles({}); setFailed(true) } })
    return () => { cancelled = true }
  }, [endpoint])

  async function save(next: StoredRoles) {
    const previous = current.current
    current.current = next
    setRoles(next); setSaving(true)
    try {
      const response = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roles: next }) })
      const data = await response.json().catch(() => null) as { roles?: unknown; message?: string } | null
      if (!response.ok) throw new Error(data?.message ?? t('triageEngine.saveFailed'))
      const confirmed = readRoles(data)
      current.current = confirmed
      setRoles(confirmed)
    } catch (err) {
      current.current = previous
      setRoles(previous)
      notifyError(t('triageEngine.saveFailed'), { detail: err instanceof Error ? err.message : undefined })
    } finally { setSaving(false) }
  }

  const setTriage = (engine: RoleEngine | null) => {
    const next: StoredRoles = { ...current.current }
    if (engine) next.triage = engine; else delete next.triage
    void save(next)
  }
  // undefined = loading; null = inherit (no triage role stored).
  return { engine: roles === null ? undefined : roles.triage ?? null, failed, saving, setTriage }
}

/** The triage engine block (project settings ▸ Agent runtime). */
export function TriageEngineSection({ projectId, providers }: { projectId: string; providers: readonly string[] }) {
  const { t } = useTranslation('agentRuntime')
  const detection = useProviderDetection()
  const { engine, failed, saving, setTriage } = useTriageEngine(projectId)
  const provider = engine?.provider
  const local = isLocalEngineId(provider)
  const catalog = provider ? modelsForProvider(provider) : []
  const unknownModel = engine?.model && !catalog.some((model) => model.value === engine.model) ? engine.model : null
  const localModels = (id: string): string[] => {
    const detected = detection.providers[id]?.models
    return detected && detected.length ? detected : modelsForProvider(id).map((model) => model.value)
  }
  return <section className="space-y-3 border-t pt-4" aria-labelledby="runtime-triage-engine-title" aria-busy={saving} data-testid="triage-engine-section">
    <h3 id="runtime-triage-engine-title" className="text-sm font-medium">{t('triageEngine.title')}</h3>
    <p className="text-xs text-muted-foreground">{t('triageEngine.hint')}</p>
    {failed && <p role="alert" className="text-xs text-destructive">{t('triageEngine.loadFailed')}</p>}
    {engine === undefined && !failed && <p role="status" className="text-xs text-muted-foreground">{t('triageEngine.loading')}</p>}
    {engine !== undefined && <div className="grid gap-3 sm:grid-cols-2">
      <fieldset className="space-y-2 sm:col-span-2"><legend className="text-xs">{t('agents.provider')}</legend>
        <ProviderTabs
          name="triage-engine-provider"
          value={provider ?? ''}
          ariaLabel={t('triageEngine.provider')}
          disabled={saving}
          tabs={[{ value: '', label: t('triageEngine.inherit') }, ...providers.map((id) => ({ value: id, label: providerLabel(id), detail: id, local: isLocalEngineId(id) }))]}
          onChange={(id) => setTriage(id ? { provider: id } : null)}
        />
      </fieldset>
      {provider && !local && <label className="space-y-1 text-xs">{t('triageEngine.model')}
        <SettingsSelect
          aria-label={t('triageEngine.model')}
          disabled={saving}
          value={engine?.model ?? ''}
          onChange={(value) => setTriage({ provider, ...(value ? { model: value } : {}) })}
          options={[
            { value: '', label: t('triageEngine.cheapestModel') },
            ...catalog.map((model) => ({ value: model.value, label: model.label })),
            ...(unknownModel ? [{ value: unknownModel, label: unknownModel }] : []),
          ]}
        />
      </label>}
      {provider && local && <label className="space-y-1 text-xs">{t('triageEngine.model')}
        <Input key={`${provider}:${engine?.model ?? ''}`} defaultValue={engine?.model ?? ''} disabled={saving} list={`triage-engine-models-${provider}`} placeholder={t('agents.modelPlaceholder')}
          onBlur={(event) => { const model = event.target.value.trim(); if ((engine?.model ?? '') !== model) setTriage({ provider, ...(model ? { model } : {}) }) }} />
        <datalist id={`triage-engine-models-${provider}`}>{localModels(provider).map((model) => <option key={model} value={model} />)}</datalist>
      </label>}
    </div>}
  </section>
}
