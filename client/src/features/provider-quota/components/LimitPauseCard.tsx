/**
 * A loop run paused at a provider usage limit: when it resumes on its own
 * (or that it will not), and the ways forward — resume now, turn the
 * automatic resume off/on, or continue now on a provider that does not share
 * the quota: a Core run picks the provider, model and reasoning effort the
 * roles on the limited provider continue with (Core `routeOverrides`); a
 * legacy loop picks the provider only.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Gauge, Play } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { notifyError } from '../../../lib/notify-error'
import { ProviderSwitchSection, useProviderSwitchChoice } from './ProviderSwitchSection'
import { formatResetIn, formatResetTime } from '../lib/format-reset'
import { useCountdownNow } from '../lib/useCountdownNow'
import { providerLabel } from '../lib/labels'
import { answerLimitPause, type LimitAction, type LimitPause, type SwitchTarget } from '../lib/limit-pause'
import { sharesQuota } from '../lib/types'

export { switchEfforts, switchModels } from './ProviderSwitchSection'

function SwitchProvider({ limit, targets, busy, onSwitch }: {
  limit: LimitPause
  targets: SwitchTarget[]
  busy: boolean
  onSwitch: (choice: Extract<LimitAction, { action: 'switch' }>) => void
}) {
  const state = useProviderSwitchChoice(targets)
  if (!state) return null
  return <ProviderSwitchSection fromProvider={limit.providerId} targets={targets} state={state} busy={busy} onSwitch={(choice) => onSwitch({ action: 'switch', ...choice })} />
}

export function LimitPauseCard({ projectId, runId, limit, providers = [], onChanged }: {
  projectId: string
  runId: string
  limit: LimitPause
  /** Installed providers the person may continue on (the limited one and those sharing its quota are left out). */
  providers?: readonly string[]
  onChanged?: (limit: LimitPause | null) => void
}) {
  const { t, i18n } = useTranslation('providerQuota')
  const [busy, setBusy] = useState<string | null>(null)
  const now = useCountdownNow([limit.resumeAt])
  const provider = providerLabel(limit.providerId)
  const time = limit.resumeAt ? formatResetTime(limit.resumeAt, i18n.language, now) : null
  const remaining = limit.resumeAt ? formatResetIn(limit.resumeAt, now) : null
  // A Core run names where it may go (server-checked); a legacy loop offers the other installed providers.
  const targets = limit.switchable && limit.switchTargets ? limit.switchTargets.filter((target) => !sharesQuota(target.provider, limit.providerId)) : []
  const alternatives = limit.switchable && !limit.switchTargets ? providers.filter((id) => !sharesQuota(id, limit.providerId)) : []
  const act = async (key: string, choice: LimitAction) => {
    setBusy(key)
    const result = await answerLimitPause(projectId, runId, choice)
    setBusy(null)
    if (!result.ok) { notifyError(t('pause.failed', { detail: result.detail })); return }
    onChanged?.(choice.action === 'auto' ? result.limit ?? { ...limit, autoResume: choice.enabled } : null)
  }
  return (
    <section role="region" aria-label={t('pause.title', { provider })} data-testid="limit-pause-card"
      className="space-y-2 rounded-card border border-accent-warning/40 bg-accent-warning/5 px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <Gauge className="mt-0.5 h-4 w-4 shrink-0 text-accent-warning" aria-hidden />
        <div className="min-w-0 space-y-0.5">
          <p className="text-strong text-foreground">{t('pause.title', { provider })}</p>
          <p className="text-body text-muted-foreground" data-testid="limit-pause-when">
            {!time ? t('pause.noReset', { provider })
              : !limit.autoResume ? t('pause.resetsAt', { time })
              : remaining ? t('pause.resumesAt', { time, in: remaining }) : t('pause.resumesAtPassed')}
          </p>
          {limit.message && <p className="text-caption text-muted-foreground break-words">{limit.message}</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act('resume', { action: 'resume' })} className="gap-1.5">
          <Play className="h-3.5 w-3.5" aria-hidden />{t('pause.resumeNow')}
        </Button>
        {time && (
          <Button size="sm" variant="ghost" disabled={busy !== null} data-testid="limit-pause-auto"
            onClick={() => void act('auto', { action: 'auto', enabled: !limit.autoResume })}>
            {limit.autoResume ? t('pause.autoOff') : t('pause.autoOn', { time })}
          </Button>
        )}
        {alternatives.map((id) => (
          <Button key={id} size="sm" variant="ghost" disabled={busy !== null} data-testid={`limit-pause-switch-${id}`}
            onClick={() => void act(`switch:${id}`, { action: 'switch', provider: id })}>
            {t('pause.continueWith', { provider: providerLabel(id) })}
          </Button>
        ))}
      </div>
      {targets.length > 0 && (
        <SwitchProvider key={targets.map((target) => target.provider).join(',')} limit={limit} targets={targets} busy={busy !== null}
          onSwitch={(choice) => void act(`switch:${choice.provider}`, choice)} />
      )}
    </section>
  )
}
