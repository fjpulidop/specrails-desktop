// ─── Flow in the mission's run strip ─────────────────────────────────────────
// While a Flow is open, the run strip above the composer IS the Flow bar: the
// status mark and "Flow" on the left, then the worktree branch (copyable — the
// git strip steps aside), files changed (a button that opens the changes),
// real cost (provider-billed turns only; "—" when nothing is priced) and the
// controls. Controls are DATA (FlowBarControl[]) so new ones slot in without
// touching the layout; the destructive Discard sits apart from the primary
// "This is it", and a disabled control says why. Paused and needs-review Flows
// add a one-line note. While the Flow's app runs (started by the agent through
// Specrails), a Preview control opens it (FlowAppPreview).

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Copy, FileDiff, GitBranch, Loader2, Pause, Play, Trash2, type LucideIcon } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { RUN_STRIP_PRIMARY } from '../../missions/components/AgentRunStrip'
import { useFlowContext } from '../context/FlowContext'
import { flowApi, type Flow, type FlowCost, type FlowDiff } from '../lib/flow-api'
import { flowErrorMessage } from '../lib/flow-failure'
import { flowCostDisplay } from '../lib/flow-offer'
import { FlowAppPreview } from './FlowAppPreview'
import { FlowChangesDialog } from './FlowChangesDialog'
import { FlowDiscardDialog } from './FlowDiscardDialog'

export interface FlowBarControl {
  id: string
  label: string
  icon: LucideIcon
  onSelect: () => void
  tone?: 'default' | 'primary' | 'danger'
  disabled?: boolean
  /** Why the control is disabled (tooltip + aria-describedby). */
  disabledReason?: string | null
  busy?: boolean
}

/** Live diff + cost of a Flow: refreshed on state changes, when a turn
 *  settles and every 8 s while the agent works. */
export function useFlowLiveStats(projectId: string, flow: Flow, working: boolean) {
  const [diff, setDiff] = useState<FlowDiff | null>(null)
  const [cost, setCost] = useState<FlowCost | null>(null)
  const version = useRef(0)
  const refresh = useCallback(() => {
    const mine = ++version.current
    void flowApi.diff(projectId, flow.id).then((value) => { if (version.current === mine) setDiff(value) }, () => undefined)
    void flowApi.cost(projectId, flow.id).then((value) => { if (version.current === mine) setCost(value) }, () => undefined)
  }, [projectId, flow.id])
  useEffect(() => { refresh() }, [refresh, flow.state, flow.updatedAt])
  const wasWorking = useRef(working)
  useEffect(() => {
    if (wasWorking.current && !working) refresh()
    wasWorking.current = working
    if (!working) return
    const timer = window.setInterval(refresh, 8000)
    return () => window.clearInterval(timer)
  }, [working, refresh])
  return { diff, cost, refresh }
}

