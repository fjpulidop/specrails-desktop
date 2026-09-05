import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useSharedWebSocket } from './useSharedWebSocket'
import i18n from '../lib/i18n'
import { FEATURE_REVIEW_PACKET } from '../lib/feature-flags'
import { resumeChain, setChainAutoAdvance } from '../lib/milestone-launch'
import {
  chainPauseReason,
  coerceChain,
  coerceMilestoneProgress,
  milestoneLabelFor,
  reviewableDelivery,
  type MilestoneChainSnapshot,
} from '../lib/milestone-progress'

// App-level milestone toasts (premium-milestone-progress D5): state-accurate,
// never "complete" for an undelivered or unmerged milestone.
//   • a later chunk launched            → "M1 — rail 2 of 3 launched"
//   • the chain paused                  → warning + Resume action
//   • a wave checkpoint                 → "M1 — rail 1 of 3 delivered. Launch the next rail?" + Launch next / Auto-continue
//   • a milestone became delivered      → "M1 delivered — 8 specs waiting for your review" + Review
//   • every spec merged                 → "M1 complete"
// Transitions are detected against the last observed state (refs), so a fresh
// page load never toasts history.

interface UseMilestoneNotificationsOpts {
  setActiveProjectId?: (id: string) => void
}

export function localizeChainPauseReason(reason: string | null): string {
  const { key, detail } = chainPauseReason(reason)
  const known = ['chunk_failed', 'chunk_stalled', 'chunk_stopped', 'provider_limit', 'launch_rejected', 'head_missing', 'head_discarded', 'run_lost']
  if (!known.includes(key)) return reason ?? ''
  return i18n.t(`builder:milestoneProgress.chain.reasons.${key}`, { detail })
}

export function useMilestoneNotifications({ setActiveProjectId }: UseMilestoneNotificationsOpts = {}): void {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => { navigateRef.current = navigate }, [navigate])
  const setActiveRef = useRef(setActiveProjectId)
  useEffect(() => { setActiveRef.current = setActiveProjectId }, [setActiveProjectId])

  const chainsRef = useRef(new Map<string, MilestoneChainSnapshot>())
  const statesRef = useRef(new Map<string, string>())
  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  useEffect(() => {
    const id = 'milestone-notifications'
    registerHandler(id, (raw: unknown) => {
      const msg = raw as { type?: string; projectId?: string; chain?: unknown; progress?: unknown; milestoneId?: string; n?: number; title?: string } | null
      if (!msg || typeof msg.projectId !== 'string') return
      const projectId = msg.projectId

      if (msg.type === 'milestone.chain_changed') {
        const chain = coerceChain(msg.chain)
        if (!chain) return
        const prev = chainsRef.current.get(chain.id)
        chainsRef.current.set(chain.id, chain)
        const label = milestoneLabelFor(chain.milestoneN)
        if (chain.status === 'running' && chain.nextChunk > 1 && (!prev || prev.nextChunk < chain.nextChunk)) {
          toast.success(i18n.t('builder:milestoneProgress.toast.chunkLaunched', { milestone: label, k: chain.nextChunk, n: chain.totalChunks }), { id: `chain-launch:${chain.id}:${chain.nextChunk}` })
        }
        if (chain.status === 'awaiting_approval' && (!prev || prev.status !== 'awaiting_approval' || prev.nextChunk !== chain.nextChunk)) {
          const toastId = `chain-checkpoint:${chain.id}:${chain.nextChunk}`
          toast.success(i18n.t('builder:milestoneProgress.toast.checkpoint', { milestone: label, k: chain.nextChunk, n: chain.totalChunks }), {
            id: toastId,
            duration: 60_000,
            action: {
              label: i18n.t('builder:milestoneProgress.toast.launchNext'),
              onClick: () => {
                void resumeChain(projectId, chain.id).then((r) => {
                  if (r.ok) toast.success(i18n.t('builder:milestoneProgress.chain.nextLaunched'), { id: toastId })
                  else toast.error(i18n.t('builder:milestoneProgress.chain.resumeFailed'), { id: toastId, description: r.detail ?? r.error })
                })
              },
            },
            cancel: {
              label: i18n.t('builder:milestoneProgress.toast.autoContinue'),
              onClick: () => {
                void setChainAutoAdvance(projectId, chain.id, true).then((r) => {
                  if (r.ok) toast.success(i18n.t('builder:milestoneProgress.chain.autoOn'), { id: toastId })
                  else toast.error(i18n.t('builder:milestoneProgress.chain.autoFailed'), { id: toastId, description: r.detail ?? r.error })
                })
              },
            },
          })
        }
        if (chain.status === 'paused' && (!prev || prev.status !== 'paused' || prev.pauseReason !== chain.pauseReason)) {
          toast.warning(i18n.t('builder:milestoneProgress.toast.paused', { milestone: label, reason: localizeChainPauseReason(chain.pauseReason) }), {
            id: `chain-paused:${chain.id}`,
            duration: 30_000,
            action: {
              label: i18n.t('builder:milestoneProgress.toast.resume'),
              onClick: () => {
                void resumeChain(projectId, chain.id).then((r) => {
                  if (r.ok) toast.success(i18n.t('builder:milestoneProgress.chain.resumed'), { id: `chain-paused:${chain.id}` })
                  else toast.error(i18n.t('builder:milestoneProgress.chain.resumeFailed'), { id: `chain-paused:${chain.id}`, description: r.detail ?? r.error })
                })
              },
            },
          })
        }
        return
      }

      if (msg.type === 'blueprint.milestone_progress') {
        for (const m of coerceMilestoneProgress(msg.progress)) {
          const key = `${projectId}:${m.id}`
          const prev = statesRef.current.get(key)
          statesRef.current.set(key, m.state)
          if (prev === undefined || prev === m.state) continue
          if (m.state === 'delivered') {
            const delivery = reviewableDelivery(m)
            toast.success(i18n.t('builder:milestoneProgress.toast.delivered', { milestone: milestoneLabelFor(m.n), count: m.counts.onReview }), {
              id: `milestone-delivered:${key}`,
              duration: 30_000,
              ...(delivery ? {
                action: {
                  label: i18n.t('builder:milestoneProgress.toast.review'),
                  onClick: () => {
                    setActiveRef.current?.(projectId)
                    const target = FEATURE_REVIEW_PACKET ? `/review/${delivery.id}` : '/'
                    setTimeout(() => { navigateRef.current(target) }, 50)
                  },
                },
              } : {}),
            })
          }
        }
        return
      }

      if (msg.type === 'blueprint.milestone_completed' && typeof msg.n === 'number') {
        toast.success(i18n.t('builder:milestoneProgress.toast.completed', { milestone: milestoneLabelFor(msg.n) }), { id: `milestone-completed:${projectId}:${msg.milestoneId ?? msg.n}`, duration: 15_000 })
      }
    })
    return () => unregisterHandler(id)
  }, [registerHandler, unregisterHandler])
}
