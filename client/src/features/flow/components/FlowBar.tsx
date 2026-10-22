// ─── Flow bar ─────────────────────────────────────────────────────────────────
// Sticky strip above the composer while a Flow is open: branch, files changed,
// real cost (provider-billed turns only; "—" when nothing is priced) and the
// controls. Controls are DATA (FlowBarControl[]) so new ones slot in without
// touching the layout. Paused and needs-review Flows render compact variants.
// While the Flow's app runs (started by the agent through Specrails), a
// Preview control opens it (FlowAppPreview).

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { motion, useReducedMotion } from 'motion/react'
import { AlertTriangle, Check, Copy, FileDiff, GitBranch, Loader2, Pause, Play, Trash2, Waves, type LucideIcon } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { useAgentChat } from '../../missions/context/AgentChatContext'
import { useFlowContext } from '../context/FlowContext'
import { flowApi, FlowApiError, type Flow, type FlowCost, type FlowDiff } from '../lib/flow-api'
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

function ControlButton({ control, compact }: { control: FlowBarControl; compact: boolean }) {
  const Icon = control.busy ? Loader2 : control.icon
  return (
    <button
      type="button"
      data-agent-interactive
      data-testid={`flow-bar-${control.id}`}
      onClick={control.onSelect}
      disabled={control.disabled || control.busy}
      aria-label={control.label}
      title={control.label}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-info disabled:cursor-not-allowed disabled:opacity-50',
        control.tone === 'primary' && 'bg-accent-info px-2.5 text-background shadow hover:opacity-90',
        control.tone === 'danger' && 'text-foreground/60 hover:bg-destructive/10 hover:text-destructive',
        (!control.tone || control.tone === 'default') && 'text-foreground/70 hover:bg-surface hover:text-foreground',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5', control.busy && 'animate-spin')} aria-hidden />
      <span className={cn(compact && control.tone !== 'primary' && 'sr-only')}>{control.label}</span>
    </button>
  )
}

export function FlowBar({ projectId, flow, inline }: { projectId: string; flow: Flow; inline: boolean }) {
  const { t } = useTranslation('agent')
  const reduced = useReducedMotion()
  const ctx = useFlowContext()
  const { isStreaming } = useAgentChat()
  const working = isStreaming && flow.state === 'active'
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
      toast.error(error instanceof FlowApiError ? t(`flow.errors.${error.code}`, { defaultValue: error.detail || error.code }) : t('flow.errors.generic'))
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
  const controls: FlowBarControl[] = needsReview ? [] : [
    { id: 'changes', label: t('flow.bar.viewChanges'), icon: FileDiff, onSelect: () => setChangesOpen(true) },
    paused
      ? { id: 'resume', label: t('flow.bar.resume'), icon: Play, onSelect: () => void run('resume'), busy: busy === 'resume', disabled: settling, tone: 'primary' }
      : { id: 'pause', label: t('flow.bar.pause'), icon: Pause, onSelect: () => void run('pause'), busy: busy === 'pause', disabled: settling },
    { id: 'discard', label: t('flow.bar.discard'), icon: Trash2, onSelect: () => setDiscardOpen(true), tone: 'danger', disabled: settling || !!busy },
    { id: 'this-is-it', label: t('flow.bar.thisIsIt'), icon: Check, onSelect: () => ctx?.setWrappingUp(flow.id, true), tone: paused ? 'default' : 'primary', disabled: settling || !!busy || flow.ticketId === null },
  ]

  const costView = flowCostDisplay(cost)
  const totals = diff?.totals
  const compact = !inline

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: 8, transition: { duration: 0.18 } }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      role="region"
      aria-label={t('flow.bar.label')}
      data-testid="flow-bar"
      data-flow-state={flow.state}
      className={cn('shrink-0 px-3 pb-2', inline && 'mx-auto w-full max-w-[960px] px-4')}
    >
      <div className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border px-2.5 py-1.5 backdrop-blur',
        needsReview ? 'border-accent-warning/40 bg-accent-warning/10' : paused ? 'border-border/60 bg-surface/50' : 'border-accent-info/35 bg-accent-info/[0.07]',
      )}>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-foreground/85">
          {needsReview
            ? <AlertTriangle className="h-3.5 w-3.5 text-accent-warning" aria-hidden />
            : paused
              ? <Waves className="h-3.5 w-3.5 text-foreground/50" aria-hidden />
              : <span className="flow-live-dot inline-block h-2 w-2 rounded-full" data-busy={working} aria-hidden />}
          {t(`flow.bar.state.${flow.state}`, { defaultValue: t('flow.bar.state.active') })}
        </span>
        {flow.branch && (
          <button type="button" onClick={copyBranch} title={t('git.copyBranch')} data-agent-interactive className="inline-flex min-w-0 max-w-[14rem] items-center gap-1 rounded-md px-1 py-0.5 font-mono text-[11px] text-foreground/65 hover:bg-surface hover:text-foreground">
            <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{flow.branch}</span>
            <Copy className="h-2.5 w-2.5 shrink-0 opacity-50" aria-hidden />
          </button>
        )}
        {!needsReview && (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-foreground/60" data-testid="flow-bar-stats">
            <span title={t('flow.bar.filesTitle')}>{t('flow.bar.files', { count: totals?.files ?? 0 })}</span>
            {totals && totals.files > 0 && (
              <>
                <span className="text-accent-success">+{totals.additions}</span>
                <span className="text-destructive">−{totals.deletions}</span>
              </>
            )}
            <span aria-hidden className="text-foreground/25">·</span>
            <span data-testid="flow-bar-cost" title={costView.partial ? t('flow.bar.costPartial', { count: cost?.unpricedTurns ?? 0 }) : t('flow.bar.costTitle')}>
              {costView.usd ?? '—'}{costView.partial && costView.usd ? '*' : ''}
            </span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5" role="toolbar" aria-label={t('flow.bar.controls')}>
          {flow.state === 'active' && <FlowAppPreview flow={flow} compact={compact} />}
          {controls.map((control) => <ControlButton key={control.id} control={control} compact={compact} />)}
        </div>
        {(paused || needsReview) && (
          <p className="basis-full text-[11px] leading-4 text-foreground/55" data-testid="flow-bar-note">
            {needsReview ? t('flow.bar.needsReview') : t('flow.bar.pausedNote')}
          </p>
        )}
      </div>
      {changesOpen && <FlowChangesDialog projectId={projectId} flow={flow} initial={diff} onClose={() => setChangesOpen(false)} />}
      <FlowDiscardDialog open={discardOpen} busy={busy === 'discard'} onOpenChange={setDiscardOpen} onConfirm={() => void run('discard')} />
    </motion.div>
  )
}
