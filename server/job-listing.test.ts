import { expect, it } from 'vitest'
import { createJob, initDb } from './db'
import { listUnifiedJobs } from './job-listing'

it('includes active continuations in running filters and prioritizes them without rewriting settled history', () => {
  const db = initDb(':memory:')
  try {
    createJob(db, { id: 'old', command: 'loop:implement', started_at: '2026-01-01T00:00:00Z', owner: 'loop' })
    createJob(db, { id: 'new', command: 'loop:implement', started_at: '2026-02-01T00:00:00Z', owner: 'loop' })
    db.prepare("UPDATE jobs SET status = 'failed'").run()
    const options = { limit: 1, offset: 0, activeRuntimeIds: ['old'] }
    expect(listUnifiedJobs(db, options).jobs.map(job => job.id)).toEqual(['old'])
    expect(listUnifiedJobs(db, { ...options, status: 'running' })).toMatchObject({ total: 1, jobs: [{ id: 'old' }] })
    expect(listUnifiedJobs(db, { ...options, status: 'failed' })).toMatchObject({ total: 1, jobs: [{ id: 'new' }] })
    expect(listUnifiedJobs(db, { limit: 10, offset: 0, status: 'running' }).total).toBe(0)
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get('old')).toEqual({ status: 'failed' })
  } finally { db.close() }
})
