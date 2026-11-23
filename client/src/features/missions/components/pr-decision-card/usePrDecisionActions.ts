/**
 * Delivery actions of a PR decision card: the decision POST (`act`) with its
 * outcome toasts, the saved-local-changes actions, checking out the PR branch
 * and inspecting a preserved local result. Every call is scoped to the CARD's
 * project; an HTTP snapshot is applied locally until the broadcast lands.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { notifyError } from '../../../../lib/notify-error'
import { isTauri, revealItemInDir } from '../../../../lib/tauri-shell'
import { notifyGitChanged } from '../../../code/lib/git-refresh'
import { prDeliveryCheckoutBranch, type PrDeliveryPresentation } from '../../../delivery/lib/pr-delivery'
import { useAgentChat } from '../../context/AgentChatContext'
import {
  postRailPrDecision,
  postRailPrCheckout,
  postLocalChangesAction,
  agentEnvelopeFromSnapshot,
  type AgentPrDecisionAction,
  type AgentPrDecisionEnvelope,
} from '../../lib/agent-api'

/** The envelope the card renders: the prop, or a just-answered HTTP snapshot
 *  until the persisted message/WS update replaces it. */
export function useLocalEnvelope(envelopeProp: AgentPrDecisionEnvelope) {
  // HTTP action snapshots render immediately; the persisted message/WS update
  // replaces this override and keeps pinning/history placement authoritative.
  const [localEnvelope, setLocalEnvelope] = useState<AgentPrDecisionEnvelope | null>(null)
  const envelope = localEnvelope ?? envelopeProp
  useEffect(() => { setLocalEnvelope(null) }, [envelopeProp])
  return { envelope, setLocalEnvelope }
}

