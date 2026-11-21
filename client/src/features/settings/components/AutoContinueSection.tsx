import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Play, ShieldCheck, Sparkles } from 'lucide-react'
import { API_ORIGIN } from '../../../lib/origin'
import { notifyError } from '../../../lib/notify-error'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card'
import { Skeleton } from '../../../components/ui/skeleton'
import { Switch } from '../../../components/ui/switch'

/**
 * "Continue failed runs automatically" (app-wide, on by default). When a run
 * fails for a known cause it can fix (unfinished tasks, a missing tool, a
 * transient provider error, a stall), Specrails continues it once by itself and
 * says so in the run's history. Never for credentials, policy, spend caps or a
 * repeated failure.
 */
export function AutoContinueSection() {
  const { t } = useTranslation('settings')
  const [enabled, setEnabledState] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(`${API_ORIGIN}/api/settings`)
      .then((res) => (res.ok ? res.json() as Promise<{ autoContinueRuns?: boolean }> : null))
      .then((data) => { if (!cancelled && data) setEnabledState(data.autoContinueRuns !== false) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])
  async function setEnabled(next: boolean) {
    setSaving(true)
    setEnabledState(next)
    try {
      const res = await fetch(`${API_ORIGIN}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoContinueRuns: next }) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success(next ? t('autoContinue.enabled') : t('autoContinue.disabled'))
    } catch (err) {
      setEnabledState(!next)
      notifyError(t('autoContinue.saveFailed'), { detail: (err as Error).message, retry: () => void setEnabled(next) })
    } finally {
      setSaving(false)
    }
  }
  if (!loaded) return <Skeleton className="h-32 rounded-lg" data-testid="section-skeleton" />
  const label = t('autoContinue.toggleLabel')
  return (
    <Card data-testid="auto-continue-settings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Play className="h-4 w-4 text-accent-primary" aria-hidden />
          {t('autoContinue.title')}
        </CardTitle>
        <CardDescription>{t('autoContinue.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <p className="text-label">{label}</p>
            <p className="text-xs text-muted-foreground">{enabled ? t('autoContinue.stateOn') : t('autoContinue.stateOff')}</p>
          </div>
          <Switch checked={enabled} onCheckedChange={(next) => void setEnabled(next)} aria-label={label} disabled={saving} />
        </div>
        <ul className="space-y-2 rounded-lg border border-border/40 bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
          <li className="flex gap-2"><Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{t('autoContinue.explainWhen')}</li>
          <li className="flex gap-2"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{t('autoContinue.explainNever')}</li>
        </ul>
      </CardContent>
    </Card>
  )
}
