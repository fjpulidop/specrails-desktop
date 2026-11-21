/**
 * A run's failure as readable text on the PR decision card: code, detail,
 * failing step and per-unit failure codes.
 */
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { localizeStatusDetail } from '../../../../lib/pr-status-detail'
import { TechnicalDetail } from '../../../../components/ui/technical-detail'
import type { AgentPrDecisionEnvelope } from '../../lib/agent-api'

/**
 * The failure the person needs to read, as TEXT (never hover-only): the stable
 * code as a destructive pill, the detail line, the failing step, and every
 * unit's failure code. Sources, in order: the settle-time `runtime.failure`
 * snapshot, else the delivery's statusCode/statusDetail (this is what the old
 * `discarded` branch used to swallow behind `deliveryBlocked`).
 */
export function RunFailureBlock({ envelope }: { envelope: AgentPrDecisionEnvelope }) {
  const { t } = useTranslation('agent')
  const failure = envelope.runtime?.failure ?? null
  const code = failure?.code ?? envelope.statusCode ?? null
  const localized = localizeStatusDetail(failure?.detail ?? envelope.statusDetail, t('prCard.failed.generic'))
  const detail = localized?.text ?? null
  const unitFailures = (envelope.units ?? []).filter((u) => u.failureCode).map((u) => ({ ticketId: u.ticketId, code: u.failureCode as string }))
  if (!code && !detail && unitFailures.length === 0) return null
  return (
    <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/[0.06] px-2.5 py-2 text-label" data-testid="mission-run-failure">
      <div className="flex flex-wrap items-center gap-1.5">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
        <span className="font-medium text-destructive">{t('runCard.failure.title')}</span>
        {code && (
          <span className="rounded-full border border-destructive/40 bg-destructive/10 px-2 py-px font-mono text-caption text-destructive" data-testid="mission-run-failure-code">
            {code}
          </span>
        )}
        {failure?.stepId && (
          <span className="rounded-full border border-border/60 bg-surface/60 px-2 py-px font-mono text-caption text-muted-foreground">
            {t('runCard.failure.step', { step: failure.stepId })}
          </span>
        )}
      </div>
      {detail && (
        <p className="mt-1 break-words leading-4 text-muted-foreground" data-testid="mission-run-failure-detail">{detail}</p>
      )}
      {localized?.raw && <TechnicalDetail summary={t('prCard.recoveryDetailSummary')} className="mt-1 text-label leading-4">{localized.raw}</TechnicalDetail>}
      {unitFailures.length > 0 && (
        <ul className="mt-1 space-y-0.5 font-mono text-caption text-muted-foreground">
          {unitFailures.map((u) => (
            <li key={`${u.ticketId}-${u.code}`}>{t('runCard.failure.unit', { ticket: u.ticketId, code: u.code })}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
