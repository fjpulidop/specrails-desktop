import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FEATURE_CODE_EXPLORER } from '../../../lib/feature-flags'
import { LANGUAGE_IDS, LANGUAGES, type LanguageId } from '../../../lib/i18n'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select'
import { SettingsCard } from './SettingsCard'

import { notifyError } from '../../../lib/notify-error'
/**
 * Languages the Code explorer summariser accepts. Options come from the
 * shared 8-entry `LANGUAGES` registry so names stay in sync with the UI
 * language picker; the server allow-list (`/api/code-explorer-settings`)
 * currently accepts only these ids.
 */
const SUMMARY_LANGUAGE_IDS: readonly LanguageId[] = ['en', 'es']
const SUMMARY_LANGUAGES = LANGUAGE_IDS.filter((id) => SUMMARY_LANGUAGE_IDS.includes(id)).map((id) => LANGUAGES[id])

type SummaryLanguage = 'en' | 'es'

interface CodeExplorerSettings {
  language: SummaryLanguage
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
      notifyError(t('errors.saveFailed'), { detail: (err as Error).message })
      setSettings(settings)
    } finally {
      setSaving(false)
    }
  }

  if (!settings) {
    return <div role="status" aria-busy="true" aria-label={t('common:states.loading')} className="h-20 bg-muted/30 rounded-lg motion-safe:animate-pulse" />
  }

  return (
    <SettingsCard title={t('codeSection.heading')}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span id="code-summary-language-label" className="text-muted-foreground">{t('codeSection.summaryLanguage')}</span>
        <Select
          value={settings.language}
          disabled={saving}
          onValueChange={(value) => void patch({ language: value as SummaryLanguage })}
        >
          <SelectTrigger className="h-7 w-40" aria-labelledby="code-summary-language-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUMMARY_LANGUAGES.map((lang) => (
              <SelectItem key={lang.id} value={lang.id} className="text-xs">{lang.nativeName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
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
            if (!isNaN(v) && v >= 0) void patch({ monthlyBudgetUsd: v })
          }}
          className="bg-background border border-border rounded px-2 py-1 text-xs w-24 text-right"
        />
      </label>
      <p className="text-xs text-muted-foreground">
        {t('codeSection.budgetHelper')}
      </p>
    </SettingsCard>
  )
}
