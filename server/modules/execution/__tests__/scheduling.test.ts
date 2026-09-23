import { describe, expect, it } from 'vitest'
import { isDependencySatisfied, normalizePendingQueue } from '..'

describe('pending queue admission policy', () => {
  it('retains queue order while dropping duplicates, missing and terminal jobs', () => {
    const queue = ['b', 'done', 'b', 'missing', 'a', 'running']
    const jobs = new Map([
      ['a', { status: 'queued' }], ['b', { status: 'queued' }],
      ['done', { status: 'completed' }], ['running', { status: 'running' }],
    ])
    expect(normalizePendingQueue(queue, jobs)).toEqual({
      normalizedQueue: ['b', 'a'], removedJobIds: ['done', 'missing', 'running'],
    })
    expect(queue).toEqual(['b', 'done', 'b', 'missing', 'a', 'running'])
    expect(jobs.size).toBe(4)
  })
  it('does not block historical parents but never admits a failed or active parent', () => {
    expect(isDependencySatisfied(null)).toBe(true)
    expect(isDependencySatisfied('completed')).toBe(true)
    for (const status of ['queued', 'running', 'failed', 'canceled', 'unknown']) {
      expect(isDependencySatisfied(status)).toBe(false)
    }
  })
})
