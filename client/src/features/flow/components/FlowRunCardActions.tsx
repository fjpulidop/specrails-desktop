// ─── Flow actions on a run/PR card (missions RunCardActions slot) ─────────────
// When Flow → Spec stopped before delivery (the review still requested
// changes, or the run itself failed), the card offers the two ways forward
// that keep the Flow's worktree:
//   - Back to Flow: the worktree returns to its Flow (same mount, the run's
//     changes intact), the spec is "In Flow" again and the agent receives the
//     review on its next turn.
//   - Relaunch: Flow → Spec again on the same worktree, rail and engine.
// Every other card gets nothing from this slot.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, RotateCcw, Undo2 } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { MissionRunCardActionsProps } from '../../missions/context/MissionExtensionsContext'
import { useFlowContext } from '../context/FlowContext'
import { FlowApiError } from '../lib/flow-api'

type Pending = 'return' | 'relaunch' | null

const BUTTON = 'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50'

export function FlowRunCardActions({ projectId, prDeliveryId, decision, busy }: MissionRunCardActionsProps) {
  const { t } = useTranslation('agent')
  const ctx = useFlowContext()
  const [pending, setPending] = useState<Pending>(null)
  const [error, setError] = useState<string | null>(null)
  if (!ctx || decision !== 'implementation_failed') return null

  const act = async (kind: Exclude<Pending, null>): Promise<void> => {
    if (pending) return
    setPending(kind)
    setError(null)
    try {
      if (kind === 'return') {
        await ctx.returnToFlow(projectId, prDeliveryId)
        toast.success(t('flow.review.returned'))
      } else {
        const result = await ctx.relaunch(projectId, prDeliveryId)
        toast.success(t('flow.review.relaunched', { index: (result.flow.railIndex ?? 0) + 1 }))
      }
    } catch (cause) {
      const detail = cause instanceof FlowApiError ? cause.detail ?? cause.code : cause instanceof Error ? cause.message : String(cause)
      setError(t(kind === 'return' ? 'flow.review.returnFailed' : 'flow.review.relaunchFailed', { detail }))
    } finally {
      setPending(null)
    }
  }

  const disabled = busy || pending !== null
  return (
    <>
      <button
        type="button"
        data-agent-interactive
        data-testid="flow-review-back-to-flow"
        disabled={disabled}
        title={t('flow.review.backToFlowHint')}
        onClick={() => void act('return')}
        className={cn(BUTTON, 'border-accent-primary/40 bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20')}
      >
        {pending === 'return' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
        {t('flow.review.backToFlow')}
      </button>
      <button
        type="button"
        data-agent-interactive
        data-testid="flow-review-relaunch"
        disabled={disabled}
        title={t('flow.review.relaunchHint')}
        onClick={() => void act('relaunch')}
        className={cn(BUTTON, 'border-border/60 bg-surface/60 text-foreground/75 hover:border-accent-info/40 hover:bg-accent-info/10 hover:text-accent-info')}
      >
        {pending === 'relaunch' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
        {t('flow.review.relaunch')}
      </button>
      {error && <p className="w-full text-[11px] leading-4 text-destructive" role="alert" data-testid="flow-review-error">{error}</p>}
    </>
  )
}
