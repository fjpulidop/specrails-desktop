/**
 * Safety notices of a settled PR decision card: cleanup that did not finish,
 * and the safety archives kept before anything destructive ran.
 */
import { SafetyArchiveNotice } from '../../../delivery/components/SafetyArchiveNotice'
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
  const { presentation, envelope } = model
  if (presentation.safetyArchives.length === 0) return null
  return <SafetyArchiveNotice
    projectId={envelope.projectId}
    paths={presentation.safetyArchives}
    className="mt-2"
    testId="agent-pr-safety-archives"
  />
}
