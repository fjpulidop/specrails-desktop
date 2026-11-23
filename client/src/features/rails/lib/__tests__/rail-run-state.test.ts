import { describe, it, expect } from 'vitest'
import { runStateLook } from '../../../../components/ui/run-state/run-state'
import { HELD_SUMMARY_STATES, RAIL_RUN_STATE, railRunState } from '../rail-run-state'

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

  it('names a held rail by its hold kind, per the status vocabulary', () => {
    expect(railRunState('running', 'provider_limit')).toBe('blocked')
    expect(runStateLook(railRunState('running', 'provider_limit')).dot).toBe(runStateLook('blocked').dot)
    expect(railRunState('running', 'question')).toBe('needs-input')
    expect(railRunState('running', 'approval')).toBe('needs-input')
    expect(railRunState('running', 'budget')).toBe('paused')
    expect(railRunState('running', 'paused')).toBe('paused')
    expect(railRunState('running', 'restart')).toBe('paused')
    expect(railRunState('running', 'queued')).toBe('queued')
  })

  it('ignores a hold on a rail that is not running', () => {
    expect(railRunState('idle', 'provider_limit')).toBe('queued')
    expect(railRunState('failed', 'question')).toBe('failed')
  })

  it('orders the summary\'s held states by what needs the person first', () => {
    expect(HELD_SUMMARY_STATES).toEqual(['needs-input', 'blocked', 'paused', 'queued'])
  })
})
