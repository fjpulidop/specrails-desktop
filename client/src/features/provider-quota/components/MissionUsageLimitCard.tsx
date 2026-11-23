/**
 * The card a mission turn leaves when its provider refused on the usage
 * limit. Missions never continue on their own: the person can schedule one
 * continue at the reset (cancellable) or continue now on another provider,
 * which receives the conversation as historical data, not instructions.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, Gauge } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { notifyError } from '../../../lib/notify-error'
import { formatResetTime } from '../lib/format-reset'
import { providerLabel } from '../lib/labels'
import { getLimitContinue, setLimitContinue, type UsageLimitRow } from '../lib/usage-limit-row'
import { sharesQuota } from '../lib/types'
import { useProviderQuota } from '../lib/useProviderQuota'

export function MissionUsageLimitCard({ row, conversationId, latest, installedProviders, onContinueWith }: {
  row: UsageLimitRow
  conversationId: string
  /** Only the newest limit card of the mission offers actions. */
  latest: boolean
  installedProviders: readonly string[]
  /** Switch the mission to `provider` and send one continue turn. */
  onContinueWith?: (provider: string, prompt: string) => Promise<void>
}) {
  const { t, i18n } = useTranslation('providerQuota')
  const quota = useProviderQuota(row.provider)
  // The store may know a later reset than the row (a refusal reported after it).
  const resumeAt = quota?.level === 'rejected' && quota.rejectedUntil ? quota.rejectedUntil : row.resumeAt
  const [scheduled, setScheduled] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  useEffect(() => {
    if (!latest) return
    const controller = new AbortController()
    void getLimitContinue(conversationId, controller.signal).then(setScheduled).catch(() => {})
    const id = `mission-limit-continue-${conversationId}`
    registerHandler(id, (data: unknown) => {
      const msg = data as { type?: string; conversationId?: string; at?: unknown } | null
      if (msg?.type === 'agent_limit_continue' && msg.conversationId === conversationId) setScheduled(typeof msg.at === 'string' ? msg.at : null)
    })
    return () => { controller.abort(); unregisterHandler(id) }
  }, [conversationId, latest, registerHandler, unregisterHandler])
  const provider = providerLabel(row.provider)
  const time = resumeAt ? formatResetTime(resumeAt, i18n.language) : null
  const future = resumeAt !== null && Date.parse(resumeAt) > Date.now()
  const alternatives = installedProviders.filter((id) => !sharesQuota(id, row.provider))
  const schedule = async (at: string | null) => {
    setBusy(true)
    try { setScheduled(await setLimitContinue(conversationId, at)) } catch (error) { notifyError(t('mission.failed', { detail: error instanceof Error ? error.message : String(error) })) } finally { setBusy(false) }
  }
  return (
    <section role="region" aria-label={t('mission.title', { provider })} data-testid="mission-usage-limit"
      className="my-2 space-y-2 rounded-card border border-accent-warning/40 bg-accent-warning/5 px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <Gauge className="mt-0.5 h-4 w-4 shrink-0 text-accent-warning" aria-hidden />
        <div className="min-w-0 space-y-0.5">
          <p className="text-strong text-foreground">{t('mission.title', { provider })}</p>
          <p className="text-body text-muted-foreground">{time ? t('mission.body', { provider, time }) : t('mission.bodyNoReset', { provider })}</p>
          {scheduled && <p className="inline-flex items-center gap-1 text-caption text-foreground" data-testid="mission-usage-limit-scheduled"><Clock className="h-3 w-3" aria-hidden />{t('mission.scheduled', { time: formatResetTime(scheduled, i18n.language) })}</p>}
        </div>
      </div>
      {latest && (
        <div className="flex flex-wrap gap-2">
          {scheduled
            ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void schedule(null)}>{t('mission.cancel')}</Button>
            : future && time && <Button size="sm" variant="outline" disabled={busy} data-testid="mission-usage-limit-schedule" onClick={() => void schedule(resumeAt)}>{t('mission.continueAt', { time })}</Button>}
          {onContinueWith && alternatives.map((id) => (
            <Button key={id} size="sm" variant="ghost" disabled={busy} data-testid={`mission-usage-limit-switch-${id}`}
              onClick={() => { setBusy(true); void onContinueWith(id, t('mission.continuePrompt')).finally(() => setBusy(false)) }}>
              {t('mission.continueWith', { provider: providerLabel(id) })}
            </Button>
          ))}
        </div>
      )}
    </section>
  )
}
