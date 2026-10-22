// Opt-in live smoke: the built-in Freestyle factory runs end to end through
// Desktop's production loop executor, the real bridge and a real Core build,
// with REAL provider CLIs (paid; never runs in CI). It is the evidence gate for
// a provider's `freestyle` capability (see openspec/changes/freestyle-codex-gemini).
//   SPECRAILS_LIVE_FREESTYLE_PROVIDERS=codex,gemini npx vitest run server/modules/loops/runtime/loop-factory-freestyle.live.test.ts
// Core: SPECRAILS_CORE_SOURCE_DIR (default ../specrails-core, built dist).
// Models: SPECRAILS_LIVE_<PROVIDER>_MODEL overrides the cheap defaults below.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCoreAgentRuntimeApiCache, loadCoreAgentRuntime } from '../../agent-runtime/runtime/agent-runtime-loader'
import { createLoopExecutors } from './loop-executors'
import { getFactoryLoop } from './loop-factory'
import type { ReasoningEffort } from '../../../providers/types'

vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
// Runtime retention copies Core into the managed home; it has its own tests.
vi.mock('../../agent-runtime/runtime/agent-runtime-package', async importOriginal => {
  const original = await importOriginal<typeof import('../../agent-runtime/runtime/agent-runtime-package')>()
  const selected = new Map<string, string>()
  return { ...original,
    retainAgentRuntime: (cli: string, contextPath: string) => { selected.set(contextPath, cli); return cli },
    resolveRetainedAgentRuntime: (contextPath: string) => selected.get(contextPath) ?? null,
  }
})

const core = path.resolve(process.env.SPECRAILS_CORE_SOURCE_DIR ?? path.join(__dirname, '../../../../../specrails-core'))
const providers = (process.env.SPECRAILS_LIVE_FREESTYLE_PROVIDERS ?? '').split(',').map(id => id.trim()).filter(Boolean)
const enabled = providers.length > 0 && existsSync(path.join(core, 'dist/agent-runtime/cli.js'))
// Cheapest current models per provider; account access may require an override.
const models: Record<string, { model: string; effort?: ReasoningEffort }> = {
  claude: { model: process.env.SPECRAILS_LIVE_CLAUDE_MODEL ?? 'haiku' },
  codex: { model: process.env.SPECRAILS_LIVE_CODEX_MODEL ?? 'gpt-5.6-luna', effort: 'low' },
  gemini: { model: process.env.SPECRAILS_LIVE_GEMINI_MODEL ?? 'gemini-3.5-flash' },
  kimi: { model: process.env.SPECRAILS_LIVE_KIMI_MODEL ?? 'kimi-for-coding' },
}

const SUM_TEST = `const { test } = require('node:test')
const assert = require('node:assert/strict')
test('sum adds two numbers', () => {
  const { sum } = require('./sum.js')
  assert.equal(sum(2, 3), 5)
})
`

