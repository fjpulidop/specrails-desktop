import { useTranslation } from 'react-i18next'
import type { LoopCompletion } from './completion-model'

export function LoopCompletionSummary({ result }: { result: LoopCompletion }) {
  const { t } = useTranslation('jobs')
  const core = result.core
  const status = (value: string) => t(`completion.status.${value}`, { defaultValue: value })
  return <section aria-label={t('completion.title')} className="border-b border-border/40 px-4 py-3 text-xs space-y-2" data-testid="loop-completion">
    <p className="font-medium">{t('completion.execution')}: {status(result.execution)}</p>
    {core ? <>
      <dl className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {(['implementation', 'validation', 'archive', 'delivery'] as const).map(key => <div key={key}>
          <dt className="text-foreground/70">{t(`completion.${key}`)}</dt>
          <dd className={core.completion[key] === 'with-exceptions' || core.completion[key] === 'blocked' ? 'text-accent-warning font-medium' : 'font-medium'}>{status(core.completion[key])}</dd>
        </div>)}
      </dl>
      <details>
        <summary className="cursor-pointer">{t('completion.evidence')}</summary>
        <div className="space-y-2 pt-2 break-words">
          <p className="text-foreground/70">{t('completion.snapshot', { change: core.change, at: core.recordedAt })}</p>
          {core.completion.reasons.map((reason, i) => <p key={`reason-${i}`}>{reason}</p>)}
          {core.exceptions.map((exception, i) => <div key={`exception-${i}`}>
            <p className="font-medium">{exception.requirement}</p>
            <p>{exception.reason} — {exception.impact}</p>
            <p>{t('completion.acceptedBy', { by: exception.acceptedBy })}: {exception.approvalEvidence}</p>
          </div>)}
          {core.checks.map((check, i) => <div key={`check-${i}`}>
            <p className="font-medium">{check.name}: {status(check.status)} ({t(check.required ? 'completion.required' : 'completion.supplementary')})</p>
            <p>{check.scope} — {check.limitations}</p>
            <p className="text-foreground/70">{check.evidence.join('; ')}</p>
          </div>)}
          {core.findings.map((finding, i) => <p key={`finding-${i}`}>{finding}</p>)}
          {core.phases.map(phase => <p key={phase.name}>{phase.name}: {status(phase.status)} · {phase.durationMs == null ? t('completion.unavailable') : `${(phase.durationMs / 1000).toFixed(1)}s`} · {phase.attempts == null ? t('completion.unavailable') : t('completion.attempts', { count: phase.attempts })}</p>)}
          <p className="text-foreground/70">{t('completion.phaseCostUnavailable')}</p>
        </div>
      </details>
    </> : <p className="text-foreground/70">{t('completion.noCoreEvidence')}</p>}
  </section>
}
