import { describe, it, expect } from 'vitest'
import { runStateLook } from '../../../../components/ui/run-state/run-state'
import { RAIL_RUN_STATE, railRunState } from '../rail-run-state'

describe('rail status → run state', () => {
  it('is exhaustive over RailStatus', () => {
    expect(Object.keys(RAIL_RUN_STATE).sort()).toEqual(['failed', 'idle', 'running'])
  })

  it('shows a running rail as working: the info lamp, never success', () => {
    expect(railRunState('running')).toBe('working')
    expect(runStateLook(railRunState('running')).dot).toBe('bg-accent-info')
    expect(runStateLook(railRunState('running')).dot).not.toContain('success')
  })

  it('shows an idle rail as queued and a failed rail as failed', () => {
    expect(railRunState('idle')).toBe('queued')
    expect(railRunState('failed')).toBe('failed')
  })
})
