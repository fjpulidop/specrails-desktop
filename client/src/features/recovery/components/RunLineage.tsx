import { useTranslation } from 'react-i18next'
import { GitBranch, Sparkles } from 'lucide-react'
import { Popover } from '../../../components/ui/popover'
import { formatUsd } from '../../../lib/format-usd'
import { RunStatePill } from '../../../components/ui/run-state/run-state-pill'
import { humanizePhase } from '../lib/failure-diagnosis'
import { attemptRunState, lineageFacts, type AttemptChain, type ChainAttempt } from '../lib/attempt-chain'

/**
 * The lineage line of a run that belongs to an attempt chain: "Attempt 3 of 4 ·
 * continued from the developer step of attempt 2". Its popover lists every
 * attempt, opens each one, and says what changed between them (the remedy, who
 * chose it, the guidance sent). Renders nothing for a run without lineage.
 */
export function RunLineage({ chain, onOpenRun }: { chain: AttemptChain | null; onOpenRun?: (runId: string) => void }) {
  const { t } = useTranslation('recovery')
  const { t: tRuntime } = useTranslation('agentRuntime')
  if (!chain) return null
  const { self, previous, origin, supersededBy } = lineageFacts(chain)
  const step = (id: string | null) => (id ? tRuntime(`roles.${id}`, { defaultValue: humanizePhase(id) ?? id }) : null)
  const fromStep = step(self.fromStep ?? origin?.fromStep ?? null)
  const origins = previous
    ? fromStep ? t('lineage.continuedFromStep', { step: fromStep, attempt: previous.attempt }) : t('lineage.continuedFrom', { attempt: previous.attempt })
    : null
  const summary = [t('lineage.attempt', { attempt: self.attempt, total: chain.attempts.length }), origins].filter(Boolean).join(' · ')
  return (
    <Popover
      side="bottom"
      align="start"
      width={420}
      label={t('lineage.title')}
      testId="run-lineage-popover"
      trigger={
        <button type="button" data-testid="run-lineage" className="inline-flex min-w-0 items-center gap-1.5 rounded-control px-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50">
          <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{summary}</span>
          {origin?.automatic && <Sparkles className="h-3 w-3 shrink-0 text-accent-primary" aria-label={t('lineage.automatic')} />}
          {supersededBy && <span className="shrink-0 text-foreground">· {t('lineage.supersededBy', { attempt: supersededBy.attempt })}</span>}
        </button>
      }
    >
      <div className="border-b border-border px-3 py-2">
        <p className="text-label text-foreground">{t('lineage.title')}</p>
        <p className="text-caption text-muted-foreground">{t('lineage.explain')}</p>
      </div>
      <ol className="divide-y divide-border/50" data-testid="run-lineage-attempts">
        {chain.attempts.map((attempt) => <AttemptRow key={attempt.runId} attempt={attempt} self={attempt.runId === self.runId} step={step} onOpenRun={onOpenRun} />)}
      </ol>
    </Popover>
  )
}

function AttemptRow({ attempt, self, step, onOpenRun }: { attempt: ChainAttempt; self: boolean; step: (id: string | null) => string | null; onOpenRun?: (runId: string) => void }) {
  const { t } = useTranslation('recovery')
  const { t: tCommon } = useTranslation('common')
  const state = attemptRunState(attempt)
  const origin = attempt.continuations.find((continuation) => continuation.mode === 'fork') ?? attempt.continuations[0] ?? null
  const from = step(attempt.fromStep ?? origin?.fromStep ?? null)
  return (
    <li className="space-y-1 px-3 py-2" data-testid="run-lineage-attempt" data-self={self ? '' : undefined}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-foreground num">{t('lineage.attemptShort', { attempt: attempt.attempt })}</span>
        {self && <span className="text-caption text-muted-foreground">{t('lineage.this')}</span>}
        {attempt.costUsd !== null && attempt.costUsd > 0 && (
          <span className="text-caption tabular-nums text-muted-foreground" title={attempt.costEstimated ? t('lineage.costEstimatedHint') : undefined} data-testid="run-lineage-cost">
            {attempt.costEstimated ? t('lineage.costEstimated', { cost: formatUsd(attempt.costUsd) }) : formatUsd(attempt.costUsd)}
            {attempt.costEstimated && <span className="sr-only"> ({t('lineage.costEstimatedHint')})</span>}
          </span>
        )}
        <RunStatePill state={state} label={tCommon(`runState.${state}`)} className="ml-auto" />
        {!self && onOpenRun && (
          <button type="button" className="text-caption text-accent-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50" onClick={() => onOpenRun(attempt.runId)} data-testid="run-lineage-open">
            {t('lineage.open')}
          </button>
        )}
      </div>
      {attempt.attempt > 1 && (
        <p className="text-caption text-muted-foreground">
          {[
            from ? t('lineage.fromStep', { step: from }) : null,
            origin ? (origin.automatic ? t('lineage.byAutomatic') : t(origin.remedy === 'continue-to-review' ? 'lineage.byReview' : 'lineage.byPerson')) : null,
          ].filter(Boolean).join(' · ')}
        </p>
      )}
      {origin?.guidance && (
        <details className="text-caption">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('lineage.guidance')}</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-control bg-background/60 p-2 font-mono text-caption text-foreground">{origin.guidance}</pre>
        </details>
      )}
    </li>
  )
}
