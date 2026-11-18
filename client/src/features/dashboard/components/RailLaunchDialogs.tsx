/**
 * The board's launch confirmations: the Launch-all batch dialog and the
 * "deliver into this existing PR" confirmation, driven by `useRailLaunch`.
 */
import { LaunchAllDialog } from '../../rails/components/LaunchAllDialog'
import { TargetPrLaunchDialog } from '../../delivery/components/TargetPrLaunchDialog'
import type { RailState } from '../../rails/components/RailsBoard'
import type { useRailLaunch } from '../hooks/useRailLaunch'

export function RailLaunchDialogs({ launch, rails, reviewWipLimit, pendingReviewCount, projectId = null }: {
  launch: ReturnType<typeof useRailLaunch>
  rails: RailState[]
  reviewWipLimit: number | null
  pendingReviewCount: number
  /** Enables the launch preflight (disk, sign-in, quota). */
  projectId?: string | null
}) {
  const { launchAllPlan, launchAllConfirm, targetPrConfirm } = launch
  const r = targetPrConfirm ? rails.find((x) => x.id === targetPrConfirm.railId) : undefined
  return (
    <>
      <LaunchAllDialog
        open={launchAllConfirm}
        railCount={launchAllPlan.eligible.length}
        specCount={launchAllPlan.eligible.reduce((sum, rail) => sum + rail.ticketIds.length, 0)}
        reviewLimit={reviewWipLimit !== null && launchAllPlan.skipped.some((s) => s.reason === 'reviewLimit')
          ? { limit: reviewWipLimit, pending: pendingReviewCount, held: launchAllPlan.skipped.filter((s) => s.reason === 'reviewLimit').length }
          : null}
        projectId={projectId}
        providers={launchAllPlan.eligible.map((rail) => rail.aiEngine ?? '')}
        onCancel={launch.cancelLaunchAll}
        onConfirm={() => { void launch.runLaunchAll() }}
      />

      <TargetPrLaunchDialog
        open={!!targetPrConfirm && !!r?.targetPr}
        target={r?.targetPr ?? null}
        onCancel={launch.cancelTargetPrLaunch}
        onConfirm={launch.confirmTargetPrLaunch}
      />
    </>
  )
}
