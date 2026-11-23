import { describe, expect, it, vi } from 'vitest'
import { reapWorktreeContainers, selectWorktreeContainers, type DockerRunner } from './worktree-container-reaper'
import { createWorktreeProcessReaper } from './worktree-process-reaper'

const worktree = '/home/me/.specrails/projects/redis/worktrees/run-1/ticket-2'
// The redis-ttl re-run of 2026-11-19: its fixer ran `docker compose up` in the worktree and never took it down.
const listing = [
  `1d47f2d177bb\tticket-2-redis-1\t${worktree}`,
  `0d5bd44e9795\tcounter-test-redis-1\t${worktree}/test/fixtures`,
  `24e284a9e8af\tdeckdex-db-1\t/home/me/repos/deckdex`,
  `7a14972d2aea\tsibling-redis-1\t${worktree}-other`,
  'not-a-container-line',
].join('\n')

describe('compose containers a settled run left behind', () => {
  it('selects only containers started from the worktree or inside it', () => {
    expect(selectWorktreeContainers(listing, [worktree]).map((container) => container.name)).toEqual(['ticket-2-redis-1', 'counter-test-redis-1'])
    expect(selectWorktreeContainers(listing, [worktree + '/']).map((container) => container.id)).toEqual(['1d47f2d177bb', '0d5bd44e9795'])
    expect(selectWorktreeContainers('abc123\twin-redis-1\tC:\\Users\\Me\\WT\\Ticket-2', ['c:\\users\\me\\wt\\ticket-2'], { windows: true })).toHaveLength(1)
  })

  it('force-removes them and leaves everything else alone', async () => {
    const docker = vi.fn<DockerRunner>(async (args) => args[0] === 'ps' ? { ok: true, stdout: listing } : { ok: true, stdout: '' })
    const removed = await reapWorktreeContainers([worktree], { docker, log: () => {} })
    expect(removed.map((container) => container.id)).toEqual(['1d47f2d177bb', '0d5bd44e9795'])
    expect(docker).toHaveBeenLastCalledWith(['rm', '-f', '1d47f2d177bb', '0d5bd44e9795'])
  })

  it('does nothing on a host without Docker or without matching containers', async () => {
    const missing = vi.fn<DockerRunner>(async () => ({ ok: false, stdout: '' }))
    expect(await reapWorktreeContainers([worktree], { docker: missing })).toEqual([])
    expect(missing).toHaveBeenCalledTimes(1)
    const none = vi.fn<DockerRunner>(async () => ({ ok: true, stdout: '24e284a9e8af\tdeckdex-db-1\t/home/me/repos/deckdex' }))
    expect(await reapWorktreeContainers([worktree], { docker: none })).toEqual([])
    expect(none).toHaveBeenCalledTimes(1)
  })

  it('runs with every settled-run reap, for safe worktree paths only', async () => {
    const reapContainers = vi.fn(async () => [])
    const reap = createWorktreeProcessReaper({ readProcessTable: async () => [], listProtectedRootPids: () => [], listForbiddenPaths: () => ['/home/me'], reapContainers, log: () => {} })
    await reap({ worktreePaths: [worktree, '/home/me'], reason: 'rail-run-settled', runId: 'run-1' })
    expect(reapContainers).toHaveBeenCalledWith([worktree], 'rail-run-settled run=run-1')
  })
})
