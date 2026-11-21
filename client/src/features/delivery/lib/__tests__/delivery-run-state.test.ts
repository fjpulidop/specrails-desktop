import { describe, it, expect } from 'vitest'
import { GitBranch, GitMerge, GitPullRequest, MessageSquareWarning, Undo2 } from 'lucide-react'
import type { RailPrDecision } from '../../../../types'
import { RUN_STATES } from '../../../../components/ui/run-state/run-state'
import {
  CI_RUN_STATE,
  DELIVERY_DECISION_LOOK,
  DELIVERY_OVERRIDE_LOOK,
  ciRunState,
  deliveryLook,
  deliveryOverrideOf,
} from '../delivery-run-state'

const DECISIONS: RailPrDecision[] = [
  'building', 'on_review', 'pr_draft', 'pr_ready', 'no_changes', 'completed', 'pr_closed', 'superseded',
  'merged', 'discarded', 'implementation_failed', 'pr_failed',
]

describe('delivery decision → run state', () => {
  it('maps every decision to a known RunState', () => {
    expect(Object.keys(DELIVERY_DECISION_LOOK).sort()).toEqual([...DECISIONS].sort())
    for (const decision of DECISIONS) expect(RUN_STATES).toContain(deliveryLook(decision).state)
  })

  it('names the specific mappings', () => {
    expect(deliveryLook('building')).toEqual({ state: 'working', objectIcon: GitBranch })
    expect(deliveryLook('on_review').state).toBe('review')
    expect(deliveryLook('pr_draft')).toEqual({ state: 'review', objectIcon: GitPullRequest })
    expect(deliveryLook('no_changes').state).toBe('done')
    expect(deliveryLook('completed').state).toBe('done')
    expect(deliveryLook('pr_closed').state).toBe('stopped')
    expect(deliveryLook('superseded').state).toBe('stopped')
    expect(deliveryLook('discarded').state).toBe('stopped')
    expect(deliveryLook('implementation_failed')).toEqual({ state: 'failed', objectIcon: null })
    expect(deliveryLook('pr_failed')).toEqual({ state: 'failed', objectIcon: null })
  })

  it('shows a PR ready to decide as an open PR waiting for review, never the merge glyph', () => {
    const ready = deliveryLook('pr_ready')
    expect(ready.state).toBe('review')
    expect(ready.objectIcon).toBe(GitPullRequest)
    expect(ready.objectIcon).not.toBe(GitMerge)
  })

  it('keeps GitMerge for merged only', () => {
    expect(deliveryLook('merged')).toEqual({ state: 'done', objectIcon: GitMerge })
    const withMerge = DECISIONS.filter((decision) => deliveryLook(decision).objectIcon === GitMerge)
    expect(withMerge).toEqual(['merged'])
  })

  it('lets an override win over the decision', () => {
    expect(Object.keys(DELIVERY_OVERRIDE_LOOK).sort()).toEqual(['changes', 'crashed', 'returned', 'stopped'])
    expect(deliveryLook('implementation_failed', 'changes')).toEqual({ state: 'blocked', objectIcon: MessageSquareWarning })
    expect(deliveryLook('discarded', 'returned')).toEqual({ state: 'stopped', objectIcon: Undo2 })
    expect(deliveryLook('implementation_failed', 'stopped')).toEqual({ state: 'stopped', objectIcon: null })
    expect(deliveryLook('implementation_failed', 'crashed').state).toBe('blocked')
  })

  it('derives the override from the delivery codes', () => {
    expect(deliveryOverrideOf({ decision: 'implementation_failed', statusCode: 'review_changes_requested' })).toBe('changes')
    expect(deliveryOverrideOf({ decision: 'implementation_failed', statusCode: 'run_stopped' })).toBe('stopped')
    expect(deliveryOverrideOf({ decision: 'implementation_failed', statusCode: 'other' })).toBeNull()
    expect(deliveryOverrideOf({ decision: 'pr_ready', statusCode: 'run_stopped' })).toBeNull()
    expect(deliveryOverrideOf({ decision: 'discarded', flowOutcome: 'returned' })).toBe('returned')
    expect(deliveryOverrideOf({ decision: 'implementation_failed', flowOutcome: 'crashed' })).toBe('crashed')
  })
})

describe('CI outcome → run state', () => {
  it('is exhaustive and never a spinner state', () => {
    expect(Object.keys(CI_RUN_STATE).sort()).toEqual(['conflict', 'green', 'pending', 'red'])
    expect(ciRunState('green')).toBe('done')
    expect(ciRunState('pending')).toBe('working')
    expect(ciRunState('red')).toBe('blocked')
    expect(ciRunState('conflict')).toBe('blocked')
  })
})
