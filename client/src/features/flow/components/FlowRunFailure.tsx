// ─── Flow → Spec failed outright (missions RunFailureOutcome slot) ────────────
// A technical failure — not a review verdict — explained in the person's
// words: one localized headline for the failing step, the runtime's own error
// as the cause, what happens next (the work is intact and goes back to the
// Flow with the error), the Flow's actions (Back to Flow / Relaunch) or the
// "Returned to Flow" state, and the codes under a collapsed "Technical
// details". The same block sits on the run card and inside the Flow's return
// card (`surface: 'return'`, no actions).

import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronRight, Undo2 } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { MissionRunFailureOutcomeProps } from '../../missions/context/MissionExtensionsContext'
import { flowFailureStep, firstLine } from '../lib/flow-failure'
import { FlowRunCardActions } from './FlowRunCardActions'

export function FlowRunFailure({
  projectId, prDeliveryId, conversationId, stepId, cause, statusCode, failureCode, statusDetail, repositoryName, returned, surface, busy,
}: MissionRunFailureOutcomeProps) {
  const { t } = useTranslation('agent')
  const step = flowFailureStep(stepId, [statusCode, failureCode])
  const causeLine = firstLine(cause)
  const technical: Array<[string, string]> = [
    ...(repositoryName ? [[t('flow.failure.technical.repository'), repositoryName] as [string, string]] : []),
    ...(stepId ? [[t('flow.failure.technical.step'), stepId] as [string, string]] : []),
    ...(statusCode ? [[t('flow.failure.technical.status'), statusCode] as [string, string]] : []),
    ...(failureCode && failureCode !== statusCode ? [[t('flow.failure.technical.failure'), failureCode] as [string, string]] : []),
    ...(statusDetail ? [[t('flow.failure.technical.detail'), statusDetail] as [string, string]] : []),
  ]
  const embedded = surface === 'return'
  return (
    <div
      data-testid="flow-run-failure"
      data-step={step}
      data-returned={returned ? 'true' : 'false'}
      className={cn('text-[11px]', !embedded && 'mt-2 rounded-md border border-accent-warning/35 bg-accent-warning/[0.06] px-2.5 py-2')}
    >
      <p className="flex items-start gap-1.5 font-medium leading-4 text-foreground/90">
        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-accent-warning" aria-hidden />
        <span data-testid="flow-run-failure-headline">{t(`flow.failure.step.${step}`)}</span>
      </p>
      {causeLine && (
        <p className="mt-1 break-words pl-5 leading-4 text-foreground/75" data-testid="flow-run-failure-cause">
          <span className="text-foreground/70">{t('flow.failure.cause')} </span>
          {causeLine}
        </p>
      )}
      <p className="mt-1 pl-5 leading-4 text-foreground/60" data-testid="flow-run-failure-next">
        {t(returned ? 'flow.failure.nextReturned' : 'flow.failure.next')}
      </p>
      {!embedded && (
        returned ? (
          <p className="mt-2 inline-flex items-center gap-1 pl-5 font-medium text-accent-flow" data-testid="flow-run-failure-returned">
            <Undo2 className="h-3 w-3" aria-hidden />
            {t('flow.failure.returned')}
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-5">
            <FlowRunCardActions projectId={projectId ?? ''} prDeliveryId={prDeliveryId} conversationId={conversationId}
              decision="implementation_failed" statusCode={statusCode} busy={busy || !projectId} />
          </div>
        )
      )}
      {technical.length > 0 && (
        <details className="group mt-1.5 pl-5 text-[11px] leading-4 text-foreground/70" data-testid="flow-run-failure-technical">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded font-medium text-foreground/60 hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-flow/50 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
            {t('flow.failure.technical.title')}
          </summary>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
            {technical.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-foreground/70">{label}</dt>
                <dd className="min-w-0 break-words font-mono text-foreground/80">{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  )
}
