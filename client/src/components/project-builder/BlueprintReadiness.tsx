import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDashed,
  Loader2,
  RefreshCw,
  Rocket,
  Sparkles,
  Wrench,
} from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { localizeQualityIssue, type ReadinessReport, type ReadinessStep } from '../../lib/blueprint-readiness'
import type { BuilderSnapshotState } from '../../hooks/useBuilderSession'

// The commit gate, made legible (harden-project-builder-snapshots). Replaces
// the single raw English sentence under a greyed-out button with:
//   1. three human steps — blueprint · specs · audit — each ✓ / ○ / ⚠ with a
//      localized detail line, so the user always knows what is missing;
//   2. the snapshot status: an automatic repair in flight, a rejected block
//      with its reason + a one-click retry, or "repaired automatically";
//   3. the audit issues, spec by spec, with "ask the Builder to fix" when the
//      model claimed completion and the deterministic gate disagreed.
// Pure presentation: every fact comes from `deriveReadiness` + the session's
// snapshot state; the actions are the session's own callbacks.

interface BlueprintReadinessProps {
  readiness: ReadinessReport
  snapshot: BuilderSnapshotState
  busy: boolean
  primaryLabel: string
  onPrimary: () => void
  /** Manual snapshot repair (rejected block retry / audit fix request).
   *  Omit to hide every repair affordance. */
  onRepair?: () => void
  primaryTestId?: string
  /** Show the primary action at all (the M1 shell hides it outside `chat`). */
  showPrimary?: boolean
}

const STEP_ICON: Record<ReadinessStep['state'], typeof Check> = {
  done: Check,
  pending: CircleDashed,
  blocked: AlertTriangle,
}

const STEP_TONE: Record<ReadinessStep['state'], string> = {
  done: 'text-accent-success',
  pending: 'text-muted-foreground/50',
  blocked: 'text-accent-warning',
}

