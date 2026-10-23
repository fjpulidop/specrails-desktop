// ─── Flow in the mission's run strip ─────────────────────────────────────────
// While a Flow is open, its strip row stays short: the status mark and
// "Flow · 7 files" (inside the strip's expand toggle), then Pause (or Resume)
// and the primary **Hand off**. Everything else lives in the Flow's panel,
// opened with the same chevron as any other run: the Flow branch (copyable —
// the git strip steps aside), files changed ± (a button that opens the
// changes), real cost (provider-billed turns only; "—" when nothing is
// priced, `*` plus a visible note when some turns are unpriced), Preview
// while the Flow's app runs, and Discard set apart. Controls are DATA
// (FlowBarControl[]) so new ones slot in without touching the layout; a
// disabled control says why.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

export interface FlowLiveStats {
  diff: FlowDiff | null
  cost: FlowCost | null
  refresh: () => void
}

function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/** Live diff + cost of a Flow: refreshed on state changes, when a turn
 *  settles and every 8 s while the agent works AND the page is visible.
 *  Inert without a Flow. */
export function useFlowLiveStats(projectId: string | null, flow: Flow | null, working: boolean): FlowLiveStats {
  const [diff, setDiff] = useState<FlowDiff | null>(null)
  const [cost, setCost] = useState<FlowCost | null>(null)
  const version = useRef(0)
  const flowId = flow?.id ?? null
  const refresh = useCallback(() => {
    if (!projectId || !flowId) return
    const mine = ++version.current
    void flowApi.diff(projectId, flowId).then((value) => { if (version.current === mine) setDiff(value) }, () => undefined)
    void flowApi.cost(projectId, flowId).then((value) => { if (version.current === mine) setCost(value) }, () => undefined)
  }, [projectId, flowId])
  useEffect(() => {
    if (!flowId) { setDiff(null); setCost(null) }
  }, [flowId])
  useEffect(() => { refresh() }, [refresh, flow?.state, flow?.updatedAt])
  const wasWorking = useRef(working)
  const [visible, setVisible] = useState(pageVisible)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onChange = (): void => setVisible(pageVisible())
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  useEffect(() => {
    if (wasWorking.current && !working) refresh()
    wasWorking.current = working
    if (!working || !visible) return
    const timer = window.setInterval(refresh, 8000)
    return () => window.clearInterval(timer)
  }, [working, visible, refresh])
  return useMemo(() => ({ diff, cost, refresh }), [diff, cost, refresh])
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
      title={reason ? `${control.label}: ${reason}` : control.label}
      className={cn(
        control.tone === 'primary'
          ? RUN_STRIP_PRIMARY
          : 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50 disabled:cursor-not-allowed disabled:opacity-50',
        control.tone === 'danger' && 'text-foreground/75 hover:bg-destructive/10 hover:text-destructive',
        (!control.tone || control.tone === 'default') && 'text-foreground/80 hover:bg-surface hover:text-foreground',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5', control.busy && 'animate-spin')} aria-hidden />
      <span className={cn(compact && control.tone !== 'primary' && 'sr-only')}>{control.label}</span>
      {reason && <span id={reasonId} className="sr-only" data-testid={`flow-bar-${control.id}-reason`}>{reason}</span>}
    </button>
  )
}

type Busy = 'pause' | 'resume' | 'discard' | null

function useFlowAction(projectId: string, flow: Flow) {
  const { t } = useTranslation('agent')
  const ctx = useFlowContext()
  const [busy, setBusy] = useState<Busy>(null)
  const run = async (kind: Exclude<Busy, null>): Promise<boolean> => {
    if (!ctx || busy) return false
    setBusy(kind)
    try {
      await ctx[kind](projectId, flow)
      if (kind === 'discard') toast.success(t('flow.bar.discarded'))
      return true
    } catch (error) {
      // Localized by code; the server's own detail is only the secondary line.
      const { message, detail } = flowErrorMessage(t, error)
      toast.error(message, detail ? { description: detail } : undefined)
      return false
    } finally {
      setBusy(null)
    }
  }
  return { busy, run, ctx }
}

/** The Flow's strip row controls: Pause / Resume and the primary **Hand off**. */
export function FlowStripControls({ projectId, flow, inline }: { projectId: string; flow: Flow; inline: boolean }) {
  const { t } = useTranslation('agent')
  const { busy, run, ctx } = useFlowAction(projectId, flow)
  if (flow.state === 'needs-review') return null
  const settling = flow.step !== null
  const paused = flow.state === 'paused'
  // Why an action waits, in the person's words (never a silent disabled button).
  const waitReason = settling ? t('flow.bar.disabled.settling') : busy ? t('flow.bar.disabled.busy') : null
  const handOffReason = waitReason ?? (flow.ticketId === null ? t('flow.bar.disabled.noSpec') : null)
  const controls: FlowBarControl[] = [
    paused
      ? { id: 'resume', label: t('flow.bar.resume'), icon: Play, onSelect: () => void run('resume'), busy: busy === 'resume', disabled: settling, disabledReason: waitReason, tone: 'primary' }
      : { id: 'pause', label: t('flow.bar.pause'), icon: Pause, onSelect: () => void run('pause'), busy: busy === 'pause', disabled: settling, disabledReason: waitReason },
    { id: 'hand-off', label: t('flow.bar.handOff'), icon: Check, onSelect: () => ctx?.setWrappingUp(flow.id, true), tone: paused ? 'default' : 'primary', disabled: !!handOffReason, disabledReason: handOffReason },
  ]
  return (
    <div className="flex items-center gap-0.5" role="toolbar" aria-label={t('flow.bar.controls')}>
      {controls.map((control) => <ControlButton key={control.id} control={control} compact={!inline} flowId={flow.id} />)}
    </div>
  )
}

/** "Flow · 7 files": the row's headline (with the count once the diff is known). */
export function flowStripHeadline(t: (key: string, options?: Record<string, unknown>) => string, flow: Flow, diff: FlowDiff | null): string {
  const state = t(`flow.bar.state.${flow.state}`, { defaultValue: t('flow.bar.state.active') })
  return diff ? t('flow.strip.headline', { state, files: t('flow.bar.files', { count: diff.totals.files }) }) : state
}

/** The Flow's panel: branch, files ±, cost, Preview, Discard and the state note. */
export function FlowPanel({ projectId, flow, stats }: { projectId: string; flow: Flow; stats: FlowLiveStats }) {
  const { t } = useTranslation('agent')
  const { busy, run } = useFlowAction(projectId, flow)
  const [changesOpen, setChangesOpen] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const settling = flow.step !== null
  const paused = flow.state === 'paused'
  const needsReview = flow.state === 'needs-review'
  const { diff, cost } = stats
  const totals = diff?.totals
  const costView = flowCostDisplay(cost)
  const filesLabel = t('flow.bar.files', { count: totals?.files ?? 0 })
  const waitReason = settling ? t('flow.bar.disabled.settling') : busy ? t('flow.bar.disabled.busy') : null
  const copyBranch = () => {
    if (!flow.branch) return
    void navigator.clipboard?.writeText(flow.branch).then(() => toast.success(t('git.branchCopied')), () => undefined)
  }
  const discard: FlowBarControl = {
    id: 'discard', label: t('flow.bar.discard'), icon: Trash2, onSelect: () => setDiscardOpen(true), tone: 'danger', disabled: settling || !!busy, disabledReason: waitReason,
  }
  const row = 'flex min-w-0 items-center gap-2 text-[12px]'
  const label = 'w-20 shrink-0 text-foreground/70'
  return (
    <div data-testid="flow-panel" className="space-y-2 px-0.5">
      {flow.branch && (
        <div className={row}>
          <span className={label}>{t('flow.panel.branch')}</span>
          <button type="button" onClick={copyBranch} title={t('git.copyBranch')} aria-label={`${t('git.copyBranch')}: ${flow.branch}`} data-agent-interactive data-testid="flow-bar-branch" className="inline-flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 font-mono text-[12px] text-foreground/85 hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50">
            <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{flow.branch}</span>
            <Copy className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
          </button>
        </div>
      )}
      {!needsReview && (
        <div className={row} data-testid="flow-bar-stats">
          <span className={label}>{t('flow.panel.changes')}</span>
          <button
            type="button"
            data-agent-interactive
            data-testid="flow-bar-changes"
            onClick={() => setChangesOpen(true)}
            title={t('flow.bar.filesTitle')}
            aria-describedby={`flow-bar-${flow.id}-files-hint`}
            aria-label={totals && totals.files > 0
              ? t('flow.bar.viewChangesStats', { files: filesLabel, additions: totals.additions, deletions: totals.deletions })
              : `${t('flow.bar.viewChanges')} · ${filesLabel}`}
            className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 tabular-nums text-foreground/85 transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50"
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
          <span id={`flow-bar-${flow.id}-files-hint`} hidden>{t('flow.bar.filesTitle')}</span>
        </div>
      )}
      {!needsReview && (
        <div className={cn(row, 'flex-wrap')}>
          <span className={label}>{t('flow.panel.cost')}</span>
          <span data-testid="flow-bar-cost" className="tabular-nums text-foreground/85" title={t('flow.bar.costTitle')}>
            {costView.usd ?? '—'}{costView.partial && costView.usd ? '*' : ''}
            {/* The tooltip's words for screen readers too. */}
            <span className="sr-only"> ({t('flow.bar.costTitle')})</span>
          </span>
          {costView.partial && costView.usd && (
            <span data-testid="flow-bar-cost-partial" className="min-w-0 text-foreground/70">
              * {t('flow.bar.costPartial', { count: cost?.unpricedTurns ?? 0 })}
            </span>
          )}
        </div>
      )}
      {(paused || needsReview) && (
        <p className="text-[12px] leading-4 text-foreground/75" data-testid="flow-bar-note">
          {needsReview ? t('flow.bar.needsReview') : t('flow.bar.pausedNote')}
        </p>
      )}
      {/* needs-review keeps nothing destructive: the person checks the branch first. */}
      {!needsReview && <div className="flex items-center gap-1 pt-0.5" role="toolbar" aria-label={t('flow.panel.actions')}>
        {flow.state === 'active' && <FlowAppPreview flow={flow} compact={false} />}
        <span className="flex-1" aria-hidden />
        <ControlButton control={discard} compact={false} flowId={flow.id} />
      </div>}
      {changesOpen && <FlowChangesDialog projectId={projectId} flow={flow} initial={diff} onClose={() => setChangesOpen(false)} />}
      <FlowDiscardDialog
        open={discardOpen}
        busy={busy === 'discard'}
        branch={flow.branch}
        totals={totals ?? null}
        onOpenChange={setDiscardOpen}
        onConfirm={() => { void run('discard').then((ok) => { if (ok) setDiscardOpen(false) }) }}
      />
    </div>
  )
}
