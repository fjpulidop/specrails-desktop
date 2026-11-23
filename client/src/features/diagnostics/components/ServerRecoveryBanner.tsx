import { useTranslation } from 'react-i18next'
import { LifeBuoy, X } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import type { CrashNotice } from '../lib/diagnostics-api'
import { formatClockTime } from '../lib/format'
import { useServerCrashNotices, type ConnectionStatus } from '../hooks/useServerCrashNotices'

function useCause() {
  const { t } = useTranslation('diagnostics')
  return (notice: CrashNotice) => notice.signal !== null
    ? t('banner.signal', { signal: notice.signal })
    : notice.exitCode !== null ? t('banner.exitCode', { code: notice.exitCode }) : t('banner.unknownCause')
}

/** The sentence that explains the crashes (pure rendering of the notices). */
export function useCrashSummary(notices: CrashNotice[]): string | null {
  const { t, i18n } = useTranslation('diagnostics')
  const cause = useCause()
  if (notices.length === 0) return null
  const latest = notices[notices.length - 1]
  if (latest.outcome === 'stopped') {
    return t('banner.stopped', { time: formatClockTime(latest.atMs, i18n.language), cause: cause(latest), count: latest.recentRestarts })
  }
  if (notices.length === 1) return t('banner.restarted', { time: formatClockTime(latest.atMs, i18n.language), cause: cause(latest) })
  return t('banner.restartedMany', { count: notices.length, time: formatClockTime(notices[0].atMs, i18n.language) })
}

/**
 * Explains why the app reconnected (or why the server was down when Specrails
 * last ran): the desktop host relaunched the local server after a crash, or
 * stopped relaunching it. Offers "Report a problem". Dismissing acknowledges
 * the crashes so they are not shown again.
 */
export function ServerRecoveryBanner({ connectionStatus, onReportProblem }: { connectionStatus: ConnectionStatus; onReportProblem: () => void }) {
  const { t } = useTranslation('diagnostics')
  const { notices, acknowledge } = useServerCrashNotices(connectionStatus)
  const summary = useCrashSummary(notices)
  if (!summary) return null
  return (
    <section
      aria-label={t('banner.label')}
      data-testid="server-recovery-banner"
      className="flex shrink-0 items-start gap-3 border-b border-accent-warning/30 bg-accent-warning/10 px-4 py-2 text-label text-foreground"
    >
      <LifeBuoy className="mt-0.5 h-4 w-4 shrink-0 text-accent-warning" aria-hidden />
      <p role="status" className="min-w-0 flex-1">{summary}</p>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" size="sm" variant="outline" onClick={() => { acknowledge(); onReportProblem() }}>
          {t('banner.report')}
        </Button>
        <Button type="button" size="sm" variant="ghost" aria-label={t('banner.dismiss')} title={t('banner.dismiss')} onClick={acknowledge}>
          <X className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    </section>
  )
}
