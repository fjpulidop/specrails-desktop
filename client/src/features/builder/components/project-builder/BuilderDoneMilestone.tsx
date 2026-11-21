import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useMilestoneProgress } from '../../hooks/useMilestoneProgress'
import { useOpenMilestoneRail } from '../../hooks/useOpenMilestoneRail'
import { useDesktop } from '../../../../hooks/useDesktop'
import { FEATURE_REVIEW_PACKET } from '../../../../lib/feature-flags'
import { cancelChain, resumeChain, type ChainResumeFrom, saveMilestoneAutoAdvance, setChainAutoAdvance } from '../../lib/milestone-launch'
import { MilestoneCard } from './MilestoneProgressCard'

import { notifyError } from '../../../../lib/notify-error'
import { RailTrack } from '../../../../components/brand/RailTrack'
// The Builder done screen after "Launch Milestone 1" (premium-milestone-
// progress D5): the LIVE milestone card for the project just created —
// server-derived counts, rails with their decisions, the launch chain — so
// the user watches the first rail run instead of being dropped on a board.

export function BuilderDoneMilestone({ projectId }: { projectId: string }) {
  const { t } = useTranslation('builder')
  const navigate = useNavigate()
  const { setActiveProjectId } = useDesktop()
  const { progress, hasBlueprint } = useMilestoneProgress(projectId)
  const [chainBusy, setChainBusy] = useState(false)
  const m1 = progress.find((p) => p.n === 1) ?? null

  const goTo = useCallback((path: string, state?: Record<string, unknown>) => {
    setActiveProjectId(projectId)
    setTimeout(() => { if (state) navigate(path, { state }); else navigate(path) }, 50)
  }, [navigate, projectId, setActiveProjectId])
  const openReview = useCallback((deliveryId: string) => goTo(FEATURE_REVIEW_PACKET ? `/review/${deliveryId}` : '/'), [goTo])
  const openRail = useOpenMilestoneRail({ go: goTo, openReview })

  const onResume = useCallback(async (chainId: string, from?: ChainResumeFrom) => {
    setChainBusy(true)
    try {
      const r = await resumeChain(projectId, chainId, fetch, from)
      if (r.ok) toast.success(t('milestoneProgress.chain.resumed'))
      else notifyError(t('milestoneProgress.chain.resumeFailed'), { detail: r.detail ?? r.error })
    } finally { setChainBusy(false) }
  }, [projectId, t])

  const onSetAutoAdvance = useCallback(async (chainId: string, on: boolean) => {
    setChainBusy(true)
    try {
      const r = await setChainAutoAdvance(projectId, chainId, on)
      if (r.ok) {
        saveMilestoneAutoAdvance(on)
        toast.success(t(on ? 'milestoneProgress.chain.autoOn' : 'milestoneProgress.chain.autoOff'))
      } else {
        notifyError(t('milestoneProgress.chain.autoFailed'), { detail: r.detail ?? r.error })
      }
    } finally { setChainBusy(false) }
  }, [projectId, t])

  const onCancel = useCallback(async (chainId: string) => {
    setChainBusy(true)
    try {
      const r = await cancelChain(projectId, chainId)
      if (r.ok) toast.success(t('milestoneProgress.chain.cancelledToast'))
      else notifyError(t('milestoneProgress.chain.cancelFailed'), { detail: r.detail ?? r.error })
    } finally { setChainBusy(false) }
  }, [projectId, t])

  if (hasBlueprint === null && !m1) {
    return (
      <div className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground" data-testid="builder-done-milestone-loading">
        <RailTrack running className="w-24" />
      </div>
    )
  }
  if (!m1) return null
  return (
    <div className="mt-4 text-left" data-testid="builder-done-milestone">
      <MilestoneCard
        progress={m1}
        chainBusy={chainBusy}
        onReview={openReview}
        onOpenRail={openRail}
        onResume={onResume}
        onCancel={onCancel}
        onSetAutoAdvance={onSetAutoAdvance}
        className="bg-card/60"
      />
    </div>
  )
}
