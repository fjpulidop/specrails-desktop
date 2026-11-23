/**
 * Run-level controls of a PR decision card: relaunching the rail slot,
 * repeating only the settlement of a blocked delivery, resuming a run paused
 * on the daily budget (with the per-run cap choice) and stopping a paused run.
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { notifyError } from '../../../../lib/notify-error'
import { openBudgetPanel } from '../../../../lib/app-settings-events'
import { API_ORIGIN } from '../../../../lib/origin'
import { dailyBudgetActionMessage, dailyBudgetExceededMessage, dailyBudgetStillExceededMessage, readDailyBudgetRejection, type DailyBudgetInfo } from '../../../../lib/daily-budget'
import type { RunCapChoice } from '../../../../lib/run-cap'
import { readReviewWipRejection, reviewWipActionMessage, reviewWipRejectionMessage } from '../../../../lib/review-wip'
import { cancelJob } from '../../../jobs/lib/cancel-job'
import { notifyGitChanged } from '../../../code/lib/git-refresh'
import type { AgentPrDecisionEnvelope } from '../../lib/agent-api'

export function useRunControls(args: {
  envelope: AgentPrDecisionEnvelope
  conversationId: string | null | undefined
  /** Any card action in flight (read at call time, set by the card each render). */
  anyBusyRef: MutableRefObject<boolean>
}) {
  const { envelope, conversationId, anyBusyRef } = args
  const { t } = useTranslation('agent')
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null)
  const [relaunching, setRelaunching] = useState(false)
  const [retryingDelivery, setRetryingDelivery] = useState(false)
  const relaunchInFlight = useRef(false)
  const [relaunchAccepted, setRelaunchAccepted] = useState(false)
  const [relaunchError, setRelaunchError] = useState<string | null>(null)
  useEffect(() => { setRelaunchAccepted(false); setRelaunchError(null) }, [envelope.prDeliveryId])

  // budget_paused runs resume in place once the budget allows the next step;
  // still over budget ⇒ the shared 409 body, shown localized.
  const [resumingBudgetRunId, setResumingBudgetRunId] = useState<string | null>(null)
  const [runCapPrompt, setRunCapPrompt] = useState<{ runId: string; budget: DailyBudgetInfo } | null>(null)
  const resumeBudgetPausedRun = async (runId: string, choice?: RunCapChoice) => {
    if (resumingBudgetRunId) return
    setResumingBudgetRunId(runId)
    try {
      const res = await fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(envelope.projectId)}/loop-runs/${encodeURIComponent(runId)}/resume`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(choice ?? {}),
      })
      if (res.ok) return
      const body = await res.json().catch(() => null)
      const budget = readDailyBudgetRejection(body)
      // The run's per-run soft cap stands: the person answers Continue / Raise.
      if (budget?.period === 'run') setRunCapPrompt({ runId, budget })
      else if (budget) {
        notifyError(dailyBudgetStillExceededMessage(t, budget), {
          detail: dailyBudgetActionMessage(t, budget),
          action: { label: t('common:budget.raiseCap'), onClick: openBudgetPanel },
        })
      } else notifyError(t('runCard.relaunchFailed'), { detail: (body as { error?: string } | null)?.error, retry: () => void resumeBudgetPausedRun(runId, choice) })
    } catch (e) {
      notifyError(t('runCard.relaunchFailed'), { detail: e instanceof Error ? e.message : undefined, retry: () => void resumeBudgetPausedRun(runId, choice) })
    } finally {
      setResumingBudgetRunId(null)
    }
  }

  const stopPausedRun = async (runId: string) => {
    if (stoppingRunId) return
    setStoppingRunId(runId)
    try {
      const outcome = await cancelJob({ projectId: envelope.projectId, jobId: runId, kind: 'loop-run' })
      if (outcome.ok) {
        toast.info(t('prCard.stopExecutionSent'))
      } else {
        notifyError(t('prCard.stopExecutionFailed'), { detail: outcome.error, retry: () => void stopPausedRun(runId) })
      }
    } finally {
      setStoppingRunId(null)
    }
  }

  /** Identify this attempt: the slot's assignments/config can already have
   * changed or been released. The server resolves and revalidates the source. */
  const relaunch = async () => {
    if (relaunchInFlight.current || relaunchAccepted || anyBusyRef.current) return
    relaunchInFlight.current = true
    setRelaunching(true)
    setRelaunchError(null)
    try {
      const res = await fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(envelope.projectId)}/rails/${envelope.railIndex}/relaunch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceId: envelope.prDeliveryId,
          ...(conversationId ? { originConversationId: conversationId, originSurface: 'agent-chat' } : {}),
        }),
      })
      if (res.status === 202) {
        setRelaunchAccepted(true)
        toast.success(t('runCard.relaunchSent', { index: envelope.railIndex + 1 }))
        notifyGitChanged(envelope.projectId)
        return
      }
      const body = await res.json().catch(() => ({})) as { error?: string; detail?: string; action?: string }
      const budget = readDailyBudgetRejection(body)
      const wip = readReviewWipRejection(body)
      const detail = budget
        ? `${dailyBudgetExceededMessage(t, budget)} — ${dailyBudgetActionMessage(t, budget)}`
        : wip
          ? `${reviewWipRejectionMessage(t, wip)} — ${reviewWipActionMessage(t)}`
          : [body.detail ?? body.error, body.action].filter(Boolean).join(' — ') || t('runCard.relaunchFailed')
      setRelaunchError(detail)
      notifyError(t('runCard.relaunchFailed'), { detail, retry: () => void relaunch() })
    } catch (e) {
      const detail = e instanceof Error ? e.message : t('runCard.relaunchFailed')
      setRelaunchError(detail)
      notifyError(t('runCard.relaunchFailed'), { detail, retry: () => void relaunch() })
    } finally {
      relaunchInFlight.current = false
      setRelaunching(false)
    }
  }

  // A blocked delivery whose run finished: repeat ONLY the settlement (commit,
  // push, PR) on the run's own worktree. No AI work is redone.
  const settlementRunId = (envelope.runIds ?? []).length === 1 ? envelope.runIds![0] : null
  const retryDelivery = async () => {
    if (!settlementRunId || retryingDelivery) return
    setRetryingDelivery(true)
    try {
      const res = await fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(envelope.projectId)}/loop-runs/${encodeURIComponent(settlementRunId)}/resume`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      if (res.ok) { toast.success(t('prCard.retryDeliverySent')); return }
      const body = await res.json().catch(() => null) as { error?: string; detail?: string } | null
      notifyError(t('prCard.retryDeliveryFailed'), { detail: body?.detail ?? body?.error, retry: () => void retryDelivery() })
    } catch (e) {
      notifyError(t('prCard.retryDeliveryFailed'), { detail: e instanceof Error ? e.message : undefined, retry: () => void retryDelivery() })
    } finally {
      setRetryingDelivery(false)
    }
  }

  return {
    relaunching, relaunchAccepted, relaunchError, relaunch,
    settlementRunId, retryingDelivery, retryDelivery,
    resumingBudgetRunId, runCapPrompt, setRunCapPrompt, resumeBudgetPausedRun,
    stoppingRunId, stopPausedRun,
  }
}
