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

describe('a held job (its row says running, its run is stopped)', async () => {
  const { describeJobHold, isJobLive, jobDisplayStatus, jobHoldOf, HELD_RUN_STATE } = await import('../job-run-state')
  const i18n = (await import('../../../../lib/i18n')).default
  const running = (hold?: unknown) => ({ status: 'running' as const, hold: hold as never })

  it('reads through its hold on every surface, never as running', () => {
    expect(jobStatusLook(running({ kind: 'restart', step: 'developer', since: null }))).toMatchObject({ state: 'paused', labelKey: 'held.label.restart' })
    expect(jobStatusLook(running({ kind: 'interrupted', step: null, since: null })).state).toBe('paused')
    expect(jobStatusLook(running({ kind: 'provider_limit', step: null, since: null })).state).toBe('blocked')
    expect(jobStatusLook(running({ kind: 'budget', step: null, since: null })).state).toBe('paused')
    expect(jobStatusLook(running({ kind: 'question', step: null, since: null })).state).toBe('needs-input')
    expect(jobStatusLook(running()).state).toBe('working')
    expect(Object.values(HELD_RUN_STATE)).not.toContain('working')
  })

  it('is not live and shows as paused to the log and graph, and ignores a hold on a settled row or a malformed one', () => {
    expect(isJobLive(running({ kind: 'restart', step: null, since: null }))).toBe(false)
    expect(jobDisplayStatus(running({ kind: 'restart', step: null, since: null }))).toBe('paused')
    expect(isJobLive(running())).toBe(true)
    expect(jobHoldOf({ status: 'completed', hold: { kind: 'restart', step: null, since: null } })).toBeNull()
    expect(jobHoldOf(running({ kind: 'nonsense' }))).toBeNull()
  })

  it('says why in plain words, with the step by its role name', () => {
    const t = i18n.getFixedT('en')
    expect(describeJobHold(t, { kind: 'restart', step: 'developer', since: null })).toBe('The app restarted during the Developer step.')
    expect(describeJobHold(t, { kind: 'restart', step: null, since: null })).toBe('The app restarted while the run was working.')
    expect(describeJobHold(t, { kind: 'interrupted', step: 'spec-review', since: null })).toBe('The Spec review step stopped before it finished.')
  })

  it('words a run the person paused as paused by you, in its look and its reason', async () => {
    const hold = { kind: 'paused', byYou: true, step: null, since: null } as const
    expect(jobHoldOf(running(hold))).toMatchObject({ kind: 'paused', byYou: true })
    expect(jobStatusLook(running(hold))).toEqual({ state: 'paused', labelKey: 'held.label.pausedByYou', tooltipKey: 'held.tooltip.pausedByYou' })
    expect(jobStatusLook(running({ kind: 'paused', step: null, since: null })).labelKey).toBe('held.label.paused')
    expect(describeJobHold(i18n.getFixedT('en'), hold)).toBe('Paused by you. Nothing runs until you resume it.')
    const { loadLanguage } = await import('../../../../lib/i18n')
    await loadLanguage('es')
    expect(i18n.getFixedT('es')('jobs:held.label.pausedByYou')).toBe('Pausada por ti')
  })

  it('says it in Spanish too', async () => {
    const { loadLanguage } = await import('../../../../lib/i18n')
    await loadLanguage('es')
    expect(describeJobHold(i18n.getFixedT('es'), { kind: 'restart', step: 'developer', since: null })).toBe('La app se reinició durante el paso Desarrollador.')
    expect(i18n.getFixedT('es')('jobs:held.label.restart')).toBe('Pausado')
  })
})
