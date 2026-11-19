import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { runAgentRuntimeInvocation } from '../../agent-runtime/runtime/agent-runtime-bridge'
import { initDesktopDb } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import { createMachineInstalls } from '../../machine-installs'
import { createProcessInstallRunner } from '../../machine-installs/adapters/process'
import { createSqliteApprovalStore } from '../../machine-installs/adapters/sqlite'
import { compileLoopToDefinition } from './loop-definition'
import { runDefinitionLoop, type DefinitionInterrupt } from './loop-definition-run'
import type { LoopGraph } from './loop-graph'
import { core, coreCliMissing, useFactoryPairing } from './__fixtures__/factory-pairing'
import type { LoopRunRequest } from './loop-run-manager'

// "Ask once" machine-wide installs through the REAL Core: a verification that needs a Rust target
// (no AI turn) pauses on ONE question with the exact command; Desktop runs a FAKE `rustup` on a
// temp PATH when the person approves, answers `installed`, and Core verifies again by itself.
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
vi.mock('../../agent-runtime/runtime/agent-runtime-package', async importOriginal => {
  const original = await importOriginal<typeof import('../../agent-runtime/runtime/agent-runtime-package')>()
  const selected = new Map<string, string>()
  return { ...original,
    prepareRetainedAgentRuntime: async () => {},
    retainAgentRuntime: (cli: string, contextPath: string) => { selected.set(contextPath, cli); return cli },
    resolveRetainedAgentRuntime: async (contextPath: string) => { const cli = selected.get(contextPath); if (!cli) throw new Error('Fixture runtime was never retained'); return cli },
  }
})
useFactoryPairing()

const coreMachineInstalls = (() => {
  if (coreCliMissing || !core || process.platform === 'win32') return false
  const api = spawnSync(process.execPath, [path.join(core, 'dist/agent-runtime/cli.js'), 'api'], { encoding: 'utf8' })
  try { return (JSON.parse(api.stdout.trim().split('\n').at(-1) ?? '{}') as { capabilities?: Record<string, number> }).capabilities?.machineInstalls === 1 } catch { return false }
})()

const graph: LoopGraph = { nodes: [
  { id: 'start', type: 'start', position: { x: 0, y: 0 } },
  { id: 'verify', type: 'core', position: { x: 0, y: 140 }, data: { kind: 'verify', label: 'Verify', params: { commands: 'configured', hostBlockers: true, machineInstalls: 'ask' } } },
  { id: 'done', type: 'core', position: { x: 0, y: 280 }, data: { kind: 'end', params: { outcome: 'success', requiresVerified: true } } },
  { id: 'failed', type: 'core', position: { x: 300, y: 280 }, data: { kind: 'end', params: { outcome: 'failure', reason: 'Verification failed' } } },
  { id: 'blocked', type: 'core', position: { x: 600, y: 280 }, data: { kind: 'end', params: { outcome: 'failure', blockerFrom: 'verify', reason: 'Host blocker: {{outputs.verify.blocker.requiredAction}}' } } },
], edges: [
  { id: 's', source: 'start', target: 'verify' }, { id: 'p', source: 'verify', target: 'done', label: 'pass' }, { id: 'f', source: 'verify', target: 'failed', label: 'fail' },
  { id: 'x', source: 'verify', target: 'failed', label: 'failed' }, { id: 'b', source: 'verify', target: 'blocked', label: 'blocked' },
], config: { maxIterations: 5, timeoutMinutes: 0 } }

let desktopDb: DbInstance, scratch: string
beforeEach(() => { desktopDb = initDesktopDb(':memory:'); scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'machine installs pairing '))) })
afterEach(() => { desktopDb.close(); rmSync(scratch, { recursive: true, force: true }) })

