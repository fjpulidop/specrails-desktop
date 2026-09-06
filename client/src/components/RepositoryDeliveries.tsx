import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RailPrDecisionAction } from '../types'
import type { RepositoryDeliverySnapshot } from '../types/multi-repo'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog'

/** Each action retains the parent generation and explicitly identifies its repository. */
export function RepositoryDeliveries({ deliveryId, repositories, busy, onAct, onCheckout }: {
  deliveryId: string
  repositories?: RepositoryDeliverySnapshot[]
  busy: boolean
  onAct: (action: RailPrDecisionAction, repositoryId: string) => Promise<unknown>
  onCheckout?: (repositoryId: string) => Promise<unknown>
}) {
  const { t } = useTranslation('dashboard')
  const [confirmation, setConfirmation] = useState<{ deliveryId: string; repositoryId: string; action: RailPrDecisionAction } | null>(null)
  if (!repositories?.length) return null
  const confirmRepository = confirmation?.deliveryId === deliveryId ? repositories.find((repository) =>
    repository.repositoryId === confirmation.repositoryId && !['merged', 'completed', 'discarded', 'superseded'].includes(repository.decision)) : null
  return <div className="w-full space-y-2" data-testid="repository-deliveries">
    {repositories.map((repository) => {
      const terminal = ['merged', 'completed', 'discarded', 'superseded'].includes(repository.decision)
      const blocked = repository.deliveryOutcome === 'blocked'
      const deliverable = !!repository.deliverySha && !blocked && repository.implementationOutcome === 'succeeded'
      const action = (type: RailPrDecisionAction, label: string, confirm = false) => <Button size="sm" variant="outline" disabled={busy} onClick={() => {
        if (confirm) setConfirmation({ deliveryId, repositoryId: repository.repositoryId, action: type })
        else void onAct(type, repository.repositoryId)
      }}>{label}</Button>
      return <section key={repository.repositoryId} className="rounded-md border border-border/60 p-2 text-xs" aria-label={repository.name}>
        <div className="flex flex-wrap items-center gap-2">
          <strong>{repository.name}</strong>
          <span className="font-mono text-muted-foreground">{repository.branch ?? '…'} → {repository.integrationBranch ?? repository.baseBranch}</span>
          <span className="ml-auto text-muted-foreground">{t(`common:repositoryDelivery.${repository.decision}`)}</span>
        </div>
        <p className="mt-1 break-all text-muted-foreground">{repository.path}</p>
        {repository.deliverySha && <p className="font-mono text-muted-foreground">{repository.deliverySha.slice(0, 12)}</p>}
        {repository.statusDetail && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{repository.statusDetail}</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          {repository.prUrl && <a className="underline" href={repository.prUrl} target="_blank" rel="noreferrer">PR #{repository.prNumber}</a>}
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
    <Dialog open={!!confirmRepository} onOpenChange={(open) => { if (!open) setConfirmation(null) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(confirmation?.action === 'merge-local' ? 'railPr.mergeLocalConfirmTitle' : 'railPr.markDoneConfirmTitle')}</DialogTitle>
          <DialogDescription>{confirmRepository?.name} · {t(confirmation?.action === 'merge-local' ? 'railPr.mergeLocalConfirmBody' : 'railPr.markDoneConfirmBody', { base: confirmRepository?.integrationBranch ?? confirmRepository?.baseBranch })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirmation(null)}>{t('common:actions.cancel')}</Button>
          <Button disabled={busy || !confirmRepository} onClick={() => {
            const captured = confirmation
            setConfirmation(null)
            if (captured && captured.deliveryId === deliveryId && confirmRepository) void onAct(captured.action, captured.repositoryId)
          }}>{t('common:actions.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}
