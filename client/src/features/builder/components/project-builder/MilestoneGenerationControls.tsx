import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Gauge, Sparkles } from 'lucide-react'
import { getApiBase } from '../../../../lib/api'
import { AgentToolbarSelector } from '../../../missions/components/AgentToolbarSelector'
import { AgentModelSelector } from '../../../missions/components/AgentModelSelector'

export interface MilestoneGenerationSelection {
  provider: string
  model: string
  reasoningEffort: string | null
}

export interface CatalogEntry {
  provider: string
  models: Array<{ value: string; label: string }>
  defaultModel: string
  effortsByModel: Record<string, string[]>
}

export interface Settings {
  selection: MilestoneGenerationSelection | null
  providers: CatalogEntry[]
}

export function isMilestoneSelectionAvailable(selection: MilestoneGenerationSelection | null, catalog: CatalogEntry[]): selection is MilestoneGenerationSelection {
  if (!selection) return false
  const entry = catalog.find((item) => item.provider === selection.provider)
  return !!entry?.models.some((model) => model.value === selection.model)
    && (selection.reasoningEffort === null || !!entry.effortsByModel[selection.model]?.includes(selection.reasoningEffort))
}

export function SelectionControls({ value, catalog, onChange, disabled, prefix }: {
  value: MilestoneGenerationSelection
  catalog: CatalogEntry[]
  onChange: (value: MilestoneGenerationSelection) => void
  disabled: boolean
  prefix: string
}) {
  const { t } = useTranslation('agent')
  const { t: tBuilder } = useTranslation('builder')
  const entry = catalog.find((item) => item.provider === value.provider)
  const efforts = entry?.effortsByModel[value.model] ?? []
  return (
    <div className="flex flex-wrap items-center gap-1 [&>button]:text-label">
      <AgentToolbarSelector label={t('provider.label')} value={value.provider} icon={Bot}
        options={catalog.map((item) => ({ value: item.provider, label: t(`provider.${item.provider}`, { defaultValue: item.provider }) }))}
        onSelect={(provider) => {
          const next = catalog.find((item) => item.provider === provider)!
          onChange({ provider, model: next.defaultModel, reasoningEffort: null })
        }} disabled={disabled} testId={`${prefix}-provider`} />
      <AgentModelSelector models={entry?.models ?? []} model={value.model}
        onSelect={(model) => onChange({ ...value, model, reasoningEffort: null })}
        disabled={disabled} testId={`${prefix}-model`} />
      {efforts.length > 0 && (
        <AgentToolbarSelector label={t('effort.label')} value={value.reasoningEffort ?? 'default'} icon={Gauge}
          options={[{ value: 'default', label: tBuilder('generation.defaultEffort') }, ...efforts.map((effort) => ({ value: effort, label: t(`effort.${effort}`) }))]}
          onSelect={(effort) => onChange({ ...value, reasoningEffort: effort === 'default' ? null : effort })}
          disabled={disabled} testId={`${prefix}-effort`} />
      )}
    </div>
  )
}

/** Mounted per project/panel opening; exceptions never write the preference. */
export function MilestoneGenerationControls({ projectId, milestoneN, onGenerate }: {
  projectId: string
  milestoneN: number
  onGenerate: (selection: MilestoneGenerationSelection) => void
}) {
  const { t } = useTranslation('builder')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [habitual, setHabitual] = useState<MilestoneGenerationSelection | null>(null)
  const [override, setOverride] = useState<MilestoneGenerationSelection | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    fetch(`${getApiBase()}/blueprint/generation-settings`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('settings unavailable')
        return response.json() as Promise<Settings>
      })
      .then((data) => {
        if (controller.signal.aborted) return
        setSettings(data)
        setHabitual(data.selection)
      })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => { alive.current = false; controller.abort() }
  }, [projectId])

  const save = async () => {
    if (!habitual || saving) return
    setSaving(true)
    setError(false)
    try {
      const response = await fetch(`${getApiBase()}/blueprint/generation-settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(habitual),
      })
      if (!response.ok) throw new Error('save failed')
      const data = await response.json() as Settings
      if (alive.current) { setSettings(data); setHabitual(data.selection) }
    } catch { if (alive.current) setError(true) }
    finally { if (alive.current) setSaving(false) }
  }

  const catalog = settings?.providers ?? []
  const changed = JSON.stringify(habitual) !== JSON.stringify(settings?.selection ?? null)
  const selected = override ?? settings?.selection ?? null
  const available = isMilestoneSelectionAvailable(selected, catalog)
  return (
    <div className="mt-3 space-y-2 border-t border-border/40 pt-3" data-testid="milestone-generation-controls">
      <p className="text-xs font-medium">{t('generation.habitual')}</p>
      {habitual && <SelectionControls value={habitual} catalog={catalog} onChange={setHabitual} disabled={saving} prefix="milestone-default" />}
      {changed && (
        <button type="button" onClick={() => { void save() }} disabled={saving || !isMilestoneSelectionAvailable(habitual, catalog)}
          className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50" data-testid="milestone-save-default">
          {t(saving ? 'generation.saving' : 'generation.save')}
        </button>
      )}
      {settings?.selection && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={override !== null} disabled={saving}
            onChange={(event) => setOverride(event.target.checked ? { ...settings.selection! } : null)} />
          {t('generation.override', { n: milestoneN })}
        </label>
      )}
      {override && <SelectionControls value={override} catalog={catalog} onChange={setOverride} disabled={saving} prefix="milestone-override" />}
      {error && <p role="alert" className="text-xs text-destructive">{t('generation.failed')}</p>}
      {settings && !available && (
        <div className="space-y-1">
          <p role="status" className="text-xs text-accent-warning">{t('generation.unavailable')}</p>
          {catalog.length > 0 && (
            <button type="button" disabled={saving} className="rounded-md border border-border px-2 py-1 text-xs"
              onClick={() => {
                const entry = catalog.find((item) => item.provider === habitual?.provider) ?? catalog[0]
                setHabitual({ provider: entry.provider, model: entry.defaultModel, reasoningEffort: null })
                setOverride(null)
              }}>{t('generation.reset')}</button>
          )}
        </div>
      )}
      <button type="button" onClick={() => { if (available && selected) onGenerate({ ...selected }) }}
        disabled={!available || saving || changed}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-accent-primary/40 bg-accent-primary/10 px-2 py-1.5 text-caption font-medium text-accent-primary hover:bg-accent-primary/20 disabled:opacity-50"
        data-testid="sidebar-generate-next">
        <Sparkles className="h-3 w-3" aria-hidden />{t('sidebar.generateNext', { n: milestoneN })}
      </button>
    </div>
  )
}
