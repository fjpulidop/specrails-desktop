import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Layers } from 'lucide-react'
import { repositoryApiBase } from '../../lib/project-repositories'
import { defaultModelForProvider, modelsForProvider } from '../../lib/loop-run-models'
import { isLocalEngineId, providerLabel, providerSupportsReasoningEffort, reasoningEffortsForProvider } from '../../lib/provider-capabilities'
import { ProviderTabs } from './ProviderTabs'
import { useProviderDetection } from '../../hooks/useProviderDetection'
import { Input } from '../ui/input'

/** Loop-side roles a `roles` rail launch resolves per project (hybrid-role-engines). */
export const LOOP_ROLES = ['verifier', 'decider'] as const
export type LoopRole = (typeof LOOP_ROLES)[number]
export interface LoopRoleEngine { provider: string; model?: string; effort?: string }
export type LoopRoleEngines = Partial<Record<LoopRole, LoopRoleEngine>>

const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm'

function readRoles(data: unknown): LoopRoleEngines {
  const roles = (data as { roles?: unknown } | null)?.roles
  if (!roles || typeof roles !== 'object') return {}
  const out: LoopRoleEngines = {}
  for (const role of LOOP_ROLES) {
    const entry = (roles as Record<string, unknown>)[role]
    if (entry && typeof entry === 'object' && typeof (entry as LoopRoleEngine).provider === 'string') {
      const { provider, model, effort } = entry as LoopRoleEngine
      out[role] = { provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
    }
  }
  return out
}

/**
 * Loads the loop roles per project; every change PUTs optimistically and
 * reverts with a toast when the server refuses. `roles === null` = loading.
 */
export function useLoopRoles(projectId: string): { roles: LoopRoleEngines | null; failed: boolean; setRole: (role: LoopRole, engine: LoopRoleEngine | null) => void } {
  const { t } = useTranslation('agentRuntime')
  const [roles, setRoles] = useState<LoopRoleEngines | null>(null)
  const [failed, setFailed] = useState(false)
  const current = useRef<LoopRoleEngines>({})
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

  async function save(next: LoopRoleEngines) {
    const previous = current.current
    current.current = next
    setRoles(next)
    try {
      const response = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roles: next }) })
      const data = await response.json().catch(() => null) as { roles?: unknown; message?: string } | null
      if (!response.ok) throw new Error(data?.message ?? t('loopRoles.saveFailed'))
      const confirmed = readRoles(data)
      current.current = confirmed
      setRoles(confirmed)
    } catch (err) {
      current.current = previous
      setRoles(previous)
      toast.error(err instanceof Error && err.message ? err.message : t('loopRoles.saveFailed'))
    }
  }

  const setRole = (role: LoopRole, engine: LoopRoleEngine | null) => {
    const next: LoopRoleEngines = { ...current.current }
    if (engine) next[role] = engine; else delete next[role]
    void save(next)
  }
  return { roles, failed, setRole }
}

/** Effective model a loop role runs (explicit, else the provider default), for chips. */
export function loopRoleEffectiveModel(engine: LoopRoleEngine | undefined): string | null {
  if (!engine) return null
  return engine.model || defaultModelForProvider(engine.provider) || null
}

/**
 * One loop role's engine fields (provider tabs incl. "Inherit primary", model,
 * effort). Stateless — the parent owns the roles via `useLoopRoles`.
 */
