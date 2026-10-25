import { describe, it, expect } from 'vitest'
import { runAnnouncementFor } from '../run-announcements'

const P = 'proj-1'
const f = (msg: Record<string, unknown>, active: string | null = P) => runAnnouncementFor({ projectId: P, ...msg }, active)

describe('runAnnouncementFor', () => {
  it('maps run state changes to a kind and a 1-based rail', () => {
    expect(f({ type: 'rail.job_started', railIndex: 1, jobId: 'j1' })).toMatchObject({ kind: 'started', rail: 2 })
    expect(f({ type: 'rail.job_completed', railIndex: 0, jobId: 'j1', status: 'completed' })).toMatchObject({ kind: 'finished', rail: 1 })
    expect(f({ type: 'rail.job_completed', railIndex: 0, jobId: 'j1', status: 'failed' })).toMatchObject({ kind: 'failed' })
    expect(f({ type: 'rail.job_stopped', railIndex: 0, jobId: 'j1' })).toMatchObject({ kind: 'stopped' })
    expect(f({ type: 'loop.run_started', loopRunId: 'r1', railIndex: null })).toMatchObject({ kind: 'started', rail: null })
    expect(f({ type: 'loop.run_completed', loopRunId: 'r1', railIndex: null, status: 'success' })).toMatchObject({ kind: 'finished' })
    expect(f({ type: 'loop.run_completed', loopRunId: 'r1', railIndex: null, status: 'failed' })).toMatchObject({ kind: 'failed' })
    expect(f({ type: 'job.stuck', jobId: 'j9' })).toMatchObject({ kind: 'needsYou' })
  })

  it('carries the spec only when the message names exactly one', () => {
    expect(f({ type: 'rail.job_completed', railIndex: 0, jobId: 'j1', status: 'completed', ticketIds: [14] })).toMatchObject({ ticketId: 14 })
    expect(f({ type: 'rail.job_completed', railIndex: 0, jobId: 'j1', status: 'completed', ticketIds: [14, 15] })).toMatchObject({ ticketId: null })
    expect(f({ type: 'rail.job_started', railIndex: 0, jobId: 'j1', ticketId: 3 })).toMatchObject({ ticketId: 3 })
    expect(f({ type: 'rail.job_started', railIndex: 0, jobId: 'j1' })).toMatchObject({ ticketId: null })
  })

  it('distinguishes a budget pause from a decision pause and a provider limit', () => {
    expect(f({ type: 'loop.run_paused', loopRunId: 'r1', railIndex: 0, pauseKind: 'budget_paused' })).toMatchObject({ kind: 'paused', detail: 'budget' })
    expect(f({ type: 'loop.run_paused', loopRunId: 'r1', railIndex: 0 })).toMatchObject({ kind: 'needsYou' })
    expect(f({ type: 'loop.provider_limit', runId: 'r1' })).toMatchObject({ kind: 'paused', detail: 'limit' })
  })

  it('announces review ready and PR failures, not the other decisions', () => {
    expect(f({ type: 'rail.pr_state', prDeliveryId: 'd1', railIndex: 0, decision: 'on_review' })).toMatchObject({ kind: 'reviewReady', key: 'reviewReady:d1' })
    expect(f({ type: 'rail.pr_state', prDeliveryId: 'd1', railIndex: 0, decision: 'pr_failed' })).toMatchObject({ kind: 'failed' })
    expect(f({ type: 'rail.pr_state', prDeliveryId: 'd1', railIndex: 0, decision: 'building' })).toBeNull()
  })

  it('is scoped to the active project and ignores unrelated or malformed messages', () => {
    expect(f({ type: 'rail.job_started', railIndex: 0, jobId: 'j1' }, 'other')).toBeNull()
    expect(f({ type: 'rail.job_started', railIndex: 0, jobId: 'j1' }, null)).toBeNull()
    expect(f({ type: 'queue' })).toBeNull()
    expect(runAnnouncementFor(null, P)).toBeNull()
    expect(runAnnouncementFor('x', P)).toBeNull()
  })
})
