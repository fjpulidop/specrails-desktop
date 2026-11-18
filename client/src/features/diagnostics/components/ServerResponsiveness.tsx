import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Gauge } from 'lucide-react'
import { getStalls, type StallSnapshot } from '../lib/diagnostics-api'
import { formatClockTime, formatStallDuration } from '../lib/format'

const POLL_MS = 5000

/**
 * Event-loop stalls of the local server, for the Resources popover. Reads
 * `/api/diagnostics/stalls` only while `active` (the popover is open).
 */
export function ServerResponsiveness({ active }: { active: boolean }) {
  const { t, i18n } = useTranslation('diagnostics')
  const [snapshot, setSnapshot] = useState<StallSnapshot | null>(null)

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const read = () => { getStalls(controller.signal).then(setSnapshot).catch(() => { /* keep the last reading */ }) }
    read()
    const timer = setInterval(read, POLL_MS)
    return () => { controller.abort(); clearInterval(timer) }
  }, [active])

  if (!snapshot) return null
  const last = snapshot.recent[0]
  const lang = i18n.language
  return (
    <div data-testid="server-responsiveness" className="flex items-start gap-2 border-t border-border/40 pt-2" title={t('responsiveness.hint', { threshold: formatStallDuration(snapshot.thresholdMs, lang) })}>
      <Gauge className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 text-caption">
        <div className="text-foreground">{t('responsiveness.title')}</div>
        {snapshot.total === 0 ? (
          <div className="text-muted-foreground">{t('responsiveness.none', { time: formatClockTime(snapshot.sinceMs, lang) })}</div>
        ) : <>
          <div className="text-accent-warning">{t('responsiveness.summary', { count: snapshot.total, duration: formatStallDuration(snapshot.longestMs, lang) })}</div>
          {last && <div className="truncate text-muted-foreground" title={last.operation ?? undefined}>
            {t('responsiveness.last', { time: formatClockTime(last.atMs, lang), duration: formatStallDuration(last.durationMs, lang), operation: last.operation ?? t('responsiveness.background') })}
          </div>}
        </>}
      </div>
    </div>
  )
}
