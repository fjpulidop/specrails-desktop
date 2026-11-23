import { expect, it, vi } from 'vitest'
import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { core, execute, useFactoryPairing } from './__fixtures__/factory-pairing'
import { runAgentRuntimeControl } from '../../agent-runtime/runtime/agent-runtime-bridge'
import { BASE_REFRESH_FORK_NODE } from '../../delivery/runtime/delivery-base-refresh'

// Factory pairing for the base refresh of a conflicted delivery: after the
// host merged the updated base into a delivered run's worktree, the run forks
// from its final verification and the real Core verifies the merged candidate.
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
vi.mock('../../agent-runtime/runtime/agent-runtime-package', async importOriginal => {
  const original = await importOriginal<typeof import('../../agent-runtime/runtime/agent-runtime-package')>()
  const selected = new Map<string, string>()
  return { ...original,
    prepareRetainedAgentRuntime: async () => {},
    retainAgentRuntime: (cli: string, contextPath: string) => { selected.set(contextPath, cli); return cli },
    resolveRetainedAgentRuntime: async (contextPath: string) => {
      const cli = selected.get(contextPath)
      if (!cli) throw new Error('Fixture runtime was never retained')
      return cli
    },
  }
})
useFactoryPairing()

async function refreshAndVerify(mergedBase: (repository: string) => void) {
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
  mergedBase(actual.repository)
  const env = { ...process.env, SPECRAILS_GIT_AUTO: 'false' }
  // The retained-package record a launch writes; the fork copies it to the child (the runtime itself is the fixture's).
  writeFileSync(path.join(path.dirname(actual.contextPath), 'desktop-runtime-package.json'), '{}\n')
  const fork = await runAgentRuntimeControl({ kind: 'fork', runId: 'implement-v2', childRunId: 'refresh-1', requestId: 'base-refresh-paired', contextPath: actual.contextPath,
    cwd: actual.repository, env, fromNodePath: BASE_REFRESH_FORK_NODE, scopeId: 'root', visit: 1 })
  const cli = path.join(core!, 'dist/agent-runtime/cli.js')
  const resumed = spawnSync(process.execPath, [cli, 'resume', '--context', fork.contextPath], { cwd: actual.repository, env, encoding: 'utf8', timeout: 120_000 })
  const status = spawnSync(process.execPath, [cli, 'status', '--context', fork.contextPath, '--compact'], { cwd: actual.repository, env, encoding: 'utf8' })
  return { resumed, status: JSON.parse(status.stdout) as { state: { status: string }; completion: { ok: boolean; verified: boolean } | null } }
}

it.skipIf(!core)('verifies a delivered run again after the base was merged into its worktree, and succeeds on the merged candidate', async () => {
  const { resumed, status } = await refreshAndVerify(repository => writeFileSync(path.join(repository, 'integrated-by-another-spec.txt'), 'base work\n'))
  expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0)
  expect(status.state.status).toBe('succeeded')
  expect(status.completion).toMatchObject({ ok: true, verified: true })
}, 240_000)

it.skipIf(!core)('fails the refreshed run when the merged base breaks verification, without a correction round', async () => {
  const { resumed, status } = await refreshAndVerify(repository => writeFileSync(path.join(repository, 'code.cjs'), 'module.exports = 5\n'))
  expect(resumed.status).toBe(1)
  expect(status.state.status).toBe('failed')
  expect(status.completion).toMatchObject({ ok: false, verified: false })
}, 240_000)
