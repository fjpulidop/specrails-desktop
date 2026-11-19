/**
 * The per-run "View log" chip of a PR decision card with the run's live
 * vitals (elapsed and real billed cost), reporting pause state and totals up.
 */
import { useEffect } from 'react'
import { ScrollText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../../lib/utils'
import { RunStateDot } from '../../../../components/ui/run-state/run-state-dot'
import { useRunVitals, formatRunElapsed } from '../../../jobs/hooks/useRunVitals'
import { describeJobHold } from '../../../jobs/lib/job-run-state'
import { dailyBudgetPausedMessage } from '../../../../lib/daily-budget'
import { formatUsd } from '../../../analytics/lib/format'
import { providerLabel } from '../../../provider-quota/lib/labels'
import { formatResetTime } from '../../../provider-quota/lib/format-reset'
import type { MissionRunVitalsSnapshot } from '../mission-run-strip'

/**
 * One per-run "View log" chip: the run's ticket ref + live vitals (elapsed ·
 * cost — REAL accumulated totals only, never an estimate; cost hidden until it
 * is > 0). Rendered in EVERY card state: live-ticking while the rail builds,
 * frozen at the final authoritative totals on settled/terminal cards. Click
 * opens the run's JobDetailModal scoped to the CARD's project.
 */
export function RunLogChip({
  projectId, runId, ticketLabel, live, onOpen, onVitals, onSnapshot,
}: {
  projectId: string
  runId: string
  /** `#38` (or `#4 #7` for a single all-scope run); null → short run id. */
  ticketLabel: string | null
  live: boolean
  onOpen: (runId: string) => void
  onVitals?: (runId: string, vitals: { paused: boolean; pausedReason: string | null; budgetPaused?: boolean }) => void
  /** The run strip's totals (elapsed · billed cost · progress) — ticks while live. */
  onSnapshot?: (runId: string, snapshot: MissionRunVitalsSnapshot) => void
}) {
  const { t } = useTranslation('agent')
  const vitals = useRunVitals(projectId, runId, { live })
  // budget_paused: localized amounts instead of the server's English reason.
  const { t: tQuota, i18n } = useTranslation('providerQuota')
  // limit_paused: the provider and when it resumes, in the person's clock.
  const limitReason = vitals.pauseLimit
    ? [tQuota('pause.title', { provider: providerLabel(vitals.pauseLimit.providerId) }), vitals.pauseLimit.resumeAt && vitals.pauseLimit.autoResume ? tQuota('mission.scheduled', { time: formatResetTime(vitals.pauseLimit.resumeAt, i18n.language) }) : null].filter(Boolean).join(' — ')
    : null
  // A held run (an app restart, an interrupted step) says why in the person's words.
  const holdReason = vitals.hold && vitals.hold.kind !== 'provider_limit' && vitals.hold.kind !== 'budget' ? describeJobHold(i18n.t, vitals.hold) : null
  const pausedReason = vitals.pauseBudget ? dailyBudgetPausedMessage(t, vitals.pauseBudget) : limitReason ?? holdReason ?? vitals.pausedReason
  const budgetPaused = vitals.pauseBudget !== null
  const label = ticketLabel ?? runId.slice(0, 8)
  const elapsed = vitals.elapsedMs != null ? formatRunElapsed(vitals.elapsedMs) : null
  const showCost = vitals.costUsd != null && vitals.costUsd > 0
  const dot = <span aria-hidden className="opacity-40">·</span>
  useEffect(() => {
    onVitals?.(runId, { paused: vitals.paused, pausedReason, budgetPaused })
  }, [onVitals, runId, vitals.paused, pausedReason, budgetPaused])
  useEffect(() => {
    onSnapshot?.(runId, { running: vitals.running, loaded: vitals.loaded, status: vitals.status, elapsedMs: vitals.elapsedMs, costUsd: vitals.costUsd })
  }, [onSnapshot, runId, vitals.running, vitals.loaded, vitals.status, vitals.elapsedMs, vitals.costUsd])
  return (
    <button
      type="button"
      data-agent-interactive
      data-testid="pr-run-log-chip"
      onClick={(e) => {
        e.stopPropagation()
        onOpen(runId)
      }}
      title={t('prCard.viewLog', { ref: label })}
      aria-label={t('prCard.viewLog', { ref: label })}
      className={cn(
        'inline-flex min-h-6 max-w-full cursor-pointer items-center gap-1 rounded-full border px-1.5 py-0.5 align-baseline font-mono text-caption transition-all',
        vitals.paused
          ? 'border-accent-warning/45 bg-accent-warning/10 text-accent-warning hover:-translate-y-px hover:border-accent-warning/65 hover:bg-accent-warning/15 hover:shadow-sm'
          : 'border-accent-info/35 bg-accent-info/10 text-accent-info hover:-translate-y-px hover:border-accent-info/60 hover:bg-accent-info/15 hover:shadow-sm',
      )}
    >
      {(vitals.paused || (vitals.running && live)) && (
        <RunStateDot state={vitals.paused ? 'paused' : 'working'} />
      )}
      <span className="max-w-[160px] truncate">{label}</span>
      {dot}
      <ScrollText className="h-3 w-3 shrink-0 opacity-70" />
      {elapsed && (
        <>
          {dot}
          <span className="tabular-nums" aria-label={t('prCard.runElapsedAria', { elapsed })}>{elapsed}</span>
        </>
      )}
      {showCost && (
        <>
          {dot}
          <span
            className="tabular-nums"
            aria-label={t('prCard.runCostAria', { cost: formatUsd(vitals.costUsd!) })}
          >
            {formatUsd(vitals.costUsd!)}
          </span>
        </>
      )}
    </button>
  )
}