export function BlueprintReadiness({
  readiness,
  snapshot,
  busy,
  primaryLabel,
  onPrimary,
  onRepair,
  primaryTestId = 'builder-create-specs',
  showPrimary = true,
}: BlueprintReadinessProps) {
  const { t } = useTranslation('builder')
  const [issuesOpen, setIssuesOpen] = useState(false)
  const repairing = snapshot.status === 'repairing'
  const rejected = snapshot.status === 'rejected'
  const specsStep = readiness.steps.find((s) => s.key === 'specs')
  const claimsComplete = specsStep?.state === 'done'
  const canAskFix = Boolean(onRepair) && claimsComplete && readiness.issues.length > 0
  const firstBlocker = readiness.steps.find((s) => s.state !== 'done')

  return (
    <div className="space-y-2.5 border-t border-border/40 p-3" data-testid="blueprint-readiness">
      {/* ── Steps */}
      <ol className="space-y-1" aria-label={t('readiness.title')}>
        {readiness.steps.map((step) => {
          const Icon = STEP_ICON[step.state]
          return (
            <li
              key={step.key}
              className="flex items-start gap-2 text-[11px] leading-4"
              data-testid={`readiness-step-${step.key}`}
              data-state={step.state}
            >
              <Icon className={cn('mt-px h-3.5 w-3.5 shrink-0', STEP_TONE[step.state])} aria-hidden />
              <span className={cn('font-medium', step.state === 'pending' && 'text-muted-foreground')}>
                {t(`readiness.steps.${step.key}`)}
              </span>
              <span className="ml-auto max-w-[60%] truncate text-right text-muted-foreground" title={t(`readiness.details.${step.key}.${step.state}`, step.params)}>
                {t(`readiness.details.${step.key}.${step.state}`, step.params)}
              </span>
            </li>
          )
        })}
      </ol>

      {/* ── Snapshot status */}
      <AnimatePresence initial={false} mode="wait">
        {repairing && (
          <motion.div
            key="repairing"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="flex items-center gap-2 rounded-md border border-accent-info/30 bg-accent-info/10 px-2.5 py-1.5 text-[11px] text-accent-info"
            data-testid="snapshot-repairing"
          >
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
            <span className="min-w-0 flex-1">
              {t(`snapshot.repairing.${snapshot.kind}`)}
              {snapshot.manual ? '' : ` · ${t('snapshot.repairing.automatic')}`}
            </span>
          </motion.div>
        )}
        {rejected && (
          <motion.div
            key="rejected"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="space-y-1.5 rounded-md border border-accent-warning/35 bg-accent-warning/10 p-2.5"
            data-testid="snapshot-rejected"
          >
            <div className="flex items-start gap-2 text-[11px] leading-4 text-accent-warning">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t('snapshot.rejected.title')}</p>
                <p className="text-accent-warning/90">{t(`snapshot.rejected.${snapshot.reason}`)}</p>
                {snapshot.repairAttempted && (
                  <p className="mt-0.5 text-[10px] text-accent-warning/80">{t('snapshot.rejected.autoRepairFailed')}</p>
                )}
              </div>
            </div>
            {snapshot.detail && (
              <p
                className="line-clamp-2 break-all font-mono text-[10px] leading-4 text-foreground/60"
                title={snapshot.detail}
                data-testid="snapshot-rejected-detail"
              >
                {snapshot.detail}
              </p>
            )}
            {onRepair && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={busy}
                onClick={onRepair}
                data-testid="snapshot-retry"
              >
                <RefreshCw className="mr-1.5 h-3 w-3" aria-hidden />
                {t('snapshot.rejected.retry')}
              </Button>
            )}
          </motion.div>
        )}
        {snapshot.status === 'accepted' && snapshot.repaired && (
          <motion.p
            key="repaired"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
            data-testid="snapshot-repaired"
          >
            <Sparkles className="h-3 w-3 text-accent-success" aria-hidden />
            {t('snapshot.repairedNote')}
          </motion.p>
        )}
      </AnimatePresence>

      {/* ── Audit issues */}
      {readiness.issues.length > 0 && (
        <div className="rounded-md border border-border/40 bg-surface/40" data-testid="readiness-issues">
          <button
            type="button"
            onClick={() => setIssuesOpen((o) => !o)}
            aria-expanded={issuesOpen}
            className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] font-medium text-foreground/80 hover:bg-surface/70"
            data-testid="readiness-issues-toggle"
          >
            <Wrench className="h-3 w-3 text-accent-warning" aria-hidden />
            <span className="flex-1">{t('readiness.issuesCount', { count: readiness.issues.length })}</span>
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', issuesOpen && 'rotate-180')} aria-hidden />
          </button>
          {issuesOpen && (
            <ul className="max-h-40 space-y-1 overflow-y-auto border-t border-border/30 px-2.5 py-2">
              {readiness.issues.map((issue, i) => (
                <li key={`${issue.specIndex}-${issue.field}-${issue.code}-${i}`} className="flex items-start gap-1.5 text-[10px] leading-4 text-muted-foreground">
                  {issue.specIndex !== null && (
                    <span className="shrink-0 rounded bg-accent-primary/10 px-1 font-mono text-[9px] text-accent-primary">
                      #{issue.specIndex + 1}
                    </span>
                  )}
                  <span>{localizeQualityIssue(t, issue)}</span>
                </li>
              ))}
            </ul>
          )}
          {canAskFix && (
            <div className="border-t border-border/30 p-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={busy}
                onClick={onRepair}
                data-testid="readiness-ask-fix"
              >
                <Wrench className="mr-1.5 h-3 w-3" aria-hidden />
                {t('readiness.askFix')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── Primary action */}
      {showPrimary && (
        <div>
          <Button
            className="w-full"
            size="sm"
            disabled={!readiness.ready || busy}
            onClick={onPrimary}
            data-testid={primaryTestId}
          >
            <Rocket className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {primaryLabel}
          </Button>
          {!readiness.ready && firstBlocker && !repairing && !rejected && (
            <p className="mt-1.5 text-center text-[10px] text-muted-foreground" data-testid="readiness-hint">
              {t(`readiness.hints.${firstBlocker.key}.${firstBlocker.state}`, firstBlocker.params)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