export function usePrDecisionActions(args: {
  envelope: AgentPrDecisionEnvelope
  setLocalEnvelope: (envelope: AgentPrDecisionEnvelope | null) => void
  conversationId: string | null | undefined
  runOnly: boolean
  hasRepositoryDeliveries: boolean
  presentation: PrDeliveryPresentation
}) {
  const { envelope, setLocalEnvelope, conversationId, runOnly, hasRepositoryDeliveries, presentation } = args
  const { t } = useTranslation('agent')
  const { applyPrDecisionSnapshot } = useAgentChat()
  const { decision, prUrl } = envelope
  const [busy, setBusy] = useState<AgentPrDecisionAction | null>(null)
  const [checkingOut, setCheckingOut] = useState(false)
  const [localAction, setLocalAction] = useState<'restore' | 'bring-back' | 'discard-branch' | null>(null)

  // A broadcast moved the envelope on (this surface or the other one answered):
  // reconcile any local in-flight state to the fresh decision.
  useEffect(() => {
    setBusy(null)
  }, [decision, prUrl, envelope.prDeliveryId])

  /** The failed action named in the headline ("Couldn't create the PR"), not a generic "Action failed". */
  const failedTitle = (action: AgentPrDecisionAction): string => {
    switch (action) {
      case 'create-pr': case 'reopen': return t('prCard.failed.createPr')
      case 'merge-local': return t('prCard.failed.mergeLocal')
      case 'discard': case 'dismiss': return t('prCard.failed.discard')
      case 'publish': return t('prCard.failed.publish')
      default: return t('prCard.actionFailed')
    }
  }

  const act = async (action: AgentPrDecisionAction, repositoryId?: string) => {
    if (checkingOut || busy || envelope.operation) return
    if (hasRepositoryDeliveries && !repositoryId && ['create-pr', 'merge-local', 'publish', 'poll-merge', 'reopen', 'acknowledge-no-changes'].includes(action)) return
    const repository = envelope.repositoryDeliveries?.find((item) => item.repositoryId === repositoryId)
    const targetBase = repository?.integrationBranch ?? repository?.baseBranch ?? envelope.baseBranch
    setBusy(action)
    try {
      const r = await postRailPrDecision(envelope.projectId, {
        prDeliveryId: envelope.prDeliveryId,
        action,
        expectedDecision: decision,
        ...(repositoryId ? { repositoryId } : {}),
        // Run-only cards (no delivery row) are resolved against the origin
        // conversation's persisted card — the server needs its id.
        ...(runOnly && conversationId ? { conversationId } : {}),
      })
      let snapshotApplication: ReturnType<typeof applyPrDecisionSnapshot> | null = null
      if (r.snapshot) {
        const next = agentEnvelopeFromSnapshot(envelope, r.snapshot)
        snapshotApplication = applyPrDecisionSnapshot(next)
        if (snapshotApplication !== 'stale') setLocalEnvelope(next)
      }
      if (snapshotApplication === 'stale') {
        // Another generation already superseded this card while its HTTP
        // request was in flight. Never resurrect its controls or celebrate an
        // outcome that is no longer the active delivery.
        toast.info(t('prCard.alreadyResolved'))
        return
      }
      if (r.kind === 'recovering') {
        toast.info(t('common:prRecovery.inProgress'))
      } else if (r.kind === 'busy') {
        toast.info(t(`prCard.operation.${r.operation ?? 'inProgress'}`))
      } else if (r.kind === 'stale') {
        // Neutral: the row was already resolved elsewhere — the next
        // agent_pr_decision broadcast re-renders this card to the real state.
        toast.info(t('prCard.alreadyResolved'))
      } else if (r.kind === 'blocked') {
        // merge-local precondition — user-fixable, name exactly what to fix.
        toast.warning(r.reason === 'dirty'
          ? t('prCard.mergeLocalBlockedDirty', { base: r.base || targetBase })
          : t('prCard.mergeLocalBlockedBranch', { base: r.base || targetBase, current: r.current ?? '?' }))
      } else if (r.kind === 'failed') {
        notifyError(failedTitle(action), { detail: r.detail, retry: () => void act(action, repositoryId) })
      } else if (r.kind === 'ok' && action === 'recover-and-retry') {
        if (r.deliveryVerified) {
          const sha = (r.verifiedSha ?? r.snapshot?.deliverySha ?? '').slice(0, 8)
          toast.success(t('prCard.recoverAndRetryVerified', { sha }))
        } else if (r.recoveryUnavailable || r.snapshot?.statusCode === 'recovery_unavailable') {
          toast.info(t('prCard.recoveryUnavailable'), { description: t('prCard.recoveryUnavailableBody') })
        } else {
          toast.warning(t('prCard.recoveryStillBlocked'), { description: r.detail ?? undefined })
        }
      } else if (r.kind === 'ok' && action === 'create-pr' && presentation.retryablePush && r.deliveryVerified) {
        const sha = (r.verifiedSha ?? r.snapshot?.deliverySha ?? envelope.deliverySha ?? '').slice(0, 8)
        toast.success(t(r.pushed ? 'prCard.retryPushVerified' : 'prCard.commitAlreadyVerified', { sha }))
      } else if (r.kind === 'ok' && action === 'create-pr' && r.detail) {
        // Successful HTTP can still mean a retryable/degraded delivery. Keep the
        // stable localized card title primary and expose the raw detail second.
        notifyError(t('prCard.deliveryNeedsAttention'), { detail: r.detail, retry: () => void act(action, repositoryId) })
      } else if (r.kind === 'ok' && action === 'poll-merge' && r.deliveryVerified === false) {
        toast.warning(t('prCard.commitMissingRetry'))
      } else if (r.kind === 'ok' && action === 'poll-merge' && r.deliveryVerified && !r.merged) {
        const sha = (r.verifiedSha ?? r.snapshot?.deliverySha ?? envelope.deliverySha ?? '').slice(0, 8)
        toast.success(t('prCard.prVerifiedWaiting', { sha }))
      } else if (action === 'poll-merge' && !r.merged && r.decision !== 'pr_closed') {
        toast.info(t('prCard.notMergedYet'))
      } else if (action === 'merge-local' && r.kind === 'ok' && r.decision === 'merged') {
        const tickets = envelope.ticketIds.map((id) => `#${id}`).join(', ')
        if (r.localChanges?.state === 'restored') toast.success(t('prCard.mergedLocallyRestored', { tickets }))
        else if (r.localChanges?.state === 'needs_attention') toast.warning(t('prCard.mergedLocallyStashConflict', { tickets }), { description: r.localChanges.stashName })
        else if (r.localChanges?.state === 'saved') toast.warning(t('prCard.mergedLocallyStashKept', { tickets }), { description: r.localChanges.stashName })
        else toast.success(t('prCard.mergedLocally', { base: targetBase }))
      }
      // Repo-mutating decisions (branch created/pushed, branches deleted,
      // local merge commit) → git-state surfaces refresh immediately.
      if (r.kind === 'ok' && (action === 'create-pr' || action === 'discard' || action === 'merge-local' || action === 'recover-and-retry')) {
        notifyGitChanged(envelope.projectId)
      }
    } catch (e) {
      notifyError(failedTitle(action), { detail: e instanceof Error ? e.message : undefined, retry: () => void act(action, repositoryId) })
    } finally {
      setBusy(null)
    }
  }

  /** The saved-local-changes actions: "Restore my changes" (re-apply the
   *  stash), "Bring them back" (fast-forward the target to the reviewed
   *  restore branch) and "Discard the restored branch" (the stash is kept). */
  const runLocalChangesAction = async (action: 'restore' | 'bring-back' | 'discard-branch') => {
    if (localAction || busy || envelope.operation) return
    setLocalAction(action)
    const branch = envelope.localStash?.branch || envelope.baseBranch
    try {
      const r = await postLocalChangesAction(envelope.projectId, envelope.prDeliveryId, action)
      if (r.kind !== 'recovering' && r.kind !== 'failed' && r.snapshot) {
        const next = agentEnvelopeFromSnapshot(envelope, r.snapshot)
        if (applyPrDecisionSnapshot(next) !== 'stale') setLocalEnvelope(next)
      }
      if (r.kind === 'ok') {
        const state = r.localChanges?.state
        if (action === 'discard-branch') toast.info(t('prCard.localStash.discardedToast'))
        else if (action === 'bring-back') toast.success(t('prCard.localStash.broughtBackToast', { branch }))
        else if (state === 'restored') toast.success(t('prCard.localStash.restoredToast', { branch }))
        else if (state === 'released') toast.info(t('prCard.localStash.released'))
        else toast.warning(t('prCard.localStash.stillConflicting', { branch }))
        if (action !== 'discard-branch') notifyGitChanged(envelope.projectId)
      } else if (r.kind === 'blocked') {
        if (r.reason === 'wrong_branch') toast.warning(t('prCard.localStash.blockedBranch', { base: r.base || branch, current: r.current ?? '?' }))
        else if (r.reason === 'dirty') toast.warning(t('prCard.localStash.blockedDirty'))
        else if (r.reason === 'branch_changed' || r.reason === 'target_conflict') toast.warning(t('prCard.localStash.blockedBringBack', { branch }), { description: r.detail || undefined })
        else notifyError(t('prCard.localStash.failed'), { retry: () => void runLocalChangesAction(action) })
      } else if (r.kind === 'not_ready' || r.kind === 'in_progress') {
        toast.info(t('prCard.localStash.notReady'))
      } else if (r.kind === 'busy') {
        toast.info(t('prCard.operation.inProgress'))
      } else if (r.kind === 'recovering') {
        toast.info(t('common:prRecovery.inProgress'))
      } else {
        notifyError(t('prCard.localStash.failed'), { detail: r.detail, retry: () => void runLocalChangesAction(action) })
      }
    } finally {
      setLocalAction(null)
    }
  }

  const checkoutPrBranch = async (repositoryId?: string) => {
    if (hasRepositoryDeliveries && !repositoryId) return
    if (busy || checkingOut || envelope.operation) return
    setCheckingOut(true)
    try {
      const r = await (repositoryId ? postRailPrCheckout(envelope.projectId, envelope.prDeliveryId, repositoryId) : postRailPrCheckout(envelope.projectId, envelope.prDeliveryId))
      if (r.kind === 'ok') {
        toast.success(t('prCard.checkoutSuccess', { branch: r.branch ?? prDeliveryCheckoutBranch(envelope) ?? '' }))
        if (r.cleanupWarnings.length > 0) {
          toast.warning(t('prCard.cleanupIncomplete', { count: r.cleanupWarnings.length }), { description: r.cleanupWarnings.join('\n') })
        }
        // The main checkout just moved to the PR branch — git-state surfaces
        // (AgentGitBar branch strip) must reflect it immediately.
        notifyGitChanged(envelope.projectId)
      } else if (r.kind === 'recovering') {
        toast.info(t('common:prRecovery.inProgress'))
      } else if (r.error === 'checkout_dirty') {
        toast.warning(t('prCard.checkoutDirtyTitle'), { description: t('prCard.checkoutDirtyBody') })
      } else if (r.error === 'checkout_not_deliverable') {
        toast.warning(t('prCard.checkoutNotDeliverableTitle'), { description: t('prCard.checkoutNotDeliverableBody') })
      } else if (r.error === 'checkout_safety_unknown') {
        toast.warning(t('prCard.checkoutSafetyUnknownTitle'), { description: t('prCard.checkoutSafetyUnknownBody') })
      } else {
        toast.warning(t('prCard.checkoutFailed'), { description: r.detail })
      }
    } catch (e) {
      notifyError(t('prCard.checkoutFailed'), { detail: e instanceof Error ? e.message : undefined, retry: () => void checkoutPrBranch(repositoryId) })
    } finally {
      setCheckingOut(false)
    }
  }

  const inspectLocalResult = async () => {
    const paths = presentation.recoveryWorktreePaths
    if (paths.length === 0) {
      toast.info(t('prCard.localResultUnavailableHere'))
      return
    }
    const value = paths.join('\n')
    let copied = false
    try {
      await navigator.clipboard.writeText(value)
      copied = true
    } catch { /* the preserved path remains visible in the fallback toast */ }
    try {
      if (isTauri()) await revealItemInDir(paths[0])
    } catch { /* revealing is best-effort; copying still succeeds independently */ }
    if (copied) {
      toast.success(t('prCard.localResultPathCopied'), { description: value })
    } else {
      toast.info(t('prCard.localResultPath'), { description: value })
    }
  }

  return { busy, checkingOut, localAction, act, runLocalChangesAction, checkoutPrBranch, inspectLocalResult }
}
