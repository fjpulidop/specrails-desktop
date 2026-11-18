import { describe, it, expect } from 'vitest'
import { RUN_STATES } from '../../../../components/ui/run-state/run-state'
import { JOB_STATUS_LOOK, PHASE_RUN_STATE, jobRunState, jobStatusLook, phaseRunState } from '../job-run-state'
import type { JobStatus } from '../../../../types'

const ALL: JobStatus[] = ['queued', 'running', 'completed', 'failed', 'canceled', 'zombie_terminated', 'skipped']

describe('job status → run state', () => {
  it('covers every job status with a vocabulary state and its own words', () => {
    expect(Object.keys(JOB_STATUS_LOOK).sort()).toEqual([...ALL].sort())
    for (const status of ALL) {
      const look = JOB_STATUS_LOOK[status]
      expect(RUN_STATES).toContain(look.state)
      expect(look.labelKey).toMatch(/^statusLabel\./)
      expect(look.tooltipKey).toMatch(/^statusTooltip\./)
    }
  })

  it('maps the specific statuses', () => {
    expect(jobRunState('running')).toBe('working')
    expect(jobRunState('queued')).toBe('queued')
    expect(jobRunState('completed')).toBe('done')
    expect(jobRunState('failed')).toBe('failed')
    expect(jobRunState('zombie_terminated')).toBe('failed')
    expect(jobRunState('canceled')).toBe('stopped')
    // Skipped is the same everywhere: stopped, never a warning or queued.
    expect(jobRunState('skipped')).toBe('stopped')
  })

  it('keeps the specific labels and one queued tooltip', () => {
    expect(jobStatusLook('zombie_terminated').labelKey).toBe('statusLabel.zombie')
    expect(jobStatusLook('queued').tooltipKey).toBe('statusTooltip.queued')
  })

  it('reads an unknown or prototype status as queued', () => {
    expect(jobStatusLook('brand_new').state).toBe('queued')
    expect(jobStatusLook('toString').state).toBe('queued')
  })

  it('maps every pipeline phase', () => {
    expect(PHASE_RUN_STATE).toEqual({ idle: 'queued', running: 'working', done: 'done', error: 'failed' })
    expect(phaseRunState('running')).toBe('working')
  })
})
