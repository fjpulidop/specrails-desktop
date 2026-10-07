import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'
const fixture = vi.hoisted(() => ({ cli: null as string | null }))
vi.mock('./agent-runtime-loader', () => ({ validateRequestedRoleEfforts: vi.fn(), findCoreAgentRuntimeCli: () => fixture.cli, loadCoreAgentRuntime: async () => ({ api: { capabilities: { engineV2: 1, workflowDefinitions: 1, hostBlockers: 1 } }, validateWorkflowDefinition: (value: unknown) => ({ ok: true, version: 'hash-v1', definition: { ...value as object, version: 'hash-v1' }, graph: { nodes: [] } }), validateRuntimeConfig: (value: unknown) => value, rolePromptDefaults: () => ({}) }) }))
vi.mock('./agent-runtime-package', () => ({ retainAgentRuntime: () => fixture.cli, resolveRetainedAgentRuntime: () => fixture.cli }))
vi.mock('../../../path-resolver', () => ({ resolveBundledNodeExe: () => null }))
import { runAgentRuntimeInvocation } from './agent-runtime-bridge'

let root: string, contextPath: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runtime-bridge-host-blocker-'))
  vi.spyOn(os, 'homedir').mockImplementation(() => join(root, 'home'))
  contextPath = join(root, 'state', 'desktop-context.json')
  mkdirSync(join(root, 'state'))
  writeFileSync(contextPath, JSON.stringify({ runId: 'run-1', repositories: [{ id: 'front' }] }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ schemaVersion: 1, enabled: true, providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }], agents: { architect: { provider: 'claude' }, developer: { provider: 'claude' }, reviewer: { provider: 'claude' } }, verification: [{ repositoryId: 'front', command: 'npm', args: ['test'] }] }))
  fixture.cli = join(root, 'cli.mjs')
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); fixture.cli = null })

const blocker = { kind: 'network', reason: 'the Playwright browser download cannot reach its CDN from the verification environment', command: 'npx', args: ['playwright', 'install', 'chromium'], cwd: 'ticket-1', requiredAction: 'Run `npx playwright install chromium` in ticket-1 with network access, then retry the run' }
const definition = () => ({ schemaVersion: 1, id: 'implement', entry: 'verify', delivery: { requiresVerified: true }, nodes: {
  verify: { kind: 'verify', params: { commands: 'configured', hostBlockers: true, setup: 'configured' }, ends: { pass: 'done', fail: 'failed', failed: 'failed', blocked: 'host-blocked' } },
  'host-blocked': { kind: 'end', params: { outcome: 'failure', blockerFrom: 'verify', reason: 'Host blocker ({{outputs.verify.blocker.kind}}): {{outputs.verify.blocker.reason}} Required action: {{outputs.verify.blocker.requiredAction}}' }, ends: {} },
} })

it('maps a host-blocked end (Core succeeded exit, completion not ok) to runtimeStatus blocked and keeps the structured blocker', async () => {
  const result = { type: 'runtime-result', runId: 'run-1', status: 'succeeded', invocationUsage: { costUsd: null, inputTokens: 1, outputTokens: 1 },
    completion: { ok: false, verified: false, reasons: [`Host blocker (network): ${blocker.reason} Required action: ${blocker.requiredAction}`], blocker } }
  writeFileSync(fixture.cli!, `console.log(JSON.stringify(${JSON.stringify(result)}));`)
  const outcome = await runAgentRuntimeInvocation({ contextPath, cwd: root, env: { ...process.env, SPECRAILS_GIT_AUTO: 'false' }, configPath: join(root, 'config.json'), change: 'test-change', timeoutMs: 3000, engineVersion: 2, prepareDefinition: definition })
  expect(outcome).toMatchObject({ failed: true, runtimeStatus: 'blocked', errorText: expect.stringContaining('Required action: Run `npx playwright install chromium`'), completion: { ok: false, blocker } })
})
