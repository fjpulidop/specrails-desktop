import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation, Trans } from 'react-i18next'
import { getApiBase } from '../../lib/api'
import { useDesktop } from '../../hooks/useDesktop'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

// ─── Project settings sections ────────────────────────────────────────────────
// Self-contained cards (own fetch + save against the ACTIVE project's API base)
// shared by the /settings route page and the Agent-Mode ProjectSettingsDialog.
// Extracted verbatim from SettingsPage — same endpoints, toasts and copy.

interface ProjectSettingsPayload {
  pipelineTelemetryEnabled?: boolean
  prePrompt?: string
  ultraPrePrompt?: string
  integrationBranch?: string
}

/** Skeleton shown until a section's GET settles — fields never flash empty and
 *  a late response can never clobber what the user already typed. */
function SectionSkeleton() {
  return <div className="h-32 animate-pulse rounded-lg bg-muted/30" data-testid="section-skeleton" />
}

/** Pipeline telemetry opt-in toggle (Super mode only — enforced by callers). */
export function ProjectTelemetrySection() {
  const { t } = useTranslation('settings')
  const { activeProjectId } = useDesktop()
  const [telemetryEnabled, setTelemetryEnabled] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!activeProjectId) return
    let cancelled = false
    setLoaded(false)
    fetch(`${getApiBase()}/settings`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ProjectSettingsPayload | null) => {
        if (!cancelled && data) setTelemetryEnabled(data.pipelineTelemetryEnabled ?? false)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [activeProjectId])

  if (!loaded) return <SectionSkeleton />

  async function saveToggle(enabled: boolean) {
    setIsSaving(true)
    const prev = telemetryEnabled
    setTelemetryEnabled(enabled)
    try {
      const res = await fetch(`${getApiBase()}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipelineTelemetryEnabled: enabled }),
      })
      if (!res.ok) throw new Error('Failed to save')
      toast.success(enabled ? t('telemetry.enabled') : t('telemetry.disabled'))
    } catch (err) {
      setTelemetryEnabled(prev)
      toast.error(t('telemetry.saveFailed'), { description: (err as Error).message })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('telemetry.title')}</CardTitle>
        <CardDescription>{t('telemetry.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <p className="text-xs font-medium">{t('telemetry.toggleLabel')}</p>
            <p className="text-[10px] text-muted-foreground">
              <Trans
                ns="settings"
                i18nKey="telemetry.toggleDescription"
                components={{ mono: <span className="font-mono" /> }}
              />
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label={t('telemetry.toggleLabel')}
            aria-checked={telemetryEnabled}
            disabled={isSaving}
            onClick={() => saveToggle(!telemetryEnabled)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 ${
              telemetryEnabled ? 'bg-primary' : 'bg-input'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-background shadow-sm transition-transform ${
                telemetryEnabled ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </CardContent>
    </Card>
  )
}

/** Designated integration branch: the base parallel rails branch from and target
 *  their draft PRs at. Empty = auto-resolve to the repo default. Shows the
 *  resolved base so it is a certainty, not an implicit surprise. */
export function ProjectIntegrationBranchSection() {
  const { t } = useTranslation('settings')
  const { activeProjectId } = useDesktop()
  const [configured, setConfigured] = useState('')
  const [resolved, setResolved] = useState<{ branch: string; source: string } | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  async function reload(cancelledRef?: { current: boolean }) {
    const r = await fetch(`${getApiBase()}/integration-branch`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null) as { configured?: string; branch?: string; source?: string } | null
    if (cancelledRef?.current) return
    if (r) {
      setConfigured(r.configured ?? '')
      if (r.branch) setResolved({ branch: r.branch, source: r.source ?? '' })
    }
  }

  useEffect(() => {
    if (!activeProjectId) return
    const cancelled = { current: false }
    setLoaded(false)
    reload(cancelled).finally(() => { if (!cancelled.current) setLoaded(true) })
    return () => { cancelled.current = true }
  }, [activeProjectId])

  if (!loaded) return <SectionSkeleton />

  async function save() {
    setIsSaving(true)
    try {
      const res = await fetch(`${getApiBase()}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrationBranch: configured.trim() }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }))
        throw new Error(body.error || 'Failed to save')
      }
      toast.success(t('integrationBranch.saved'))
      await reload()
    } catch (err) {
      toast.error(t('integrationBranch.saveFailed'), { description: (err as Error).message })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('integrationBranch.title')}</CardTitle>
        <CardDescription>{t('integrationBranch.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          value={configured}
          onChange={(e) => setConfigured(e.target.value)}
          placeholder={t('integrationBranch.placeholder')}
          data-testid="integration-branch-input"
        />
        {resolved && (
          <p className="text-[10px] text-muted-foreground" data-testid="integration-branch-resolved">
            <Trans
              ns="settings"
              i18nKey="integrationBranch.resolved"
              values={{ branch: resolved.branch }}
              components={{ mono: <span className="font-mono" /> }}
            />
          </p>
        )}
        <Button size="sm" onClick={save} disabled={isSaving} data-testid="integration-branch-save">
          {t('integrationBranch.save')}
        </Button>
      </CardContent>
    </Card>
  )
}