function ControlButton({ control, compact, flowId }: { control: FlowBarControl; compact: boolean; flowId: string }) {
  const Icon = control.busy ? Loader2 : control.icon
  const reason = control.disabled && !control.busy ? control.disabledReason ?? null : null
  const reasonId = reason ? `flow-bar-${flowId}-${control.id}-reason` : undefined
  return (
    <button
      type="button"
      data-agent-interactive
      data-testid={`flow-bar-${control.id}`}
      onClick={control.onSelect}
      disabled={control.disabled || control.busy}
      aria-label={control.label}
      aria-describedby={reasonId}
      title={reason ? `${control.label} — ${reason}` : control.label}
      className={cn(
        control.tone === 'primary'
          ? RUN_STRIP_PRIMARY
          : 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50 disabled:cursor-not-allowed disabled:opacity-50',
        control.tone === 'danger' && 'text-foreground/60 hover:bg-destructive/10 hover:text-destructive',
        (!control.tone || control.tone === 'default') && 'text-foreground/70 hover:bg-surface hover:text-foreground',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5', control.busy && 'animate-spin')} aria-hidden />
      <span className={cn(compact && control.tone !== 'primary' && 'sr-only')}>{control.label}</span>
      {reason && <span id={reasonId} className="sr-only" data-testid={`flow-bar-${control.id}-reason`}>{reason}</span>}
    </button>
  )
}

/** The Flow's strip controls: branch, files ±, cost, Discard apart, Preview, Pause/Resume, "This is it". */
export function FlowStripControls({ projectId, flow, inline, working }: { projectId: string; flow: Flow; inline: boolean; working: boolean }) {
  console.count("CONTROLS")
  const { t } = useTranslation('agent')
  const ctx = useFlowContext()
  const { diff, cost } = useFlowLiveStats(projectId, flow, working)
  const [busy, setBusy] = useState<'pause' | 'resume' | 'discard' | null>(null)
  const [changesOpen, setChangesOpen] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const settling = flow.step !== null

  const run = async (kind: 'pause' | 'resume' | 'discard') => {
    if (!ctx || busy) return
    setBusy(kind)
    try {
      await ctx[kind](projectId, flow)
      if (kind === 'discard') { setDiscardOpen(false); toast.success(t('flow.bar.discarded')) }
    } catch (error) {
      // Localized by code; the server's own detail is only the secondary line.
      const { message, detail } = flowErrorMessage(t, error)
      toast.error(message, detail ? { description: detail } : undefined)
    } finally {
      setBusy(null)
    }
  }

  const copyBranch = () => {
    if (!flow.branch) return
    void navigator.clipboard?.writeText(flow.branch).then(() => toast.success(t('git.branchCopied')), () => undefined)
  }

  const paused = flow.state === 'paused'
  const needsReview = flow.state === 'needs-review'
  // Why an action waits, in the person's words (never a silent disabled button).
  const waitReason = settling ? t('flow.bar.disabled.settling') : busy ? t('flow.bar.disabled.busy') : null
  const handOffReason = waitReason ?? (flow.ticketId === null ? t('flow.bar.disabled.noSpec') : null)
  // Discard stands apart (leading group); the primary action closes the row.
  const destructive: FlowBarControl[] = needsReview ? [] : [
    { id: 'discard', label: t('flow.bar.discard'), icon: Trash2, onSelect: () => setDiscardOpen(true), tone: 'danger', disabled: settling || !!busy, disabledReason: waitReason },
  ]
  const controls: FlowBarControl[] = needsReview ? [] : [
    paused
      ? { id: 'resume', label: t('flow.bar.resume'), icon: Play, onSelect: () => void run('resume'), busy: busy === 'resume', disabled: settling, disabledReason: waitReason, tone: 'primary' }
      : { id: 'pause', label: t('flow.bar.pause'), icon: Pause, onSelect: () => void run('pause'), busy: busy === 'pause', disabled: settling, disabledReason: waitReason },
    { id: 'this-is-it', label: t('flow.bar.thisIsIt'), icon: Check, onSelect: () => ctx?.setWrappingUp(flow.id, true), tone: paused ? 'default' : 'primary', disabled: !!handOffReason, disabledReason: handOffReason },
  ]

  const costView = flowCostDisplay(cost)
  const totals = diff?.totals
  const compact = !inline
  const filesLabel = t('flow.bar.files', { count: totals?.files ?? 0 })

  return (
    <>
      {flow.branch && (
        <button type="button" onClick={copyBranch} title={t('git.copyBranch')} aria-label={`${t('git.copyBranch')}: ${flow.branch}`} data-agent-interactive data-testid="flow-bar-branch" className="inline-flex min-w-0 max-w-[14rem] items-center gap-1 rounded-md px-1 py-0.5 font-mono text-[11px] text-foreground/65 hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50">
          <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{flow.branch}</span>
          <Copy className="h-2.5 w-2.5 shrink-0 opacity-50" aria-hidden />
        </button>
      )}
      {!needsReview && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-foreground/60" data-testid="flow-bar-stats">
          <button
            type="button"
            data-agent-interactive
            data-testid="flow-bar-changes"
            onClick={() => setChangesOpen(true)}
            title={t('flow.bar.filesTitle')}
            aria-label={totals && totals.files > 0
              ? t('flow.bar.viewChangesStats', { files: filesLabel, additions: totals.additions, deletions: totals.deletions })
              : `${t('flow.bar.viewChanges')} · ${filesLabel}`}
            className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50"
          >
            <FileDiff className="h-3 w-3 shrink-0" aria-hidden />
            <span>{filesLabel}</span>
            {totals && totals.files > 0 && (
              <>
                <span className="text-accent-success">+{totals.additions}</span>
                <span className="text-destructive">−{totals.deletions}</span>
              </>
            )}
          </button>
          <span aria-hidden className="text-foreground/25">·</span>
          <span data-testid="flow-bar-cost" title={costView.partial ? t('flow.bar.costPartial', { count: cost?.unpricedTurns ?? 0 }) : t('flow.bar.costTitle')}>
            {costView.usd ?? '—'}{costView.partial && costView.usd ? '*' : ''}
          </span>
        </span>
      )}
      {(destructive.length > 0 || controls.length > 0) && (
        <div className="flex items-center gap-0.5" role="toolbar" aria-label={t('flow.bar.controls')}>
          {destructive.map((control) => <ControlButton key={control.id} control={control} compact={compact} flowId={flow.id} />)}
          {destructive.length > 0 && <span aria-hidden className="mx-1 h-4 w-px bg-border/70" data-testid="flow-bar-separator" />}
          {flow.state === 'active' && <FlowAppPreview flow={flow} compact={compact} />}
          {controls.map((control) => <ControlButton key={control.id} control={control} compact={compact} flowId={flow.id} />)}
        </div>
      )}
      {(paused || needsReview) && (
        <p className="basis-full px-1.5 pb-0.5 text-[11px] leading-4 text-foreground/55" data-testid="flow-bar-note">
          {needsReview ? t('flow.bar.needsReview') : t('flow.bar.pausedNote')}
        </p>
      )}
      {changesOpen && <FlowChangesDialog projectId={projectId} flow={flow} initial={diff} onClose={() => setChangesOpen(false)} />}
      <FlowDiscardDialog open={discardOpen} busy={busy === 'discard'} branch={flow.branch} totals={totals ?? null} onOpenChange={setDiscardOpen} onConfirm={() => void run('discard')} />
    </>
  )
}
