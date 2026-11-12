import { describe, expect, it, vi } from 'vitest'
import type { Exec } from '../pr-publisher'
import { createPrCiStatusCache, readPrCiStatus } from './pr-ci-status'

const view = (over: Record<string, unknown>) => JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE', headRefOid: 'a'.repeat(40), statusCheckRollup: [], ...over })
const exec = (stdout: string, code = 0): Exec => ({ run: async () => ({ code, stdout, stderr: '' }) })
const run = (name: string, status: string, conclusion: string | null) => ({ __typename: 'CheckRun', name, status, conclusion })

describe('readPrCiStatus', () => {
  it('reads red with the failing check names, pending while checks run, green when all passed', async () => {
    expect(await readPrCiStatus(exec(view({ statusCheckRollup: [run('secret-scan', 'COMPLETED', 'FAILURE'), run('test', 'COMPLETED', 'FAILURE'), run('quality', 'COMPLETED', 'SUCCESS')] })), '/repo', 'u'))
      .toMatchObject({ state: 'red', total: 3, failing: ['secret-scan', 'test'], headSha: 'a'.repeat(40) })
    expect(await readPrCiStatus(exec(view({ statusCheckRollup: [run('quality', 'IN_PROGRESS', null), run('lint', 'COMPLETED', 'SUCCESS')] })), '/repo', 'u')).toMatchObject({ state: 'pending', pending: 1 })
    expect(await readPrCiStatus(exec(view({ statusCheckRollup: [run('quality', 'COMPLETED', 'SUCCESS')] })), '/repo', 'u')).toMatchObject({ state: 'green' })
    expect(await readPrCiStatus(exec(view({})), '/repo', 'u')).toMatchObject({ state: 'none' })
  })

  it('reports conflicts, closed PRs and unreadable answers without guessing', async () => {
    expect(await readPrCiStatus(exec(view({ mergeable: 'CONFLICTING' })), '/repo', 'u')).toMatchObject({ state: 'conflict' })
    expect(await readPrCiStatus(exec(view({ state: 'MERGED' })), '/repo', 'u')).toMatchObject({ state: 'closed' })
    expect(await readPrCiStatus(exec('', 1), '/repo', 'u')).toMatchObject({ state: 'unknown' })
    expect(await readPrCiStatus(exec('not json'), '/repo', 'u')).toMatchObject({ state: 'unknown' })
  })
})

describe('createPrCiStatusCache', () => {
  it('reads GitHub once per PR within the window, then again', async () => {
    let now = 0
    const read = vi.fn(async () => ({ state: 'green' as const, total: 1, pending: 0, failing: [], headSha: null }))
    const cached = createPrCiStatusCache(read, 60_000, () => now)
    await cached('/repo', 'u'); await cached('/repo', 'u')
    expect(read).toHaveBeenCalledTimes(1)
    now = 61_000
    await cached('/repo', 'u')
    expect(read).toHaveBeenCalledTimes(2)
  })
})
