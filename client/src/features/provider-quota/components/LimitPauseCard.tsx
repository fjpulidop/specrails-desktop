/**
 * A loop run paused at a provider usage limit: when it resumes on its own
 * (or that it will not), and the ways forward — resume now, turn the
 * automatic resume off/on, or continue now on a provider that does not share
 * the quota: a Core run picks the provider, model and reasoning effort the
 * roles on the limited provider continue with (Core `routeOverrides`); a
 * legacy loop picks the provider only.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRightLeft, Gauge, Play } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select'
import { notifyError } from '../../../lib/notify-error'
import { modelsForProvider } from '../../loops/lib/loop-run-models'
import { defaultReasoningEffortForProvider, reasoningEffortsForProvider } from '../../providers/lib/provider-capabilities'
import { formatResetIn, formatResetTime } from '../lib/format-reset'
import { useCountdownNow } from '../lib/useCountdownNow'
import { providerLabel } from '../lib/labels'
import { answerLimitPause, type LimitAction, type LimitPause, type SwitchTarget } from '../lib/limit-pause'
import { sharesQuota } from '../lib/types'

/** The models offered for a target: its catalog, with the server's starting model first when the catalog lacks it. */
export function switchModels(target: SwitchTarget): Array<{ value: string; label: string }> {
  const catalog = modelsForProvider(target.provider)
  return catalog.some((model) => model.value === target.model) ? catalog : [{ value: target.model, label: target.model }, ...catalog]
}

/** The efforts offered for a model, and the one it starts on (the target's when it applies, else the provider default). */
export function switchEfforts(target: SwitchTarget, model: string): { efforts: readonly string[]; initial: string | null } {
  const efforts = reasoningEffortsForProvider(target.provider, model)
  if (!efforts.length) return { efforts, initial: null }
  return { efforts, initial: target.effort && efforts.includes(target.effort as never) ? target.effort : defaultReasoningEffortForProvider(target.provider, model) ?? efforts[0]! }
}

function SwitchProvider({ limit, targets, busy, onSwitch }: {
  limit: LimitPause
  targets: SwitchTarget[]
  busy: boolean
  onSwitch: (choice: Extract<LimitAction, { action: 'switch' }>) => void
}) {
  const { t } = useTranslation(['providerQuota', 'agent'])
  const [provider, setProvider] = useState(targets[0]!.provider)
  const target = targets.find((item) => item.provider === provider) ?? targets[0]!
  const models = useMemo(() => switchModels(target), [target])
  const [model, setModel] = useState(target.model)
  const { efforts, initial } = switchEfforts(target, model)
  const [effort, setEffort] = useState<string | null>(initial)
  const [remember, setRemember] = useState(false)
  const chooseProvider = (next: string) => {
    const chosen = targets.find((item) => item.provider === next)
    if (!chosen) return
    setProvider(next); setModel(chosen.model); setEffort(switchEfforts(chosen, chosen.model).initial)
  }
  const chooseModel = (next: string) => {
    setModel(next)
    const options = switchEfforts(target, next)
    setEffort(effort && options.efforts.includes(effort) ? effort : options.initial)
  }
  const name = providerLabel(target.provider)
  return (
    <div className="space-y-2 border-t border-accent-warning/30 pt-2" data-testid="limit-pause-switch">
      <p className="flex items-center gap-1.5 text-strong text-foreground">
        <ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />{t('pause.switch.title')}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-1 text-caption text-muted-foreground">
          <span>{t('pause.switch.provider')}</span>
          <Select value={provider} onValueChange={chooseProvider} disabled={busy}>
            <SelectTrigger aria-label={t('pause.switch.provider')} data-testid="limit-pause-switch-provider"><SelectValue /></SelectTrigger>
            <SelectContent>
              {targets.map((item) => <SelectItem key={item.provider} value={item.provider}>{providerLabel(item.provider)}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-caption text-muted-foreground">
          <span>{t('pause.switch.model')}</span>
          <Select value={model} onValueChange={chooseModel} disabled={busy}>
            <SelectTrigger aria-label={t('pause.switch.model')} data-testid="limit-pause-switch-model"><SelectValue /></SelectTrigger>
            <SelectContent>
              {models.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        {efforts.length > 0 && effort && (
          <label className="space-y-1 text-caption text-muted-foreground">
            <span>{t('pause.switch.effort')}</span>
            <Select value={effort} onValueChange={setEffort} disabled={busy}>
              <SelectTrigger aria-label={t('pause.switch.effort')} data-testid="limit-pause-switch-effort"><SelectValue /></SelectTrigger>
              <SelectContent>
                {efforts.map((item) => <SelectItem key={item} value={item}>{t(`agent:effort.${item}`, { defaultValue: item })}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        )}
      </div>
      <p className="text-caption text-muted-foreground" data-testid="limit-pause-switch-consequence">
        {t('pause.switch.consequence', { provider: name, from: providerLabel(limit.providerId) })}{' '}
        {remember ? t('pause.switch.settingsUpdated', { provider: name }) : t('pause.switch.settingsKept')}
      </p>
      <label className="flex items-center gap-2 text-caption text-muted-foreground">
        <input type="checkbox" checked={remember} disabled={busy} onChange={(event) => setRemember(event.target.checked)} data-testid="limit-pause-switch-remember" />
        <span>{t('pause.switch.remember')}</span>
      </label>
      <Button size="sm" disabled={busy} data-testid="limit-pause-switch-resume" className="gap-1.5"
        onClick={() => onSwitch({ action: 'switch', provider: target.provider, model, ...(effort ? { effort } : {}), ...(remember ? { remember: true } : {}) })}>
        <Play className="h-3.5 w-3.5" aria-hidden />{t('pause.switch.resume', { provider: name })}
      </Button>
    </div>
  )
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
