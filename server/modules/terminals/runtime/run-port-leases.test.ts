import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRunPortLeaseTable, withRunPortEnv } from './run-port-leases'
import { resetBrowseToolForTests } from '../../browser/runtime/run-browse-tool'
import { blockRange, candidateBlocks, runPortArea } from '../domain/run-ports'

let home: string
const worktree = (run: string, ticket = 1): string => {
  const dir = path.join(home, '.specrails', 'projects', 'app', 'worktrees', run, `ticket-${ticket}`)
  fs.mkdirSync(dir, { recursive: true })
  return fs.realpathSync(dir)
}
const table = (probeBlock?: (start: number, end: number) => Promise<boolean>) =>
  createRunPortLeaseTable({ home: () => home, area: () => runPortArea({}), probeBlock: probeBlock ?? (async () => false) })

beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-ports-'))) })
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe('run port leases', () => {
  it('gives each run worktree its own block and nothing to other paths', () => {
    const leases = table()
    const a = leases.lease(worktree('r1'))
    const b = leases.lease(worktree('r2'))
    expect(a && b).toBeTruthy()
    expect(a!.block).not.toBe(b!.block)
    expect(leases.lease(home)).toBeNull()
    expect(leases.lease(path.join(home, '.specrails', 'projects', 'app', 'workspace'))).toBeNull()
    expect(leases.env(home, {})).toEqual({})
    expect(leases.env(a!.worktreePath, {})).toMatchObject({ PORT: String(a!.start), SPECRAILS_RUN_PORT_RANGE_END: String(a!.end) })
  })

  it('keeps the same block after a restart (persisted) and frees it when the worktree is gone', () => {
    const wt = worktree('r1')
    const first = table().lease(wt)!
    expect(fs.statSync(path.join(home, '.specrails', 'run-ports.json')).mode & 0o777).toBe(0o600)
    const restarted = table()
    expect(restarted.lease(wt)).toMatchObject({ block: first.block, start: first.start })
    fs.rmSync(wt, { recursive: true })
    expect(restarted.list()).toEqual([])
    // The freed block is available to the next run whose home block it is.
    expect(JSON.parse(fs.readFileSync(path.join(home, '.specrails', 'run-ports.json'), 'utf8')).leases).toEqual([])
  })

  it('accepts the non-canonical spelling of a symlinked home', () => {
    const wt = worktree('r1')
    const link = path.join(os.tmpdir(), `run-ports-link-${process.pid}`)
    fs.symlinkSync(home, link)
    try {
      const leases = createRunPortLeaseTable({ home: () => link, area: () => runPortArea({}), probeBlock: async () => false })
      const viaLink = leases.lease(path.join(link, path.relative(home, wt)))
      expect(viaLink?.worktreePath).toBe(wt)
      expect(leases.lease(wt)?.block).toBe(viaLink?.block)
    } finally { fs.unlinkSync(link) }
  })

  it('ensure() skips a block where something already listens', async () => {
    const wt = worktree('busy')
    const area = runPortArea({})
    const home0 = candidateBlocks(area, wt, new Set())[0]
    const range = blockRange(area, home0)
    const server = net.createServer()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(range.start + 3, resolve) })
    try {
      const leases = createRunPortLeaseTable({ home: () => home, area: () => area })
      const lease = await leases.ensure(wt)
      expect(lease!.block).not.toBe(home0)
      // Concurrent callers share one allocation; later sync reads return it.
      expect(await leases.ensure(wt)).toEqual(lease)
      expect(leases.lease(wt)).toEqual(lease)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('ensure() deduplicates concurrent allocations for the same worktree', async () => {
    const wt = worktree('r1')
    let probes = 0
    const leases = table(async () => { probes++; return false })
    const [a, b] = await Promise.all([leases.ensure(wt), leases.ensure(wt)])
    expect(a).toEqual(b)
    expect(probes).toBe(1)
  })
})

describe('run process environment', () => {
  afterEach(() => { vi.unstubAllEnvs(); resetBrowseToolForTests() })
  it('gives a run its ports and the browser tool, and other processes neither', () => {
    vi.stubEnv('SPECRAILS_REGISTRY_HOME', home)
    resetBrowseToolForTests('/tools/specrails-browse')
    const env = withRunPortEnv({ PATH: '/bin' }, worktree('r9'))
    expect(env).toMatchObject({ PATH: '/bin', SPECRAILS_BROWSE: '/tools/specrails-browse', PORT: expect.any(String) })
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined()
    expect(withRunPortEnv({ PATH: '/bin' }, home)).toEqual({ PATH: '/bin' })
  })
})
