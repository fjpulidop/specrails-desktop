/**
 * Live rail events from the shared WebSocket (`dashboard-rails` handler):
 * external launches, continuations, remote config changes, rail creation /
 * removal, worktree merge-back progress and terminal outcomes with toasts.
 * Messages are filtered by the active project through a ref.
 */
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { notifyError } from '../../../lib/notify-error'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { applyRailJobOutcome } from '../../rails/components/RailsBoard'
import { applyWorktreeProgress, type RailWorktreeMap, type WorktreeState } from '../../rails/lib/worktree-progress'
import { railIdFromIndex } from '../../rails/lib/rail-id'
import type { RailPrStateSnapshot } from '../../../types'
import { toRailMode } from '../lib/board-rails'
import type { RailsUpdater } from './useBoardRails'

export function useRailWsEvents(opts: {
  activeProjectId: string | null
  updateRails: RailsUpdater
  setRailWorktrees: Dispatch<SetStateAction<RailWorktreeMap>>
  railPrDecisions: ReadonlyMap<number, RailPrStateSnapshot>
}) {
  const { activeProjectId, updateRails, setRailWorktrees, railPrDecisions } = opts
  const { t } = useTranslation('dashboard')
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const activeProjectIdRef = useRef(activeProjectId)
  useEffect(() => { activeProjectIdRef.current = activeProjectId }, [activeProjectId])
  // Recovery links of the rail toasts read these through refs: the WS handler must not re-register on every route change.
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  const railPrDecisionsRef = useRef(railPrDecisions)
  railPrDecisionsRef.current = railPrDecisions

  const handleRailWsMessage = useCallback((msg: unknown) => {
    const m = msg as {
      type?: string; projectId?: string; railIndex?: number | null; status?: string
      ticketIds?: number[]; changed?: 'tickets' | 'name' | 'profile' | 'engine'; name?: string | null
      mode?: string; jobId?: string; loopRunId?: string; active?: boolean
    }
    if (m.projectId !== activeProjectIdRef.current) return
    const openJobAction = (jobId: string | undefined) => jobId
      ? { label: t('toasts.openJob'), onClick: () => navigateRef.current(`/jobs/${encodeURIComponent(jobId)}`) }
      : undefined
    if (m.type === 'runtime.continuation') {
      if (m.railIndex == null) return
      const railId = railIdFromIndex(m.railIndex)
      updateRails(prev => prev.map(r => r.id !== railId ? r : m.active
        ? { ...r, status: 'running' as const, activeJobId: m.jobId }
        : r.activeJobId === m.jobId ? { ...r, status: 'idle' as const, activeJobId: undefined } : r))
      return
    }

    // A rail started running ELSEWHERE — the MCP server, the mobile companion, or
    // another desktop tab. The local launch path (doLaunchRail) sets this
    // optimistically; mirror it for external launches so any rail the MCP starts
    // lights up here (status + the active id for "View Log"). Without this the
    // dashboard only ever reacted to the *completion* of an external launch, so
    // an MCP-launched rail looked idle the whole time it ran. Covers both the
    // legacy queue job (rail.job_started) and the loop run (loop.run_started)
    // paths; a loop run with railIndex==null is a Loops-page run, not a rail.
    if (m.type === 'rail.job_started' || m.type === 'loop.run_started') {
      if (m.railIndex == null) return
      const railId = railIdFromIndex(m.railIndex)
      const startedJobId = m.jobId ?? m.loopRunId
      updateRails((prev) => prev.map((r) =>
        r.id === railId ? { ...r, status: 'running' as const, activeJobId: startedJobId ?? r.activeJobId } : r
      ))
      return
    }

    // A rail's config changed elsewhere (mobile companion / another desktop).
    // Adopt the name on every variant; adopt ticketIds ONLY on a tickets-change
    // so a remote rename never wipes this client's locally-dragged assignments.
    // A railIndex this board doesn't know yet is a rail CREATED elsewhere (the
    // agent's create_rail, another window) — append its row live.
    if (m.type === 'rail.updated') {
      const idx = m.railIndex ?? 0
      const railId = railIdFromIndex(idx)
      const serverTicketIds = m.ticketIds ?? []
      const label = m.name ? `Rail ${m.name}` : `Rail ${idx + 1}`
      updateRails((prev) => {
        if (!prev.some((r) => r.id === railId)) {
          return [...prev, {
            id: railId,
            label,
            ticketIds: serverTicketIds,
            mode: toRailMode(m.mode) ?? 'implement',
            status: 'idle' as const,
          }]
        }
        return prev.map((r) => {
          if (r.id !== railId) return r
          // A running rail keeps its launched ticket set; still adopt the name.
          if (m.changed !== 'tickets' || r.status === 'running') return { ...r, label }
          return { ...r, label, ticketIds: serverTicketIds }
        })
      })
      return
    }

    // A rail was deleted elsewhere — drop the row (never a running one; the
    // server refuses to delete an active rail, so this is belt-and-braces).
    if (m.type === 'rail.removed') {
      if (m.railIndex == null) return
      const railId = railIdFromIndex(m.railIndex)
      updateRails((prev) => prev.filter((r) => r.id !== railId || r.status === 'running'))
      return
    }

    if (m.type === 'rail.worktree_progress') {
      const idx = m.railIndex ?? 0
      const ticketId = (m as { ticketId?: number }).ticketId
      const state = (m as { state?: WorktreeState }).state
      if (typeof ticketId === 'number' && state) {
        setRailWorktrees((prev) => applyWorktreeProgress(prev, idx, ticketId, state))
        if (state === 'needs-review') {
          let reviewPath: string | null = null
          for (const d of railPrDecisionsRef.current.values()) {
            if (d.ticketIds.includes(ticketId)) { reviewPath = `/review/${encodeURIComponent(d.prDeliveryId)}`; break }
          }
          notifyError(t('toasts.railWorktreeNeedsReview', { n: idx + 1, ticket: ticketId }), {
            ...(reviewPath ? { action: { label: t('railPr.openReview'), onClick: () => navigateRef.current(reviewPath!) } } : {}),
          })
        }
      }
      return
    }

    if (m.type === 'rail.job_completed') {
      const targetIndex = m.railIndex ?? 0
      // Strip this job's tickets from the rail on every terminal outcome so they
      // return to the Specs / Done column instead of being stranded on the rail.
      updateRails((prev) => applyRailJobOutcome(prev, targetIndex, m.ticketIds ?? []))

      if (m.status === 'completed') {
        toast.info(t('toasts.railCompleted', { n: targetIndex + 1 }))
      } else if (m.status === 'failed' || m.status === 'zombie_terminated') {
        notifyError(t('toasts.railFailed', { n: targetIndex + 1 }), { action: openJobAction(m.jobId ?? m.loopRunId) })
      } else {
        toast.info(t('toasts.railEnded', { n: targetIndex + 1, status: m.status ?? 'finished' }))
      }
    }

    // Loop runs (Loops mode) mirror rail.job_completed: strip the run's tickets
    // and reset the rail. The engine emits one completed event per per-ticket run.
    if (m.type === 'loop.run_completed') {
      const targetIndex = m.railIndex ?? 0
      updateRails((prev) => applyRailJobOutcome(prev, targetIndex, m.ticketIds ?? []))
      if (m.status === 'success') {
        toast.info(t('toasts.railCompleted', { n: targetIndex + 1 }))
      } else if (m.status === 'failed' || m.status === 'max-iterations') {
        notifyError(t('toasts.railFailed', { n: targetIndex + 1 }), { action: openJobAction(m.jobId ?? m.loopRunId) })
      } else {
        toast.info(t('toasts.railEnded', { n: targetIndex + 1, status: m.status ?? 'finished' }))
      }
    }
  }, [updateRails, setRailWorktrees, t])

  useEffect(() => {
    registerHandler('dashboard-rails', handleRailWsMessage)
    return () => unregisterHandler('dashboard-rails')
  }, [handleRailWsMessage, registerHandler, unregisterHandler])
}