describe.skipIf(!enabled)('Freestyle factory with live providers', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'freestyle live ')))
    // Desktop-side state only: the provider CLIs keep the real HOME for auth.
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'))
    vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', path.join(core, 'dist/agent-runtime/index.js'))
    resetCoreAgentRuntimeApiCache()
  })
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs()
    if (process.env.SPECRAILS_LIVE_KEEP !== '1') rmSync(root, { recursive: true, force: true })
  })

  it.each(providers)('runs Freestyle on %s: agent writes code, verify runs, the decider settles the run', async provider => {
    const repo = path.join(root, `repo-${provider}`)
    mkdirSync(path.join(repo, '.specrails'), { recursive: true })
    const git = (...args: string[]) => expect(spawnSync('git', ['-C', repo, ...args]).status).toBe(0)
    expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0)
    writeFileSync(path.join(repo, 'sum.test.js'), SUM_TEST)
    writeFileSync(path.join(repo, '.gitignore'), '.specrails/\n')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline')
    // The project's saved runtime verification (Settings ▸ Agent runtime).
    writeFileSync(path.join(repo, '.specrails/agent-runtime.json'), JSON.stringify({
      schemaVersion: 1, enabled: true,
      verification: [{ repositoryId: 'repo', command: process.execPath, args: ['--test'] }],
    }))

    const capabilities = (await loadCoreAgentRuntime()).api?.capabilities
    const factory = getFactoryLoop('factory:freestyle', capabilities)!
    expect(factory.graph.nodes.some(node => node.data?.kind === 'decider')).toBe(true)
    const { model, effort } = models[provider] ?? { model: '' }
    const events: Array<Record<string, any>> = [], lines: string[] = []
    const started = Date.now()
    const result = await createLoopExecutors({ env: { ...process.env, SPECRAILS_TICKETS_PATH: path.join(repo, '.specrails/local-tickets.json') } }).runDefinition!({
      runId: `live-freestyle-${provider}-${Date.now()}`,
      request: {
        loopId: factory.id, loopName: factory.name, graph: factory.graph, projectId: 'live', cwd: repo, repositoryId: 'repo',
        provider, model, ...(effort ? { effort } : {}),
        runtimeProviderOverride: { provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
        spec: {
          id: 1, title: 'Add a sum function',
          description: 'Create sum.js in the repository root exporting `sum(a, b)` (CommonJS: `module.exports = { sum }`) that returns a + b. sum.test.js already exists; keep it and make `node --test` pass. Add one more test case for negative numbers.',
          acceptanceCriteria: ['sum.js exports sum(a, b) returning a + b', '`node --test` passes'],
        },
      },
      onRuntimeEvent: event => events.push(event), onLine: line => lines.push(line), timeoutMs: 15 * 60_000,
    })

    const lifecycle = events.filter(event => event.type === 'workflow-event').map(event => event.event)
    const steps = lifecycle.filter(event => ['step_succeeded', 'step_failed'].includes(event.type)).map(event => `${event.nodePath}:${event.type === 'step_succeeded' ? 'ok' : 'failed'}`)
    const invocations = lifecycle.filter(event => event.type === 'invocation_finished' || event.usage)
    const summary = {
      provider, model, effort: effort ?? null, durationMs: Date.now() - started,
      runtimeStatus: result.runtimeStatus, failed: result.failed, completion: result.completion, errorText: result.errorText ?? null,
      steps, eventTypes: [...new Set(lifecycle.map(event => event.type))],
      cost: result.cost ?? null, estimated: result.estimated, tokensIn: result.tokensIn ?? null, tokensOut: result.tokensOut ?? null,
      invocationUsage: invocations.map(event => ({ node: event.nodePath, usage: event.usage ?? null })),
      sumJs: existsSync(path.join(repo, 'sum.js')),
    }
    console.log(`[freestyle-live] ${JSON.stringify(summary)}`)
    if (process.env.SPECRAILS_LIVE_REPORT_DIR) {
      writeFileSync(path.join(process.env.SPECRAILS_LIVE_REPORT_DIR, `freestyle-${provider}.json`), JSON.stringify({ summary, lifecycle, log: lines.join('') }, null, 2))
    }

    expect(result, result.errorText).toMatchObject({ failed: false, runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
    expect(existsSync(path.join(repo, 'sum.js'))).toBe(true)
    // Independent re-check of the delivered tree, outside Core.
    execFileSync(process.execPath, ['--test'], { cwd: repo, stdio: 'pipe' })
    expect(steps).toEqual(expect.arrayContaining(['implement:ok', 'verify:ok', 'decide:ok']))
    // Honest accounting: a cost is either provider/rate-card derived or absent — never a fabricated zero.
    if (result.cost !== undefined) expect(result.cost).toBeGreaterThanOrEqual(0)
    expect(result.estimated).toBe(result.cost === undefined)
    expect(readFileSync(path.join(repo, 'sum.test.js'), 'utf8')).toContain('sum adds two numbers')
  }, 16 * 60_000)
})
