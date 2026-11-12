import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import i18n from '../../../lib/i18n'
import { FEATURE_REVIEW_PACKET } from '../../../lib/feature-flags'
import { formatMilestoneToast, type MilestoneToastEvent, type FormatMilestoneToastInput } from '../lib/milestone-toast'
import { resumeChain, setChainAutoAdvance } from '../lib/milestone-launch'
import {
  chainPauseReason,
  coerceChain,
  coerceMilestoneProgress,
  milestoneLabelFor,
  reviewableDelivery,
  type MilestoneChainSnapshot,
} from '../lib/milestone-progress'

import { notifyError } from '../../../lib/notify-error'
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
  projectsById?: Map<string, string>
}

export function localizeChainPauseReason(reason: string | null): string {
  const { key, detail } = chainPauseReason(reason)
  const known = ['chunk_failed', 'chunk_stalled', 'chunk_stopped', 'provider_limit', 'launch_rejected', 'head_missing', 'head_discarded', 'run_lost', 'rail_limit_reached', 'integration_failed']
  if (!known.includes(key)) return reason ?? ''
  return i18n.t(`builder:milestoneProgress.chain.reasons.${key}`, { detail })
}

export function useMilestoneNotifications({ setActiveProjectId, projectsById }: UseMilestoneNotificationsOpts = {}): void {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => { navigateRef.current = navigate }, [navigate])
  const setActiveRef = useRef(setActiveProjectId)
  useEffect(() => { setActiveRef.current = setActiveProjectId }, [setActiveProjectId])

  const projectsRef = useRef(projectsById)
  useEffect(() => { projectsRef.current = projectsById }, [projectsById])
  const timingRef = useRef(new Map<string, MilestoneChainSnapshot | null>())
  const milestoneNumbersRef = useRef(new Map<string, number>())

  const chainsRef = useRef(new Map<string, MilestoneChainSnapshot>())
  const statesRef = useRef(new Map<string, string>())
  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  useEffect(() => {
    const id = 'milestone-notifications'
    registerHandler(id, (raw: unknown) => {
      const msg = raw as { type?: string; projectId?: string; chain?: unknown; progress?: unknown; milestoneId?: string; n?: number; title?: string } | null
      if (!msg || typeof msg.projectId !== 'string') return
      const projectId = msg.projectId
      const now = Date.now()
      const timingKey = (n: number) => JSON.stringify([projectId, n])
      const milestoneKey = (id: string) => JSON.stringify([projectId, id])
      const format = (
        event: MilestoneToastEvent,
        n: number,
        chain: MilestoneChainSnapshot | null,
        context: Pick<FormatMilestoneToastInput, 'railProgress' | 'pauseReason' | 'reviewCount'> = {},
      ) => formatMilestoneToast({
        projectName: projectsRef.current?.get(projectId) ?? null,
        milestoneLabel: milestoneLabelFor(n), event, status: chain?.status ?? event,
        startedAt: chain?.createdAt ?? null, endedAt: chain?.updatedAt ?? null, now, ...context,
      }, (key, params) => i18n.t(key, params))

      if (msg.type === 'milestone.chain_changed') {
        const chain = coerceChain(msg.chain)
        if (!chain) return
        const chainKey = JSON.stringify([projectId, chain.milestoneN, chain.id])
        const prev = chainsRef.current.get(chainKey)
        chainsRef.current.set(chainKey, chain)
        timingRef.current.set(timingKey(chain.milestoneN), chain)
        const railProgress = { current: chain.nextChunk, total: chain.totalChunks }
        if (chain.status === 'running' && chain.nextChunk > 1 && (!prev || prev.nextChunk < chain.nextChunk)) {
          const content = format('chunk_launched', chain.milestoneN, chain, { railProgress })
          toast.success(content.title, { id: `chain-launch:${chain.id}:${chain.nextChunk}`, description: content.description })
        }
        if (chain.status === 'awaiting_approval' && (!prev || prev.status !== 'awaiting_approval' || prev.nextChunk !== chain.nextChunk)) {
          const toastId = `chain-checkpoint:${chain.id}:${chain.nextChunk}`
          const content = format('checkpoint', chain.milestoneN, chain, { railProgress })
          toast.success(content.title, {
            description: content.description,
            id: toastId,
            duration: 60_000,
            action: {
              label: i18n.t('builder:milestoneProgress.toast.launchNext'),
              onClick: () => {
                void resumeChain(projectId, chain.id).then((r) => {
                  if (r.ok) toast.success(i18n.t('builder:milestoneProgress.chain.nextLaunched'), { id: toastId })
                  else notifyError(i18n.t('builder:milestoneProgress.chain.resumeFailed'), { id: toastId, detail: r.detail ?? r.error })
                })
              },
            },
            cancel: {
              label: i18n.t('builder:milestoneProgress.toast.autoContinue'),
              onClick: () => {
                void setChainAutoAdvance(projectId, chain.id, true).then((r) => {
                  if (r.ok) toast.success(i18n.t('builder:milestoneProgress.chain.autoOn'), { id: toastId })
                  else notifyError(i18n.t('builder:milestoneProgress.chain.autoFailed'), { id: toastId, detail: r.detail ?? r.error })
                })
              },
            },
          })
        }
        if (chain.status === 'paused' && (!prev || prev.status !== 'paused' || prev.pauseReason !== chain.pauseReason)) {
          const content = format('paused', chain.milestoneN, chain, { pauseReason: localizeChainPauseReason(chain.pauseReason) })
          toast.warning(content.title, {
            description: content.description,
            id: `chain-paused:${chain.id}`,
            duration: 30_000,
            action: {
              label: i18n.t('builder:milestoneProgress.toast.resume'),
              onClick: () => {
                void resumeChain(projectId, chain.id).then((r) => {
                  if (r.ok) toast.success(i18n.t('builder:milestoneProgress.chain.resumed'), { id: `chain-paused:${chain.id}` })
                  else notifyError(i18n.t('builder:milestoneProgress.chain.resumeFailed'), { id: `chain-paused:${chain.id}`, detail: r.detail ?? r.error })
                })
              },
            },
          })
        }
        return
      }

      if (msg.type === 'blueprint.milestone_progress') {
        for (const m of coerceMilestoneProgress(msg.progress)) {
          milestoneNumbersRef.current.set(milestoneKey(m.id), m.n)
          timingRef.current.set(timingKey(m.n), m.chain)
          const key = `${projectId}:${m.id}`
          const prev = statesRef.current.get(key)
          statesRef.current.set(key, m.state)
          if (prev === undefined || prev === m.state) continue
          if (m.state === 'delivered') {
            const delivery = reviewableDelivery(m)
            const content = format('delivered', m.n, m.chain, { reviewCount: m.counts.onReview })
            toast.success(content.title, {
              description: content.description,
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
        const n = msg.milestoneId ? milestoneNumbersRef.current.get(milestoneKey(msg.milestoneId)) ?? msg.n : msg.n
        const content = format('completed', msg.n, timingRef.current.get(timingKey(n)) ?? null)
        toast.success(content.title, { id: `milestone-completed:${projectId}:${msg.milestoneId ?? msg.n}`, duration: 15_000, description: content.description })
      }
    })
    return () => unregisterHandler(id)
  }, [registerHandler, unregisterHandler])
}
