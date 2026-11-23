import { useCallback, useRef } from 'react'
import { useUiMode } from '../../../context/UiModeContext'
import { inboxTarget } from '../../inbox/lib/inbox-model'
import { PLACE_PUSH_STATE } from '../../../lib/places'
import { milestoneRailOpen, type MilestoneRail } from '../lib/milestone-progress'

/** Where a milestone surface sends the person: a path (with its search) and the place push state. */
export type MilestoneRailGo = (to: string, state?: Record<string, unknown>) => void

interface UseOpenMilestoneRailOptions {
  /** Navigates (the caller closes its popover / switches project first). */
  go: MilestoneRailGo
  /** The surface's Review action: a rail with a delivery and no live run opens exactly that. */
  openReview: (deliveryId: string) => void
}

/**
 * Opening a milestone rail row: its live run opens the run's place the way the inbox and the
 * live board open a run (Mission mode `/?job=<id>`, Board mode `/jobs/<id>`; the job place
 * itself decides whether that is the native job-detail window); a rail with only a delivery
 * opens its review; a rail with neither falls back to the home place.
 */
export function useOpenMilestoneRail({ go, openReview }: UseOpenMilestoneRailOptions): (rail: MilestoneRail) => void {
  const { uiMode } = useUiMode()
  const modeRef = useRef(uiMode)
  modeRef.current = uiMode
  return useCallback((rail: MilestoneRail) => {
    const open = milestoneRailOpen(rail)
    if (open.kind === 'review') {
      openReview(open.deliveryId)
      return
    }
    if (open.kind === 'none') {
      go('/')
      return
    }
    const target = inboxTarget({ action: 'open-run', subjectId: open.runId, conversationId: null }, modeRef.current === 'agent' ? 'agent' : 'kanban')
    go(`${target.pathname}${target.search}`, { [PLACE_PUSH_STATE]: target.place })
  }, [go, openReview])
}
