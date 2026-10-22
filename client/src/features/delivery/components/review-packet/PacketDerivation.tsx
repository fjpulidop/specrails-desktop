/**
 * "Derivation" (Flow -> Spec): how much of the Flow's diff the derived OpenSpec
 * change explains. Coverage is Core's own measurement from git (app-verified);
 * the deriver's confidence is the model's self-assessment (AI-reported). Shown
 * before "What to watch out for" so unexplained files are seen first.
 */
import { useTranslation } from 'react-i18next'
import { GitCompareArrows } from 'lucide-react'
import type { PacketDerivation as Derivation, PacketFlowSettlement } from '../../../../types'

const MAX_LISTED = 12

export function PacketDerivation({ derivation, settlement }: { derivation: Derivation; settlement?: PacketFlowSettlement | null }) {
  const { t } = useTranslation('packet')
  const rewriteFailed = settlement?.specRewrite === 'failed'
  if (derivation.status === 'unavailable') {
    return (
      <section className="rounded-lg border border-border/60 bg-surface/40 p-4" data-testid="packet-derivation" aria-labelledby="packet-derivation-title">
        <h2 id="packet-derivation-title" className="mb-1 flex items-center gap-1.5 text-sm font-medium text-foreground">
          <GitCompareArrows className="size-4 text-accent-info" aria-hidden />
          {t('derivation.title')}
        </h2>
        <p className="text-xs text-muted-foreground">{t('derivation.unavailable')}</p>
        {rewriteFailed ? <p className="mt-2 text-xs text-accent-warning" data-testid="packet-derivation-rewrite-failed">{t('derivation.rewriteFailed')}</p> : null}
      </section>
    )
  }
  const unexplained = derivation.unexplainedFiles.length + derivation.unexplainedOmitted
  const complete = derivation.files > 0 && unexplained === 0
  const listed = derivation.unexplainedFiles.slice(0, MAX_LISTED)
  const more = unexplained - listed.length
  return (
    <section
      className={`rounded-lg border p-4 ${complete ? 'border-accent-success/30 bg-accent-success/5' : 'border-accent-warning/30 bg-accent-warning/5'}`}
      data-testid="packet-derivation"
      aria-labelledby="packet-derivation-title"
    >
      <h2 id="packet-derivation-title" className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
        <GitCompareArrows className={`size-4 ${complete ? 'text-accent-success' : 'text-accent-warning'}`} aria-hidden />
        {t('derivation.title')}
      </h2>
      <p className="text-sm text-foreground" data-testid="packet-derivation-coverage">
        {t('derivation.coverage', { explained: derivation.explained, files: derivation.files })}
      </p>
      <dl className="mt-2 grid gap-x-3 gap-y-0.5 text-xs text-muted-foreground sm:grid-cols-[auto_1fr]">
        {derivation.change ? <><dt className="font-medium">{t('derivation.change')}</dt><dd className="font-mono">{derivation.change}</dd></> : null}
        <dt className="font-medium">{t('derivation.requirements')}</dt>
        <dd>{t('derivation.requirementsValue', { added: derivation.requirementsAdded, modified: derivation.requirementsModified })}</dd>
        <dt className="font-medium">{t('derivation.confidence')}</dt>
        <dd>{derivation.confidence ? t(`derivation.confidenceLevel.${derivation.confidence}`) : t('derivation.confidenceUnknown')}</dd>
      </dl>
      <p className="mt-1 text-[11px] text-muted-foreground">{t('derivation.caveat')}</p>
      {unexplained > 0 ? (
        <div className="mt-3">
          <h3 className="text-xs font-medium text-accent-warning">{t('derivation.unexplainedTitle', { count: unexplained })}</h3>
          <ul className="mt-1 space-y-0.5" data-testid="packet-derivation-unexplained">
            {listed.map((file) => <li key={file} className="font-mono text-[11px] text-foreground/80">{file}</li>)}
          </ul>
          {more > 0 ? <p className="mt-1 text-[11px] text-muted-foreground">{t('derivation.more', { count: more })}</p> : null}
        </div>
      ) : null}
      {rewriteFailed ? <p className="mt-2 text-xs text-accent-warning" data-testid="packet-derivation-rewrite-failed">{t('derivation.rewriteFailed')}</p> : null}
    </section>
  )
}
