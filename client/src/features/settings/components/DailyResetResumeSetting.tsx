import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { API_ORIGIN } from '../../../lib/origin'
import { notifyError } from '../../../lib/notify-error'
import { Switch } from '../../../components/ui/switch'

/**
 * "Resume runs held by the daily budget when the day resets" (app-wide, on by
 * default, `PUT /api/settings { resumeOnDailyReset }`). At the budget's own daily
 * reset a run only the daily budget held continues by itself through capacity
 * admission; a run the person paused, or one a per-run/weekly/monthly cap still
 * holds, keeps waiting.
 */
export function DailyResetResumeSetting() {
  const { t } = useTranslation('settings')
  const [enabled, setEnabledState] = useState(true)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(`${API_ORIGIN}/api/settings`)
      .then((res) => (res.ok ? res.json() as Promise<{ resumeOnDailyReset?: boolean }> : null))
      .then((data) => { if (!cancelled && data) setEnabledState(data.resumeOnDailyReset !== false) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  async function setEnabled(next: boolean) {
    setSaving(true)
    setEnabledState(next)
    try {
      const res = await fetch(`${API_ORIGIN}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resumeOnDailyReset: next }) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success(next ? t('budget.resumeOnDailyReset.enabled') : t('budget.resumeOnDailyReset.disabled'))
    } catch (err) {
      setEnabledState(!next)
      notifyError(t('budget.resumeOnDailyReset.saveFailed'), { detail: (err as Error).message, retry: () => void setEnabled(next) })
    } finally {
      setSaving(false)
    }
  }
  const label = t('budget.resumeOnDailyReset.label')
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border pt-3" data-setting-id="resumeOnDailyReset" data-testid="settings-resume-on-daily-reset">
      <div className="space-y-0.5">
        <p className="text-label">{label}</p>
        <p className="text-xs text-muted-foreground">{t('budget.resumeOnDailyReset.helper')}</p>
      </div>
      <Switch checked={enabled} onCheckedChange={(next) => void setEnabled(next)} aria-label={label} disabled={saving} />
    </div>
  )
}
