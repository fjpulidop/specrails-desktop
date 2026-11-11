import { expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { runAgentRuntimeInvocation } from '../../agent-runtime/runtime/agent-runtime-bridge'
import { compileLoopToDefinition } from './loop-definition'
import { runDefinitionLoop, type DefinitionHostTaskRequest } from './loop-definition-run'
import { PR_CI_ENDS, PR_CI_LOOP_ID, prCiGraph } from './loop-pr-ci-recipe'
import { coreCliMissing, useFactoryPairing } from './__fixtures__/factory-pairing'
import type { LoopRunRequest } from './loop-run-manager'

// PR CI loop pairing: Desktop's factory:pr-ci graph executed by the REAL Core
// through the real bridge, with Desktop resolving every host task the way the
// dispatcher does (`resume --host-result`). Paths without an AI turn only.
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
vi.mock('../../agent-runtime/runtime/agent-runtime-package', async importOriginal => {
  const original = await importOriginal<typeof import('../../agent-runtime/runtime/agent-runtime-package')>()
  const selected = new Map<string, string>()
  return { ...original,
    retainAgentRuntime: (cli: string, contextPath: string) => { selected.set(contextPath, cli); return cli },
    resolveRetainedAgentRuntime: (contextPath: string) => { const cli = selected.get(contextPath); if (!cli) throw new Error('Fixture runtime was never retained'); return cli },
  }
})
useFactoryPairing()

async function runPrCi(id: string, script: Record<string, string[]>) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pr ci pairing ')))
  try {
    const repository = path.join(root, 'repo'), backlog = path.join(root, 'backlog')
    mkdirSync(repository); mkdirSync(backlog)
    expect(spawnSync('git', ['init', '-q', repository]).status).toBe(0)
    writeFileSync(path.join(repository, 'code.cjs'), 'module.exports = 2\n')
    expect(spawnSync('git', ['-C', repository, 'add', '.']).status).toBe(0)
    expect(spawnSync('git', ['-C', repository, '-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'base']).status).toBe(0)
    const runtime = path.join(backlog, '.specrails/pipeline', id); mkdirSync(runtime, { recursive: true })
    const contextPath = path.join(runtime, 'desktop-context.json'), configPath = path.join(root, 'config.json')
    writeFileSync(contextPath, JSON.stringify({ schemaVersion: 1, runId: id, backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }],
      ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Keep CI green', description: 'PR CI loop', repositoryIds: ['repo'] }] }))
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, enabled: true, providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }],
      agents: { architect: { provider: 'claude' }, developer: { provider: 'claude' }, reviewer: { provider: 'claude' } },
      verification: [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'if(require("./code.cjs")!==2)process.exit(9)'] }] }))
    const graph = prCiGraph({ engineV2: 1, workflowDefinitions: 1, hostTasks: 1 })
    const env = { ...process.env, SPECRAILS_GIT_AUTO: 'false' }
    const requests: DefinitionHostTaskRequest[] = []
    const queue = Object.fromEntries(Object.entries(script).map(([task, outcomes]) => [task, [...outcomes]]))
    const result = await runDefinitionLoop({ runId: id } as unknown as LoopRunRequest, id, {
      invoke: input => runAgentRuntimeInvocation(input.resume
        ? { contextPath, cwd: repository, env, engineVersion: 2, resume: true, interruptId: input.interruptId, hostResult: input.hostResult, timeoutMs: 120_000 }
        : { contextPath, configPath, cwd: repository, env, engineVersion: 2, change: 'pr-ci', loopConfig: graph.config.agents, timeoutMs: 120_000,
          prepareDefinition: config => compileLoopToDefinition(graph, { id: PR_CI_LOOP_ID, title: 'Fix PR CI', provider: 'claude', constants: {}, roles: config.roles, loopAgents: config, repositoryCount: 1 }) })
        .then(value => ({ ...value, runtimeStatus: value.runtimeStatus ?? 'failed' })),
      isCancelled: () => false, remainingMs: () => undefined, onLine: () => {}, onRuntimeEvent: () => {}, onSpawn: () => {}, onInvocationEnd: () => {},
      awaitHumanDecision: async () => { throw new Error('the PR CI loop must never wait for a person') },
      resolveHostTask: async interrupt => {
        requests.push(interrupt.value)
        const outcome = queue[interrupt.value.task]?.shift()
        if (!outcome) throw new Error('unexpected host task ' + interrupt.value.task)
        return { action: 'resume', result: { outcome, output: { note: `${interrupt.value.task} ${outcome}` } } }
      },
    })
    return { result, requests }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

it.skipIf(coreCliMissing)('ends green without writing when the PR is up to date and CI is green', async () => {
  const { result, requests } = await runPrCi('pr-ci-green', { 'pr.update-base': ['clean'], 'pr.checks': ['green'] })
  expect(result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, reasons: ['All checks of the pull request are green.'] } })
  expect(requests.map(request => request.task)).toEqual(['pr.update-base', 'pr.checks'])
  expect(requests[0]).toMatchObject({ effect: 'write', input: { reason: 'start' }, outcomes: ['clean', 'merged', 'conflicts', 'closed'] })
  expect(requests[1]).toMatchObject({ effect: 'read', timeoutMs: 3_600_000 })
}, 180_000)

it.skipIf(coreCliMissing)('verifies locally before pushing a merged base, then waits for CI again', async () => {
  const { result, requests } = await runPrCi('pr-ci-merged', { 'pr.update-base': ['merged'], 'pr.sync': ['pushed'], 'pr.checks': ['green'] })
  expect(result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true } })
  expect(requests.map(request => request.task)).toEqual(['pr.update-base', 'pr.sync', 'pr.checks'])
  // Core attests the verification it just ran: only that candidate is pushed.
  expect(requests[1]).toMatchObject({ task: 'pr.sync', effect: 'read', candidate: { verified: true }, input: { summary: 'Update from the CI loop' } })
}, 180_000)

it.skipIf(coreCliMissing).each([
  ['no CI checks', { 'pr.update-base': ['clean'], 'pr.checks': ['none'] }, 'succeeded', PR_CI_ENDS.noCi, 'The pull request has no CI checks.'],
  ['a closed PR', { 'pr.update-base': ['closed'] }, 'failed', PR_CI_ENDS.closed, 'The pull request was closed or merged while the loop was running.'],
  ['checks that never finish', { 'pr.update-base': ['clean'], 'pr.checks': ['timeout'] }, 'failed', PR_CI_ENDS.timeout, 'The checks did not finish within the wait limit; required checks may never report.'],
] as const)('ends with a clear reason for %s', async (_label, script, status, _end, reason) => {
  const { result } = await runPrCi('pr-ci-' + _end, script as unknown as Record<string, string[]>)
  expect(result.runtimeStatus).toBe(status)
  expect(result.completion?.reasons).toContain(reason)
}, 180_000)