/** One pre-prompt editor card (shared shape for the normal + Freestyle prompt). */
function PrePromptCard({
  value,
  onChange,
  onSave,
  isSaving,
  fieldId,
  i18nRoot,
}: {
  value: string
  onChange: (v: string) => void
  onSave: () => void
  isSaving: boolean
  fieldId: string
  i18nRoot: 'prePrompt' | 'ultraPrePrompt'
}) {
  const { t } = useTranslation('settings')
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(`${i18nRoot}.title`)}</CardTitle>
        <CardDescription>{t(`${i18nRoot}.description`)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <label htmlFor={fieldId} className="text-xs font-medium">
            {t(`${i18nRoot}.label`)}
          </label>
          <textarea
            id={fieldId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t(`${i18nRoot}.placeholder`)}
            className="min-h-32 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
          />
          <p className="text-xs text-muted-foreground">{t(`${i18nRoot}.helper`)}</p>
        </div>
        <div className="flex justify-end">
          <Button size="sm" variant="secondary" className="h-7 text-xs" disabled={isSaving} onClick={onSave}>
            {isSaving ? t('common:states.saving') : t(`${i18nRoot}.saveButton`)}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** Pre-prompt + Freestyle pre-prompt cards (loads both from GET /settings). */
export function ProjectPrePromptsSection() {
  const { t } = useTranslation('settings')
  const { activeProjectId } = useDesktop()
  const [prePrompt, setPrePrompt] = useState('')
  const [isSavingPrePrompt, setIsSavingPrePrompt] = useState(false)
  const [ultraPrePrompt, setUltraPrePrompt] = useState('')
  const [isSavingUltraPrePrompt, setIsSavingUltraPrePrompt] = useState(false)
  const [loaded, setLoaded] = useState(false)
  // A late-landing GET must never clobber a field the user already edited.
  const touchedRef = useRef({ pre: false, ultra: false })

  useEffect(() => {
    if (!activeProjectId) return
    let cancelled = false
    setLoaded(false)
    touchedRef.current = { pre: false, ultra: false }
    fetch(`${getApiBase()}/settings`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ProjectSettingsPayload | null) => {
        if (cancelled || !data) return
        if (!touchedRef.current.pre) setPrePrompt(data.prePrompt ?? '')
        if (!touchedRef.current.ultra) setUltraPrePrompt(data.ultraPrePrompt ?? '')
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [activeProjectId])

  async function savePrePrompt() {
    setIsSavingPrePrompt(true)
    try {
      const res = await fetch(`${getApiBase()}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prePrompt }),
      })
      if (!res.ok) throw new Error('Failed to save')
      const data = await res.json() as { settings?: ProjectSettingsPayload }
      const savedValue = data.settings?.prePrompt ?? ''
      setPrePrompt(savedValue)
      toast.success(savedValue.trim() === '' ? t('prePrompt.cleared') : t('prePrompt.saved'))
    } catch (err) {
      toast.error(t('prePrompt.saveFailed'), { description: (err as Error).message })
    } finally {
      setIsSavingPrePrompt(false)
    }
  }

  async function saveUltraPrePrompt() {
    setIsSavingUltraPrePrompt(true)
    try {
      const res = await fetch(`${getApiBase()}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ultraPrePrompt }),
      })
      if (!res.ok) throw new Error('Failed to save')
      const data = await res.json() as { settings?: ProjectSettingsPayload }
      const savedValue = data.settings?.ultraPrePrompt ?? ''
      setUltraPrePrompt(savedValue)
      toast.success(savedValue.trim() === '' ? t('ultraPrePrompt.resetToDefault') : t('ultraPrePrompt.saved'))
    } catch (err) {
      toast.error(t('ultraPrePrompt.saveFailed'), { description: (err as Error).message })
    } finally {
      setIsSavingUltraPrePrompt(false)
    }
  }

  if (!loaded) return <SectionSkeleton />

  return (
    <>
      <PrePromptCard
        value={prePrompt}
        onChange={(v) => { touchedRef.current.pre = true; setPrePrompt(v) }}
        onSave={savePrePrompt}
        isSaving={isSavingPrePrompt}
        fieldId="project-pre-prompt"
        i18nRoot="prePrompt"
      />
      <PrePromptCard
        value={ultraPrePrompt}
        onChange={(v) => { touchedRef.current.ultra = true; setUltraPrePrompt(v) }}
        onSave={saveUltraPrePrompt}
        isSaving={isSavingUltraPrePrompt}
        fieldId="project-ultra-pre-prompt"
        i18nRoot="ultraPrePrompt"
      />
    </>
  )
}