export function LoopRoleFields({ role, engine, providers, enabled, onChange }: {
  role: LoopRole
  engine: LoopRoleEngine | undefined
  providers: readonly string[]
  enabled: boolean
  onChange: (engine: LoopRoleEngine | null) => void
}) {
  const { t } = useTranslation('agentRuntime')
  const detection = useProviderDetection()
  /** Models a local engine discovered, else the dynamic catalog. */
  const localModels = (provider: string): string[] => {
    const detected = detection.providers[provider]?.models
    return detected && detected.length ? detected : modelsForProvider(provider).map((model) => model.value)
  }
  const provider = engine?.provider
  const local = isLocalEngineId(provider)
  const catalog = provider ? modelsForProvider(provider) : []
  const fallback = provider ? defaultModelForProvider(provider) : ''
  const unknownModel = engine?.model && !catalog.some((model) => model.value === engine.model) ? engine.model : null
  const effectiveModel = engine?.model || fallback || null
  const efforts = provider ? reasoningEffortsForProvider(provider, effectiveModel) : []
  const showEffort = !!provider && providerSupportsReasoningEffort(provider, effectiveModel)
  return <div className="grid gap-3 sm:grid-cols-2">
    <fieldset className="space-y-2 sm:col-span-2"><legend className="text-xs">{t('agents.provider')}</legend>
      <ProviderTabs
        name={`loop-role-${role}-provider`}
        value={provider ?? ''}
        ariaLabel={t('agents.provider')}
        disabled={!enabled}
        tabs={[{ value: '', label: t('loopRoles.inherit') }, ...providers.map((id) => ({ value: id, label: providerLabel(id), detail: id, local: isLocalEngineId(id) }))]}
        onChange={(id) => (id ? onChange({ provider: id }) : onChange(null))}
      />
    </fieldset>
    {provider && !local && <label className="space-y-1 text-xs">{t('loopRoles.model')}
      <select className={selectClass} value={engine?.model ?? ''} onChange={(event) => onChange({ provider, ...(event.target.value ? { model: event.target.value } : {}) })}>
        <option value="">{t('agents.defaultModel', { model: catalog.find((model) => model.value === fallback)?.label ?? fallback })}</option>
        {catalog.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
        {unknownModel && <option value={unknownModel}>{unknownModel}</option>}
      </select>
    </label>}
    {provider && local && <label className="space-y-1 text-xs">{t('loopRoles.model')}
      <Input defaultValue={engine?.model ?? ''} list={`loop-role-${role}-models-${provider}`} placeholder={t('agents.modelPlaceholder')}
        onBlur={(event) => { const model = event.target.value.trim(); if ((engine?.model ?? '') !== model) onChange({ provider, ...(model ? { model } : {}) }) }} />
      <datalist id={`loop-role-${role}-models-${provider}`}>{localModels(provider).map((model) => <option key={model} value={model} />)}</datalist>
    </label>}
    {showEffort && <label className="space-y-1 text-xs">{t('loopRoles.effort')}
      <select className={selectClass} value={engine?.effort ?? ''} onChange={(event) => onChange({ provider, ...(engine?.model ? { model: engine.model } : {}), ...(event.target.value ? { effort: event.target.value } : {}) })}>
        <option value="">{t('agents.defaultModel', { model: '—' })}</option>
        {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
      </select>
    </label>}
  </div>
}

/**
 * "Loop roles" block: which engine runs the loop's verifier (every non-core
 * AI step — verify / fix / custom ai-steps) and the Loop Decider when a rail
 * launches with the `roles` engine. Absent role = the project's primary.
 * Standalone block (both roles at once); the pipeline stepper in
 * AgentRuntimeSettingsSection composes `useLoopRoles` + `LoopRoleFields` itself.
 */
export function LoopRolesSection({ projectId, providers, enabled }: {
  projectId: string
  /** Project provider ids the roles may name (primary first). */
  providers: readonly string[]
  /** Runtime config enabled — `roles` launches are refused when it is off. */
  enabled: boolean
}) {
  const { t } = useTranslation('agentRuntime')
  const { roles, failed, setRole } = useLoopRoles(projectId)

  return <section className="space-y-3" aria-labelledby="agent-runtime-loop-roles" data-testid="loop-roles-section">
    <h3 id="agent-runtime-loop-roles" className="flex items-center gap-2 text-sm font-medium"><Layers className="w-4 h-4 text-accent-primary" />{t('loopRoles.title')}</h3>
    <p className="text-xs text-muted-foreground">{t('loopRoles.hint')}</p>
    {!enabled && <p role="status" className="rounded-md border border-accent-warning/40 p-3 text-xs text-accent-warning">{t('loopRoles.disabled')}</p>}
    {failed && <p role="alert" className="text-xs text-destructive">{t('loadFailed')}</p>}
    {roles === null && !failed && <p role="status" className="text-xs text-muted-foreground">{t('loading')}</p>}
    {roles && <fieldset disabled={!enabled} className="space-y-3 disabled:opacity-60">
      {LOOP_ROLES.map((role) => <fieldset key={role} className="rounded-lg border border-border p-3"><legend className="px-1 text-xs font-medium">{t(`loopRoles.${role}`)}</legend>
        <p className="mb-2 text-xs text-muted-foreground">{t(`loopRoles.${role}Hint`)}</p>
        <LoopRoleFields role={role} engine={roles[role]} providers={providers} enabled={enabled} onChange={(engine) => setRole(role, engine)} />
      </fieldset>)}
    </fieldset>}
  </section>
}
