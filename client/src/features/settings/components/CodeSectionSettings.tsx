import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { FEATURE_CODE_EXPLORER } from '../../../lib/feature-flags'

interface CodeExplorerSettings {
  language: 'en' | 'es'
  monthlyBudgetUsd: number
}

export function CodeSectionSettings() {
  if (!FEATURE_CODE_EXPLORER) return null

  const { t } = useTranslation('settings')
  const [settings, setSettings] = useState<CodeExplorerSettings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/code-explorer-settings')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => { if (!cancelled) setSettings(data as CodeExplorerSettings) })
      .catch(() => { if (!cancelled) setSettings({ language: 'en', monthlyBudgetUsd: 5.0 }) })
    return () => { cancelled = true }
  }, [])

  async function patch(next: Partial<CodeExplorerSettings>): Promise<void> {
    if (!settings) return
    const optimistic = { ...settings, ...next }
    setSettings(optimistic)
    setSaving(true)
    try {
      const res = await fetch('/api/code-explorer-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const updated = (await res.json()) as CodeExplorerSettings
      setSettings(updated)
    } catch (err) {
      toast.error(t('errors.saveFailed', { message: (err as Error).message }))
      setSettings(settings)
    } finally {
      setSaving(false)
    }
  }

  if (!settings) {
    return <div className="h-20 bg-muted/30 rounded-lg animate-pulse" />
  }

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {t('codeSection.heading')}
      </h3>
      <div className="rounded-md border border-border p-3 space-y-3">
        <label className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">{t('codeSection.summaryLanguage')}</span>
          <select
            value={settings.language}
            disabled={saving}
            onChange={(e) => patch({ language: e.target.value as 'en' | 'es' })}
            className="bg-background border border-border rounded px-2 py-1 text-xs"
          >
            <option value="en">English</option>
            <option value="es">Español</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">{t('codeSection.monthlyBudget')}</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={settings.monthlyBudgetUsd}
            disabled={saving}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              if (!isNaN(v) && v >= 0) patch({ monthlyBudgetUsd: v })
            }}
            className="bg-background border border-border rounded px-2 py-1 text-xs w-24 text-right"
          />
        </label>
        <p className="text-[10px] text-muted-foreground/70">
          {t('codeSection.budgetHelper')}
        </p>
      </div>
    </div>
  )
}
