import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RailPrDecisionAction } from '../../../types'
import type { RepositoryDeliverySnapshot } from '../../projects/types/multi-repo'
import { Button } from '../../../components/ui/button'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'
import { cn } from '../../../lib/utils'

/** Each action retains the parent generation and explicitly identifies its repository. */
export function RepositoryDeliveries({ deliveryId, repositories, busy, onAct, onCheckout, ciStates, settled = false }: {
  deliveryId: string
  repositories?: RepositoryDeliverySnapshot[]
  busy: boolean
  onAct: (action: RailPrDecisionAction, repositoryId: string) => Promise<unknown>
  onCheckout?: (repositoryId: string) => Promise<unknown>
  /** Live CI per PR URL (the card reads it from GitHub); wins over the recorded status. */
  ciStates?: Record<string, string>
  /** The parent generation is closed (superseded, merged, discarded…): its
   *  repository rows are history, whatever their own recorded decision says. */
  settled?: boolean
}) {
  const { t } = useTranslation('dashboard')
  const [confirmation, setConfirmation] = useState<{ deliveryId: string; repositoryId: string; action: RailPrDecisionAction } | null>(null)
  if (!repositories?.length) return null
  const confirmRepository = confirmation?.deliveryId === deliveryId && !settled ? repositories.find((repository) =>
    repository.repositoryId === confirmation.repositoryId && !['merged', 'completed', 'discarded', 'superseded'].includes(repository.decision)) : null
  return <div className="w-full space-y-2" data-testid="repository-deliveries">
    {repositories.map((repository) => {
      const terminal = settled || ['merged', 'completed', 'discarded', 'superseded'].includes(repository.decision)
      const blocked = repository.deliveryOutcome === 'blocked'
      const deliverable = !!repository.deliverySha && !blocked && repository.implementationOutcome === 'succeeded'
      const action = (type: RailPrDecisionAction, label: string, confirm = false) => <Button size="sm" variant="outline" disabled={busy} onClick={() => {
        if (confirm) setConfirmation({ deliveryId, repositoryId: repository.repositoryId, action: type })
        else void onAct(type, repository.repositoryId)
      }}>{label}</Button>
      const failed = repository.decision === 'implementation_failed' || repository.decision === 'pr_failed'
      // pr-ci-loop: an open PR whose CI is not green is not "ready" yet.
      const live = repository.prUrl ? ciStates?.[repository.prUrl] : undefined
      const underReview = repository.decision === 'pr_ready' || repository.decision === 'pr_draft'
      const ciRunning = underReview && live === 'pending'
      const ciPending = underReview && (live === 'red' || (live === undefined && repository.statusCode === 'ci_needs_attention'))
      const good = !ciPending && !ciRunning && (repository.decision === 'merged' || repository.decision === 'completed' || repository.decision === 'pr_ready')
      // One header line (name · branch → base · state), one line of PR + actions.
      // The absolute path and full SHA stay one hover away (title), not on the card.
      return <section key={repository.repositoryId} className="rounded-lg border border-border/60 bg-surface/40 px-2.5 py-2 text-xs" aria-label={repository.name}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-foreground" title={repository.path}>{repository.name}</span>
          <span className="min-w-0 truncate font-mono text-caption text-muted-foreground" title={repository.deliverySha ?? undefined}>
            {repository.branch ?? '…'} → {repository.integrationBranch ?? repository.baseBranch}
          </span>
          <span className={cn('ml-auto shrink-0 rounded-full border px-2 py-0.5 text-caption',
            failed ? 'border-destructive/35 bg-destructive/10 text-destructive'
              : good ? 'border-accent-success/30 bg-accent-success/10 text-accent-success'
                : ciPending ? 'border-accent-warning/35 bg-accent-warning/10 text-accent-warning'
                  : ciRunning ? 'border-accent-info/35 bg-accent-info/10 text-accent-info'
                  : 'border-border/60 bg-surface/60 text-muted-foreground')}>
            {ciPending ? t('common:prDeliveryStatus.ci_needs_attention') : ciRunning ? t('common:prDeliveryStatus.ci_running') : t(`common:repositoryDelivery.${repository.decision}`)}
          </span>
        </div>
        {repository.statusDetail && !ciPending && <p className="mt-1 whitespace-pre-wrap leading-4 text-muted-foreground">{repository.statusDetail}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {repository.prUrl && <a className="mr-1 text-accent-info hover:underline" href={repository.prUrl} target="_blank" rel="noreferrer">PR #{repository.prNumber}</a>}
          {repository.deliverySha && <span className="mr-auto font-mono text-caption text-muted-foreground" title={repository.deliverySha}>{repository.deliverySha.slice(0, 8)}</span>}
          {!terminal && <>
            {deliverable && !repository.prUrl && action('create-pr', t('railPr.createPr'))}
            {deliverable && repository.prUrl && repository.deliveryOutcome === 'retryable_failure' && action('create-pr', t('railPr.retryPush'))}
            {deliverable && action('merge-local', t('railPr.mergeLocal'), true)}
            {deliverable && repository.branch && onCheckout && <Button size="sm" variant="outline" disabled={busy} onClick={() => void onCheckout(repository.repositoryId)}>{t('railPr.checkout')}</Button>}
            {repository.prUrl && repository.decision === 'pr_draft' && action('publish', t('railPr.publish'))}
            {repository.prUrl && repository.decision === 'pr_closed' && action('reopen', t('railPr.reopen'))}
            {repository.prUrl && action('poll-merge', t('railPr.verifyPr'))}
            {repository.decision === 'no_changes' && action('acknowledge-no-changes', t('railPr.markDone'), true)}
            {blocked && action('recover-and-retry', t('railPr.retry'))}
          </>}
        </div>
      </section>
    })}
    <ConfirmDialog
      open={!!confirmRepository}
      onOpenChange={(open) => { if (!open) setConfirmation(null) }}
      tone="default"
      testId="repository-delivery-confirm-dialog"
      confirmTestId="repository-delivery-confirm"
      title={t(confirmation?.action === 'merge-local' ? 'railPr.mergeLocalConfirmTitle' : 'railPr.markDoneConfirmTitle')}
      description={<>{confirmRepository?.name} · {t(confirmation?.action === 'merge-local' ? 'railPr.mergeLocalConfirmBody' : 'railPr.markDoneConfirmBody', { base: confirmRepository?.integrationBranch ?? confirmRepository?.baseBranch })}</>}
      confirmLabel={t(confirmation?.action === 'merge-local' ? 'railPr.mergeLocal' : 'railPr.markDone')}
      confirmDisabled={busy || !confirmRepository}
      onConfirm={() => {
        const captured = confirmation
        setConfirmation(null)
        if (captured && captured.deliveryId === deliveryId && confirmRepository) void onAct(captured.action, captured.repositoryId)
      }}
    />
  </div>
}