async function runNeedingRustTarget(id: string, decide: (pending: DefinitionInterrupt[]) => string | { text: string; optionId: string } | null) {
  const root = path.join(scratch, id), repository = path.join(root, 'repo'), backlog = path.join(root, 'backlog'), bin = path.join(root, 'bin')
  mkdirSync(repository, { recursive: true }); mkdirSync(backlog); mkdirSync(bin)
  const marker = path.join(root, 'wasm32-installed'), installLog = path.join(root, 'rustup.log')
  // The fake installer: records its argv and "installs" the target. Nothing real is installed.
  writeFileSync(path.join(bin, 'rustup'), `#!/bin/sh\necho "$@" >> "${installLog}"\necho "info: downloading component 'rust-std' for 'wasm32-unknown-unknown'"\ntouch "${marker}"\n`)
  chmodSync(path.join(bin, 'rustup'), 0o755)
  writeFileSync(path.join(repository, 'build.cjs'), `if(!require('fs').existsSync(${JSON.stringify(marker)})){process.stderr.write("error[E0463]: can't find crate for \`core\`\\n  = note: the \`wasm32-unknown-unknown\` target may not be installed");process.exit(101)}console.log('Finished')`)
  expect(spawnSync('git', ['init', '-q', repository]).status).toBe(0)
  expect(spawnSync('git', ['-C', repository, 'add', '.']).status).toBe(0)
  expect(spawnSync('git', ['-C', repository, '-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'base']).status).toBe(0)
  const runtime = path.join(backlog, '.specrails/pipeline', id); mkdirSync(runtime, { recursive: true })
  const contextPath = path.join(runtime, 'desktop-context.json'), configPath = path.join(root, 'config.json')
  writeFileSync(contextPath, JSON.stringify({ schemaVersion: 1, runId: id, backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }],
    ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Build for wasm', description: 'Build', repositoryIds: ['repo'] }] }))
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, enabled: true, providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }],
    agents: { architect: { provider: 'claude' }, developer: { provider: 'claude' }, reviewer: { provider: 'claude' } },
    verification: [{ repositoryId: 'repo', command: process.execPath, args: ['build.cjs'] }] }))
  const env = { ...process.env, SPECRAILS_GIT_AUTO: 'false' }
  const installs = createMachineInstalls({ store: createSqliteApprovalStore(desktopDb), runner: createProcessInstallRunner({ env: () => ({ ...process.env, PATH: `${bin}:/bin:/usr/bin` }) }) })
  const asked: DefinitionInterrupt[][] = [], lines: string[] = []
  const result = await runDefinitionLoop({ runId: id } as unknown as LoopRunRequest, id, {
    invoke: input => runAgentRuntimeInvocation(input.resume
      ? { contextPath, cwd: repository, env, engineVersion: 2, resume: true, interruptId: input.interruptId, answer: input.answer, timeoutMs: 120_000 }
      : { contextPath, configPath, cwd: repository, env, engineVersion: 2, change: 'wasm', timeoutMs: 120_000,
        prepareDefinition: config => compileLoopToDefinition(graph, { id: 'machine-install-pairing', title: 'Build', provider: 'claude', constants: {}, roles: config.roles, repositoryCount: 1 }) })
      .then(value => ({ ...value, runtimeStatus: value.runtimeStatus ?? 'failed' })),
    isCancelled: () => false, remainingMs: () => undefined, onLine: line => lines.push(line), onRuntimeEvent: () => {}, onSpawn: () => {}, onInvocationEnd: () => {},
    awaitHumanDecision: async (_reason, pending) => {
      asked.push(pending)
      const choice = decide(pending)
      if (choice === null) return { action: 'stop' }
      // The question card answers by option id, with the localized label as its text.
      return typeof choice === 'string' ? { action: 'resume', text: choice, interruptId: pending[0]!.id } : { action: 'resume', ...choice, interruptId: pending[0]!.id }
    },
    machineInstalls: {
      autoAnswer: interrupt => installs.autoAnswer(interrupt, line => lines.push(line)),
      answer: (interrupt, text) => installs.answer(interrupt, text, line => lines.push(line)),
      lookup: async () => null,
    },
  })
  return { result, asked, installLog, lines, installs }
}

it.skipIf(!coreMachineInstalls)('asks once with the exact command; Install runs it outside the run and Core verifies again by itself', async () => {
  const { result, asked, installLog, lines } = await runNeedingRustTarget('ask-install', () => 'install')
  expect(asked).toHaveLength(1)
  expect(asked[0]![0]).toMatchObject({ kind: 'question', nodePath: 'verify', value: {
    prompt: 'This run needs the Rust target wasm32-unknown-unknown. Install it with `rustup target add wasm32-unknown-unknown`?',
    options: [expect.objectContaining({ id: 'install' }), expect.objectContaining({ id: 'self' })],
    data: { kind: 'machine-install', command: 'rustup target add wasm32-unknown-unknown', tool: 'the Rust target wasm32-unknown-unknown' } } })
  expect(readFileSync(installLog, 'utf8').trim()).toBe('target add wasm32-unknown-unknown')
  expect(lines.join('\n')).toContain('Installed with rustup target add wasm32-unknown-unknown. The run continues.')
  expect(result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
}, 180_000)

it.skipIf(!coreMachineInstalls)('the question card\'s Install (option id, localized label) runs the approved install like the id itself', async () => {
  const { result, installLog } = await runNeedingRustTarget('ask-install-card', () => ({ text: 'Instalar', optionId: 'install' }))
  expect(readFileSync(installLog, 'utf8').trim()).toBe('target add wasm32-unknown-unknown')
  expect(result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
}, 180_000)

it.skipIf(!coreMachineInstalls)("I'll do it myself installs nothing and ends on the precise blocker; a remembered approval never asks", async () => {
  const declined = await runNeedingRustTarget('ask-decline', () => 'self')
  expect(existsSync(declined.installLog)).toBe(false)
  expect(declined.result).toMatchObject({ completion: { ok: false, blocker: { kind: 'toolchain', install: 'rustup target add wasm32-unknown-unknown',
    requiredAction: 'Run `rustup target add wasm32-unknown-unknown` yourself (it is shared by every project on this machine), then continue the run.' } } })
  // The person approved this exact command once before (any project): the next run installs it without asking.
  createSqliteApprovalStore(desktopDb).remember({ command: 'rustup target add wasm32-unknown-unknown', manager: 'rustup', tool: 'the Rust target wasm32-unknown-unknown' })
  const remembered = await runNeedingRustTarget('ask-remembered', () => { throw new Error('must not ask a remembered install') })
  expect(remembered.asked).toEqual([])
  expect(readFileSync(remembered.installLog, 'utf8').trim()).toBe('target add wasm32-unknown-unknown')
  expect(remembered.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
}, 180_000)
