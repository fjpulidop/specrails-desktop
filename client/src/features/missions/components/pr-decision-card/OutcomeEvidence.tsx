/**
 * Per-unit delivery evidence of a PR decision card: the partial-delivery
 * summary and one chip per spec unit (succeeded / failed / blocked / no changes).
 */
import { useTranslation } from 'react-i18next'
import { cn } from '../../../../lib/utils'
import { derivePrDeliveryPresentation } from '../../../delivery/lib/pr-delivery'
import type { AgentPrDecisionEnvelope } from '../../lib/agent-api'

export function OutcomeEvidence({ envelope, hideFailedUnits = false }: { envelope: AgentPrDecisionEnvelope; hideFailedUnits?: boolean }) {
  const { t } = useTranslation('agent')
  const presentation = derivePrDeliveryPresentation(envelope)
  // An Intent session-owned outcome already says what failed: no duplicate red unit chip.
  if (hideFailedUnits && !presentation.partial) return null
  if (presentation.units.length === 0 && !presentation.partial) return null
  return (
    <div className="mt-2 space-y-1.5" data-testid="agent-pr-unit-evidence">
      {presentation.partial && (
        <p className="text-label font-medium text-accent-warning">
          {t('prCard.partialSummary', {
            succeeded: presentation.succeededCount,
            failed: presentation.failedCount,
            total: presentation.totalCount,
          })}
        </p>
      )}
      {presentation.units.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {presentation.units.map((unit) => {
            const failed = unit.implementationOutcome === 'failed' || (unit.implementationOutcome == null && !unit.succeeded)
            const noChanges = unit.deliveryOutcome === 'no_changes' || unit.changed === false
            const blocked = unit.deliveryOutcome === 'blocked'
            const label = failed
              ? t('prCard.unit.failed')
              : blocked
                ? t('prCard.unit.blocked')
                : noChanges
                  ? t('prCard.unit.noChanges')
                  : t('prCard.unit.succeeded')
            return (
              <span
                key={`${unit.ticketId}-${unit.runId ?? unit.branch}`}
                title={unit.failureCode ?? unit.branch}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-caption',
                  failed
                    ? 'border-destructive/35 bg-destructive/10 text-destructive'
                    : blocked
                      ? 'border-accent-warning/35 bg-accent-warning/10 text-accent-warning'
                      : 'border-accent-success/30 bg-accent-success/10 text-accent-success',
                )}
              >
                #{unit.ticketId} · {label}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
