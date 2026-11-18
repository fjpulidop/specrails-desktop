/**
 * Safety notices of a settled PR decision card: cleanup that did not finish,
 * and the safety archives kept before anything destructive ran.
 */
import type { PrDecisionCardModel } from './usePrDecisionCardModel'

export function PrCardCleanupWarnings({ model }: { model: PrDecisionCardModel }) {
  const { t, presentation } = model
  if (presentation.cleanupWarnings.length === 0) return null
  return (
    <div className="mt-2 rounded-md border border-accent-warning/35 bg-accent-warning/10 px-2 py-1.5 text-label text-accent-warning" data-testid="agent-pr-cleanup-warning">
      <p className="font-medium">{t('prCard.cleanupIncomplete', { count: presentation.cleanupWarnings.length })}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
        {presentation.cleanupWarnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
      </ul>
    </div>
  )
}

export function PrCardSafetyArchives({ model }: { model: PrDecisionCardModel }) {
  const { t, presentation } = model
  if (presentation.safetyArchives.length === 0) return null
  return (
    <details
      className="mt-2 rounded-md border border-accent-info/25 bg-accent-info/5 px-2 py-1.5 text-label text-muted-foreground"
      data-agent-interactive
      data-testid="agent-pr-safety-archives"
    >
      <summary className="cursor-pointer font-medium text-accent-info">
        {t('prCard.safetyArchiveTitle', { count: presentation.safetyArchives.length })}
      </summary>
      <p className="mt-1 leading-4">{t('prCard.safetyArchiveHint')}</p>
      <ul className="mt-1 space-y-0.5 font-mono text-caption text-muted-foreground">
        {presentation.safetyArchives.map((archive) => (
          <li key={archive} className="break-all">{archive}</li>
        ))}
      </ul>
    </details>
  )
}