/** Daily budget + per-job cost alert card (GET/PATCH /budget). */
export function ProjectBudgetSection() {
  const { t } = useTranslation('settings')
  const { activeProjectId } = useDesktop()
  const [dailyBudget, setDailyBudget] = useState('')
  const [isSavingBudget, setIsSavingBudget] = useState(false)
  const [jobCostThreshold, setJobCostThreshold] = useState('')
  const [isSavingJobThreshold, setIsSavingJobThreshold] = useState(false)
  const [loaded, setLoaded] = useState(false)
  // A late-landing GET must never clobber a field the user already edited.
  const touchedRef = useRef({ daily: false, perJob: false })

  useEffect(() => {
    if (!activeProjectId) return
    let cancelled = false
    setLoaded(false)
    touchedRef.current = { daily: false, perJob: false }
    fetch(`${getApiBase()}/budget`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { dailyBudgetUsd?: number | null; jobCostThresholdUsd?: number | null } | null) => {
        if (cancelled || !data) return
        if (!touchedRef.current.daily) setDailyBudget(data.dailyBudgetUsd != null ? String(data.dailyBudgetUsd) : '')
        if (!touchedRef.current.perJob) setJobCostThreshold(data.jobCostThresholdUsd != null ? String(data.jobCostThresholdUsd) : '')
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [activeProjectId])

  async function savePatch(body: Record<string, number | null>, okMsg: string, failKey: string, setSaving: (v: boolean) => void) {
    setSaving(true)
    try {
      const res = await fetch(`${getApiBase()}/budget`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error('Failed to save')
      toast.success(okMsg)
    } catch (err) {
      toast.error(t(failKey), { description: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  function parseAmount(raw: string): number | null | undefined {
    const parsed = raw.trim() === '' ? null : parseFloat(raw)
    if (parsed !== null && (isNaN(parsed) || parsed <= 0)) {
      toast.error(t('budget.invalidNumber'))
      return undefined
    }
    return parsed
  }

  function saveDailyBudget() {
    const parsed = parseAmount(dailyBudget)
    if (parsed === undefined) return
    void savePatch(
      { dailyBudgetUsd: parsed },
      parsed == null ? t('budget.dailyRemoved') : t('budget.dailySet', { amount: parsed }),
      'budget.saveBudgetFailed',
      setIsSavingBudget,
    )
  }

  function saveJobCostThreshold() {
    const parsed = parseAmount(jobCostThreshold)
    if (parsed === undefined) return
    void savePatch(
      { jobCostThresholdUsd: parsed },
      parsed == null ? t('budget.perJobAlertDisabled') : t('budget.alertSet', { amount: parsed }),
      'budget.saveThresholdFailed',
      setIsSavingJobThreshold,
    )
  }

  if (!loaded) return <SectionSkeleton />

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('budget.title')}</CardTitle>
        <CardDescription>{t('budget.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-2">
            <div>
              <label className="text-xs font-medium">{t('budget.dailyLabel')}</label>
              <p className="text-xs text-muted-foreground">{t('budget.dailyHelper')}</p>
            </div>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={dailyBudget}
              onChange={(e) => { touchedRef.current.daily = true; setDailyBudget(e.target.value) }}
              placeholder={t('budget.dailyPlaceholder')}
              className="h-8 text-xs font-mono"
            />
            <div className="flex justify-end">
              <Button size="sm" variant="secondary" className="h-7 text-xs" disabled={isSavingBudget} onClick={saveDailyBudget}>
                {isSavingBudget ? t('common:states.saving') : t('common:actions.save')}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <label className="text-xs font-medium">{t('budget.perJobLabel')}</label>
              <p className="text-xs text-muted-foreground">{t('budget.perJobHelper')}</p>
            </div>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={jobCostThreshold}
              onChange={(e) => { touchedRef.current.perJob = true; setJobCostThreshold(e.target.value) }}
              placeholder={t('budget.perJobPlaceholder')}
              className="h-8 text-xs font-mono"
            />
            <div className="flex justify-end">
              <Button size="sm" variant="secondary" className="h-7 text-xs" disabled={isSavingJobThreshold} onClick={saveJobCostThreshold}>
                {isSavingJobThreshold ? t('common:states.saving') : t('common:actions.save')}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
