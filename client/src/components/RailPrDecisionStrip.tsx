import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { GitPullRequest, GitMerge, ExternalLink, Loader2, AlertTriangle, Eye } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './ui/dialog'
import { Button } from './ui/button'
import type { RailPrDecision, RailPrDecisionAction, RailPrStateSnapshot } from '../types'
import type { RailPrActResult } from '../context/RailPrDecisionContext'

interface RailPrDecisionStripProps {
  decision: RailPrStateSnapshot
  density: 'normal' | 'compact'
  /** POSTs /rails/pr-decision for this rail (bound to railIndex upstream). */
  act: (action: RailPrDecisionAction, expectedDecision: RailPrDecision) => Promise<RailPrActResult>
}

/**
 * The premium ask-first PR decision bar rendered on a rail row (both density
 * branches) whenever the rail has an active `rail_pr_deliveries` snapshot.
 * State is purely the `decision` prop — buttons disable while a request is in
 * flight and the strip reconciles to the next `rail.pr_state` broadcast (no
 * optimistic writes). Discard is destructive → confirm dialog first.
 */
export function RailPrDecisionStrip({ decision, density, act }: RailPrDecisionStripProps) {
  const { t } = useTranslation('dashboard')
  const [inFlight, setInFlight] = useState<RailPrDecisionAction | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [confirmMergeLocal, setConfirmMergeLocal] = useState(false)

  const d = decision.decision
  if (d === 'building' || d === 'merged' || d === 'discarded') return null

  const compact = density === 'compact'

  async function run(action: RailPrDecisionAction, expected: RailPrDecision) {
    if (inFlight) return
    setInFlight(action)
    try {
      const res = await act(action, expected)
      if (res.status === 409) {
        // merge-local preconditions are USER-fixable, not a lost race — say
        // exactly what to fix (checkout the base / clean the tree) and stop.
        if (res.error === 'merge_local_blocked') {
          toast.warning(res.reason === 'dirty'
            ? t('railPr.mergeLocalBlockedDirty', { base: res.base ?? decision.baseBranch })
            : t('railPr.mergeLocalBlockedBranch', { base: res.base ?? decision.baseBranch, current: res.current ?? '?' }))
          return
        }
        // A concurrent answer (other surface / other client) won — the
        // broadcast reconciles the strip; just say so, neutrally.
        toast.info(t('railPr.alreadyResolved'))
        return
      }
      if (res.status === 502) {
        if (res.error === 'merge_failed') {
          toast.error(t('railPr.mergeLocalFailed', { detail: res.detail ?? '' }))
          return
        }
        toast.error(t('railPr.ghFailed', { detail: res.detail ?? res.error ?? '' }))
        return
      }
      if (!res.ok) {
        toast.error(t('railPr.actionFailed'))
        return
      }
      if (action === 'poll-merge' && res.merged === false) {
        toast.info(t('railPr.notMergedYet'))
      }
      if (action === 'merge-local' && res.decision === 'merged') {
        toast.success(t('railPr.mergedLocally', { base: decision.baseBranch }))
      }
      // create-pr can succeed as an HTTP call yet land on pr_failed (retryable
      // delivery failure) — say so, carrying the underlying git/gh detail when
      // the server relayed one; the broadcast flips the strip to Retry.
      if (action === 'create-pr' && res.decision === 'pr_failed') {
        toast.error(res.detail ? t('railPr.prFailedDetail', { detail: res.detail }) : t('railPr.prFailed'))
        return
      }
      // …or land on a DEGRADED pr_draft (pushed / local-only — no PR exists):
      // surface WHY (the git stderr detail) so the user knows what to fix
      // before hitting Retry instead of a silent pill flip.
      if (action === 'create-pr' && res.decision === 'pr_draft' && !res.prUrl && res.detail) {
        toast.error(t('railPr.createDegraded', { detail: res.detail }))
      }
      // Success state changes arrive via the rail.pr_state broadcast.
    } finally {
      setInFlight(null)
    }
  }

  // ── shared bits ─────────────────────────────────────────────────────────────
  const pillBase = `inline-flex items-center gap-1 rounded-full font-medium border ${
    compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'
  }`
  const primaryBtn = `inline-flex items-center gap-1 rounded-md font-medium bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-50 disabled:pointer-events-none transition-colors ${
    compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'
  }`
  const ghostBtn = `inline-flex items-center gap-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-50 disabled:pointer-events-none transition-colors ${
    compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'
  }`
  const iconCls = compact ? 'w-2.5 h-2.5' : 'w-3 h-3'
  const spinner = <Loader2 className={`${iconCls} animate-spin`} aria-hidden />

  const linkChip = decision.prUrl ? (
    <a
      href={decision.prUrl}
      target="_blank"
      rel="noreferrer"
      data-testid="rail-pr-link"
      title={t('railPr.openPrTitle')}
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-1 rounded-md font-mono border border-accent-info/30 bg-accent-info/10 text-accent-info hover:bg-accent-info/20 hover:border-accent-info/60 transition-colors ${
        compact ? 'px-1 py-0.5 text-[9px]' : 'px-1.5 py-0.5 text-[10px]'
      }`}
    >
      {decision.prNumber != null ? `#${decision.prNumber}` : t('railPr.prLinkFallback')}
      <ExternalLink className={compact ? 'w-2 h-2' : 'w-2.5 h-2.5'} aria-hidden />
    </a>
  ) : null

  const discardBtn = (
    <button
      type="button"
      data-testid="rail-pr-discard"
      disabled={inFlight !== null}
      title={t('railPr.discardTooltip')}
      onClick={(e) => { e.stopPropagation(); setConfirmDiscard(true) }}
      className={ghostBtn}
    >
      {inFlight === 'discard' ? spinner : null}
      {t('railPr.discard')}
    </button>
  )

  // Remote-less acceptance: integrate the delivered branches into the base
  // branch locally. Offered wherever no real PR exists yet (on_review,
  // degraded draft, pr_failed) — the GitHub-less journey's way to say "yes".
  const mergeLocalBtn = (
    <button
      type="button"
      data-testid="rail-pr-merge-local"
      disabled={inFlight !== null}
      title={t('railPr.mergeLocalTooltip', { base: decision.baseBranch })}
      onClick={(e) => { e.stopPropagation(); setConfirmMergeLocal(true) }}
      className={`inline-flex items-center gap-1 rounded-md font-medium border border-accent-success/40 bg-accent-success/10 text-accent-success hover:bg-accent-success/20 disabled:opacity-50 disabled:pointer-events-none transition-colors ${
        compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'
      }`}
    >
      {inFlight === 'merge-local' ? spinner : <GitMerge className={iconCls} aria-hidden />}
      {t('railPr.mergeLocal')}
    </button>
  )

  const actionButton = (
    action: RailPrDecisionAction,
    expected: RailPrDecision,
    label: string,
    testId: string,
    title?: string,
    icon?: React.ReactNode,
  ) => (
    <button
      type="button"
      data-testid={testId}
      disabled={inFlight !== null}
      title={title}
      onClick={(e) => { e.stopPropagation(); void run(action, expected) }}
      className={primaryBtn}
    >
      {inFlight === action ? spinner : icon}
      {label}
    </button>
  )

  // ── per-state pill + actions ────────────────────────────────────────────────
  let pill: React.ReactNode = null
  let actions: React.ReactNode = null

  if (d === 'on_review') {
    pill = (
      <span className={`${pillBase} border-accent-warning/30 bg-accent-warning/10 text-accent-warning`}>
        <Eye className={iconCls} aria-hidden />
        {t('railPr.readyForReview')}
      </span>
    )
    actions = (
      <>
        {actionButton('create-pr', 'on_review', t('railPr.createPr'), 'rail-pr-create', t('railPr.createPrTooltip', { base: decision.baseBranch }), <GitPullRequest className={iconCls} aria-hidden />)}
        {mergeLocalBtn}
        {discardBtn}
      </>
    )
  } else if (d === 'pr_draft' && decision.prUrl) {
    pill = (
      <span className={`${pillBase} border-accent-info/30 bg-accent-info/10 text-accent-info`}>
        <GitPullRequest className={iconCls} aria-hidden />
        {t('railPr.draftPr')}
      </span>
    )
    actions = (
      <>
        {linkChip}
        {actionButton('publish', 'pr_draft', t('railPr.publish'), 'rail-pr-publish', t('railPr.publishTooltip'))}
        {discardBtn}
      </>
    )
  } else if (d === 'pr_draft') {
    // Degraded delivery: branch pushed (or kept local) but no PR exists — the
    // only ways forward are retrying the PR creation or discarding.
    pill = (
      <span className={`${pillBase} border-accent-warning/30 bg-accent-warning/10 text-accent-warning`} title={t('railPr.branchPushedHint')}>
        <AlertTriangle className={iconCls} aria-hidden />
        {t('railPr.branchPushed')}
      </span>
    )
    actions = (
      <>
        {actionButton('create-pr', 'pr_draft', t('railPr.retryPr'), 'rail-pr-create', t('railPr.createPrTooltip', { base: decision.baseBranch }))}
        {mergeLocalBtn}
        {discardBtn}
      </>
    )
  } else if (d === 'pr_ready') {
    pill = (
      <span className={`${pillBase} border-accent-success/30 bg-accent-success/10 text-accent-success`}>
        <GitMerge className={iconCls} aria-hidden />
        {t('railPr.prReady')}
      </span>
    )
    actions = (
      <>
        {linkChip}
        {actionButton('poll-merge', 'pr_ready', t('railPr.checkMerge'), 'rail-pr-poll', t('railPr.checkMergeTooltip'))}
        {discardBtn}
      </>
    )
  } else if (d === 'pr_failed') {
    pill = (
      <span className={`${pillBase} border-destructive/30 bg-destructive/10 text-destructive`}>
        <AlertTriangle className={iconCls} aria-hidden />
        {t('railPr.prFailed')}
      </span>
    )
    actions = (
      <>
        {actionButton('create-pr', 'pr_failed', t('railPr.retry'), 'rail-pr-create', t('railPr.createPrTooltip', { base: decision.baseBranch }))}
        {mergeLocalBtn}
        {discardBtn}
      </>
    )
  }

  return (
    <div
      data-testid="rail-pr-strip"
      data-decision={d}
      className={`flex items-center flex-wrap animate-in fade-in slide-in-from-top-1 duration-200 ${compact ? 'gap-1' : 'gap-1.5'}`}
      onClick={(e) => e.stopPropagation()}
    >
      {pill}
      {actions}

      {/* Merge-local confirmation — it writes merge commits into the user's
          checkout of the base branch. Constructive but repo-touching. */}
      <Dialog open={confirmMergeLocal} onOpenChange={setConfirmMergeLocal}>
        <DialogContent className="max-w-sm" data-testid="rail-pr-merge-local-confirm">
          <DialogHeader>
            <DialogTitle>{t('railPr.mergeLocalConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('railPr.mergeLocalConfirmBody', { base: decision.baseBranch })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmMergeLocal(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              size="sm"
              data-testid="rail-pr-merge-local-confirm-btn"
              onClick={() => { setConfirmMergeLocal(false); void run('merge-local', d) }}
            >
              {t('railPr.mergeLocal')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Discard confirmation — destructive: branches + worktrees are dropped. */}
      <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <DialogContent className="max-w-sm" data-testid="rail-pr-discard-confirm">
          <DialogHeader>
            <DialogTitle>{t('railPr.discardConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('railPr.discardConfirmBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDiscard(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              data-testid="rail-pr-discard-confirm-btn"
              onClick={() => { setConfirmDiscard(false); void run('discard', d) }}
            >
              {t('railPr.discard')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
