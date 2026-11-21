import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, Square } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { consequenceKey, type RemedyHandler } from '../lib/failure-diagnosis'
import { RemedyActions } from './FailureDiagnosisCard'

/**
 * A run the person stopped before it delivered. Not a failure: Continue picks
 * it up where it stopped, in the same worktree, with everything it did so far.
 * "Start over" (a fresh run from the base) waits in the menu with its warning.
 */
export function StoppedRunCard({ onContinue, onStartOver, className }: { onContinue?: RemedyHandler | null; onStartOver?: RemedyHandler | null; className?: string }) {
  const { t } = useTranslation('recovery')
  const headingId = useId()
  return (
    <section role="region" aria-labelledby={headingId} data-testid="stopped-run-card" className={cn('space-y-2.5 rounded-card border border-border/60 bg-card/40 px-3.5 py-3', className)}>
      <div className="flex items-start gap-2.5">
        <Square className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p id={headingId} className="text-strong text-foreground">{t('stopped.headline')}</p>
          <p className="text-body text-muted-foreground">{t(onContinue ? 'stopped.why' : 'stopped.whyNoContinue')}</p>
        </div>
      </div>
      <RemedyActions
        remedies={onContinue ? [{ id: 'continue', label: t('remedy.continue'), icon: Play, consequence: t(consequenceKey('continue', null)), handler: onContinue, primary: true }] : []}
        startOver={onStartOver ?? null}
      />
    </section>
  )
}
