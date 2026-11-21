import React, { type ReactNode } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { UiModeProvider } from '../../../../context/UiModeContext'
import { useOpenMilestoneRail } from '../useOpenMilestoneRail'
import { milestoneRailOpen, type MilestoneRail } from '../../lib/milestone-progress'

function rail(over: Partial<MilestoneRail> = {}): MilestoneRail {
  return { railIndex: 0, name: 'M1 · #6', ticketIds: [6], active: false, runId: null, startedAt: null, delivery: null, chunkIndex: 1, ...over }
}
const delivery = { id: 'd-1', railIndex: 0, ticketIds: [6], decision: 'on_review', branch: 'b', baseBranch: 'main', prUrl: null, prNumber: null, prState: 'none', createdAt: null }

function setup(mode?: 'kanban' | 'agent') {
  const go = vi.fn()
  const openReview = vi.fn()
  const wrapper = mode
    ? ({ children }: { children: ReactNode }) => <UiModeProvider initialMode={mode} persist={false}>{children}</UiModeProvider>
    : undefined
  const { result } = renderHook(() => useOpenMilestoneRail({ go, openReview }), { wrapper })
  return { open: result.current, go, openReview }
}

describe('milestoneRailOpen', () => {
  it('prefers the live run, then the delivery, else nothing', () => {
    expect(milestoneRailOpen(rail({ runId: 'r-1', delivery }))).toEqual({ kind: 'run', runId: 'r-1' })
    expect(milestoneRailOpen(rail({ delivery }))).toEqual({ kind: 'review', deliveryId: 'd-1' })
    expect(milestoneRailOpen(rail())).toEqual({ kind: 'none' })
  })
})

describe('useOpenMilestoneRail', () => {
  it('Board mode opens the run at /jobs/<id> as a job place', () => {
    const { open, go, openReview } = setup('kanban')
    open(rail({ active: true, runId: 'loop-run-7' }))
    expect(go).toHaveBeenCalledWith('/jobs/loop-run-7', { placePush: 'job' })
    expect(openReview).not.toHaveBeenCalled()
  })

  it('Mission mode opens the run as ?job=<id> on the mission place', () => {
    const { open, go } = setup('agent')
    open(rail({ active: true, runId: 'job 9' }))
    expect(go).toHaveBeenCalledWith('/?job=job+9', { placePush: 'job' })
  })

  it('a rail with only a delivery opens its review; a bare rail falls back home', () => {
    const { open, go, openReview } = setup()
    open(rail({ delivery }))
    expect(openReview).toHaveBeenCalledWith('d-1')
    expect(go).not.toHaveBeenCalled()
    open(rail())
    expect(go).toHaveBeenCalledWith('/')
  })
})
