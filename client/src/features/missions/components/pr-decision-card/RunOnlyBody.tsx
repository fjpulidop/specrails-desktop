/**
 * Body of a run-only PR decision card (mission-rail-cards: a shared-cwd launch
 * with no delivery). Never renders create-pr / merge-local / publish: there is
 * no branch to deliver. It shows the run outcome honestly, the failure (if
 * any) with its recovery actions, and Dismiss.
 */
import { AlertTriangle, CheckCircle2, GitBranch, Loader2, Ticket, XCircle } from 'lucide-react'
import { motion } from 'motion/react'
import { cn } from '../../../../lib/utils'
import { RailTrack } from '../../../../components/brand/RailTrack'
import { ConfirmDialog } from '../../../../components/ui/confirm-dialog'
import { MissionRunStatusPill } from './MissionRunStatusPill'
import { OutcomeEvidence } from './OutcomeEvidence'
import { RunFailureBlock } from './RunFailureBlock'
import type { PrDecisionCardModel } from './usePrDecisionCardModel'

export function RunOnlyBody({ model }: { model: PrDecisionCardModel }) {
  const {
    t, envelope, decision, runStatus, projectName, ticketChips, phaseLine, runChips, runFailure,
    runtimeError, confirmLayer, logModal,
  } = model
  const { busy, act } = model.actions
  const { confirmingDismiss, setConfirmingDismiss } = model.confirms
  const { runtimeActions, relaunchAction, runtimeBusy } = model.buttons
  const { diagnosisCard } = model.section
    const runOnlyIcon = runStatus === 'succeeded' ? CheckCircle2 : runStatus === 'failed' || runStatus === 'stalled' ? AlertTriangle : runStatus === 'cancelled' ? XCircle : null
    const RunOnlyIcon = runOnlyIcon
    const runOnlyBusy = busy !== null || runtimeBusy
  return (
    <>
      <div className="flex items-center gap-2">
        {RunOnlyIcon
          ? <RunOnlyIcon className={cn('h-4 w-4 shrink-0', runStatus === 'succeeded' ? 'text-accent-success' : runStatus === 'failed' || runStatus === 'stalled' ? 'text-destructive' : 'text-muted-foreground')} />
          : <RailTrack running className="w-10 shrink-0" />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{t(`runCard.title.${runStatus}`)}</span>
        <MissionRunStatusPill status={runStatus} />
        <span className="max-w-[140px] shrink-0 truncate text-label text-muted-foreground" title={projectName}>{projectName}</span>
        <span className="shrink-0 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 text-caption font-medium text-muted-foreground">
          {envelope.railName ? envelope.railName : t('prCard.rail', { index: envelope.railIndex + 1 })}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 text-caption text-muted-foreground">
          <Ticket className="h-3 w-3 text-accent-secondary" />
          {t('prCard.specCount', { count: envelope.ticketIds.length })}
        </span>
        {ticketChips}
        {phaseLine}
      </div>
      {runChips}
      <OutcomeEvidence envelope={envelope} />
      {(runFailure || runStatus === 'failed' || runStatus === 'stalled') && (diagnosisCard ?? <RunFailureBlock envelope={envelope} />)}
      <p className="mt-2 flex items-start gap-1.5 text-label leading-4 text-muted-foreground" data-testid="mission-run-no-delivery">
        <GitBranch className="mt-px h-3 w-3 shrink-0 opacity-60" aria-hidden />
        <span>{t('runCard.noDeliveryNote')}</span>
      </p>
      {runtimeError}
      <motion.div
        key={`${runStatus}-${envelope.updatedAt ?? ''}`}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="mt-2.5 flex flex-wrap items-center gap-1.5"
      >
        {runtimeActions}
        {runStatus !== 'running' && runStatus !== 'paused' && relaunchAction}
        {runStatus !== 'running' && runStatus !== 'paused' && decision !== 'discarded' && (
          <button type="button" onClick={() => setConfirmingDismiss(true)} disabled={runOnlyBusy} data-agent-interactive data-testid="mission-run-dismiss"
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:cursor-default disabled:opacity-60">
            {busy === 'dismiss' && <Loader2 className="h-3 w-3 animate-spin" />}
            {t('prCard.dismiss')}
          </button>
        )}
      </motion.div>
      <ConfirmDialog
        open={confirmingDismiss}
        onOpenChange={setConfirmingDismiss}
        layer={confirmLayer}
        tone="default"
        testId="agent-pr-dismiss-confirm"
        confirmTestId="agent-pr-dismiss-confirm-btn"
        title={t('prCard.confirm.dismissTitle')}
        description={t('prCard.confirm.dismissBody')}
        confirmLabel={t('prCard.dismiss')}
        confirmDisabled={runOnlyBusy}
        onConfirm={() => { setConfirmingDismiss(false); void act('dismiss') }}
      />
      {logModal}
    </>
  )
}
