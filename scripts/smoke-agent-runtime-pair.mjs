import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Exercise the compiled Desktop bridge and the real paired Core CLI together.
// The only model endpoint is a deterministic localhost fixture. No user project,
// user database, installed AI CLI or provider credential is used.
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--core')) throw new Error('Usage: node scripts/smoke-agent-runtime-pair.mjs [--core <built Core index.js>]')
const entry = path.resolve(args[1] ?? path.join(desktop, 'src-tauri/core/dist/agent-runtime/index.js'))
assert(fs.existsSync(entry), 'Build Core and assemble the paired source first')
assert(fs.existsSync(path.join(desktop, 'server/dist/modules/agent-runtime/runtime/agent-runtime-bridge.js')), 'Build the Desktop server first')
process.env.SPECRAILS_CORE_RUNTIME_PATH = entry
const require = createRequire(path.join(desktop, 'package.json'))
const { runAgentRuntimeInvocation } = require('./server/dist/modules/agent-runtime/runtime/agent-runtime-bridge.js')
const { loadCoreAgentRuntime } = require('./server/dist/modules/agent-runtime/runtime/agent-runtime-loader.js')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'specrails paired runtime ')))
const originalHomedir = os.homedir
os.homedir = () => path.join(root, 'home')
const repository = path.join(root, 'workspace with spaces')
const hooks = path.join(root, 'empty-hooks')
const change = 'paired-runtime-smoke', runId = 'paired-runtime-smoke'
const calls = [], rawEvents = [], selectedModels = []
let developerWrites = 0, reviewerResponses = 0
const review = {
  approved: true, summary: 'Fixture result and verification evidence match.', issues: [], score: 90,
  aspects: { type_correctness: 90, pattern_adherence: 90, test_coverage: 90, security: 90, architectural_alignment: 90 },
  acceptance: { criteria: [{ specId: '1', criterionIndex: 0, status: 'met', evidence: ['result.txt contains ready; paired verification passed'] }], checks: [], findings: [] },
}
const server = http.createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, undefined)
    let body = ''
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    const role = /one (architect|developer|reviewer) task/.exec(input.messages[0].content)?.[1]
    assert(role, 'Missing role instructions')
    calls.push(role)
    selectedModels.push(input.model)
    let message, finishReason = 'stop'
    const workflow = (action, extra = {}) => ({ id: 'openspec-' + action + '-' + String(extra.artifact ?? extra.path ?? ''), type: 'function', function: { name: 'openspec_workflow', arguments: JSON.stringify({ action, ...extra }) } })
    const hasTools = input.messages.some(item => item.role === 'tool')
    for (const item of input.messages.filter(item => item.role === 'tool')) assert(!JSON.parse(item.content).error, item.content)
    if (role === 'architect' && !hasTools) {
      const files = [
        ['proposal', 'proposal.md', '## Why\nCreate the result.\n## What Changes\n- Add result.\n## Capabilities\n### New Capabilities\n- `paired-runtime`: result behavior.\n### Modified Capabilities\nNone.\n## Impact\nresult.txt'],
        ['design', 'design.md', '# Design\nWrite UTF-8 result.txt.'],
        ['specs', 'specs/paired-runtime/spec.md', '## ADDED Requirements\n### Requirement: Fixture result\nThe system SHALL provide ready.\n#### Scenario: Result\n- **WHEN** implementation completes\n- **THEN** result.txt contains ready\n'],
        ['tasks', 'tasks.md', '- [ ] 1. Write the fixture result\n'],
      ]
      message = { role: 'assistant', content: null, tool_calls: [workflow('load_skill'), workflow('new'), ...files.flatMap(([artifact, file, content]) => [workflow('instructions', { artifact }), workflow('write_artifact', { path: file, content })])] }
    } else if (role === 'architect') message = { role: 'assistant', content: JSON.stringify({ confidence: 'high' }) }
    else if (role === 'developer' && !hasTools) message = { role: 'assistant', content: null, tool_calls: [
      workflow('load_skill'), workflow('instructions', { artifact: 'apply' }),
      { id: 'result', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: ++developerWrites === 1 ? 'incomplete\n' : 'ready\n' }) } },
      { id: 'tasks', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: `openspec/changes/${change}/tasks.md`, content: '- [x] 1. Write the fixture result\n' }) } },
    ] }
    else if (role === 'developer') message = { role: 'assistant', content: JSON.stringify({ summary: 'Implemented fixture', incomplete: [], verificationChecks: [{ key: 'fixture-harness', label: 'Persisted fixture', kind: 'harness', repositoryId: 'app', command: process.execPath, args: [], entrypoint: 'check.cjs', files: [{ path: 'check.cjs', content: 'const assert = require("node:assert/strict"); assert.equal(require("node:fs").readFileSync(process.env.SPECRAILS_CHECK_REPO_ROOT + "/result.txt", "utf8"), "ready\\n"); console.log("harness passed")' }] }] }) }
    else if (!hasTools) message = { role: 'assistant', content: null, tool_calls: [workflow('load_skill'), workflow('instructions', { artifact: 'apply' })] }
    else message = { role: 'assistant', content: JSON.stringify(++reviewerResponses === 1 ? { summary: 'Malformed fixture response requires the bounded repair' } : review) }
    finishReason = message.tool_calls ? 'tool_calls' : 'stop'
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 2 } }))
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: String(error) }))
  }
})

function git(args) {
  const result = spawnSync('git', ['-C', repository, '-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  return result.stdout.trim()
}
function inspect(contextPath) {
  const result = spawnSync(process.execPath, [path.join(path.dirname(entry), 'cli.js'), 'status', '--context', contextPath, '--compact'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  return JSON.parse(result.stdout)
}
try {
  fs.mkdirSync(repository); fs.mkdirSync(hooks)
  git(['init', '-q'])
  fs.writeFileSync(path.join(repository, 'README.md'), '# Temporary runtime fixture\n')
  git(['add', '.'])
  git(['-c', 'user.name=Runtime Fixture', '-c', 'user.email=runtime@example.invalid', 'commit', '-qm', 'baseline'])
  const originalHead = git(['rev-parse', 'HEAD'])
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const config = {
    schemaVersion: 1, enabled: true,
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, { id: 'unused', kind: 'cli', cli: 'claude' }],
    agents: Object.fromEntries(['architect', 'developer', 'reviewer'].map(role => [role, { provider: role === 'reviewer' ? 'local' : 'unused', model: role === 'reviewer' ? 'offline-fixture' : 'sonnet', ...(role === 'reviewer' ? { escalation: { model: 'offline-rescue' } } : {}) }])),
    verification: [{ repositoryId: 'app', key: 'host-result', label: 'Result contract', policy: { reuse: 'snapshot-local', deterministic: true, readOnly: true, inputs: ['result.txt'], toolchainInputs: [fs.realpathSync(process.execPath)], resources: [] }, command: fs.realpathSync(process.execPath), args: ['-e', 'require("node:assert/strict").equal(require("node:fs").readFileSync("result.txt","utf8"),"ready\\n");console.log("paired verification passed")'] }],
    limits: { timeoutMs: 180_000, maxAttempts: 2 }, approvalBeforeArchive: true,
  }
  const stateDirectory = path.join(repository, '.specrails/pipeline', runId)
  fs.mkdirSync(stateDirectory, { recursive: true })
  const contextPath = path.join(stateDirectory, 'desktop-context.json')
  fs.writeFileSync(contextPath, JSON.stringify({
    schemaVersion: 1, runId, backlogRoot: repository, artifactRoot: repository, artifactRepositoryId: 'app',
    repositories: [{ id: 'app', name: 'Fixture', path: repository }],
    ownership: { git: 'host', backlog: 'host', worktrees: 'host' },
    specs: [{ id: 1, title: 'Paired runtime', description: 'Create result.txt containing ready and verify it.', repositoryIds: ['app'], acceptanceCriteria: ['The result file contains ready.'] }],
  }))
  const configPath = path.join(repository, '.specrails/agent-runtime.json')
  fs.writeFileSync(configPath, JSON.stringify(config))
  ;(await loadCoreAgentRuntime()).validateRuntimeConfig(config)
  const fixturePath = path.resolve(path.dirname(entry), '../../schemas/fixtures/runtime-efficiency-summary.v1.json')
  if (fs.existsSync(fixturePath)) {
    const { readRuntimeEfficiencySummary } = require('./server/dist/modules/agent-runtime/runtime/agent-runtime-metrics.js')
    const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).fixtures
    for (const fixture of Object.values(fixtures)) assert(readRuntimeEfficiencySummary(fixture), 'Packaged Core summary must be accepted by Desktop')
    assert.equal(fs.readFileSync(fixturePath, 'utf8'), fs.readFileSync(path.join(desktop, 'server/schemas/fixtures/runtime-efficiency-summary.v1.json'), 'utf8'), 'Vendored contract fixture must match the paired package')
  }

  const options = { providerOverride: { provider: 'local', model: 'offline-fixture' }, contextPath, cwd: repository, env: process.env, timeoutMs: 190_000, onRawLine: line => rawEvents.push(JSON.parse(line)) }
  const paused = await runAgentRuntimeInvocation({ ...options, configPath, change })
  assert.equal(inspect(contextPath).state.status, 'paused', paused.errorText)
  assert.deepEqual(calls, ['architect', 'architect', 'developer', 'developer', 'developer', 'developer', 'reviewer', 'reviewer', 'reviewer', 'reviewer'])
  assert.equal(paused.cost, undefined, 'Missing endpoint billing must remain unknown')
  assert.equal(paused.tokens, 120)
  const frozenConfig = JSON.parse(fs.readFileSync(path.join(stateDirectory, 'desktop-runtime-config.json'), 'utf8'))
  assert(Object.values(frozenConfig.agents).every(agent => agent.provider === 'local'), 'The selected launch provider must replace all project role providers')
  assert.equal(config.agents.architect.provider, 'unused', 'Launch selection must not mutate the project settings')
  assert(selectedModels.includes('offline-rescue'), 'Malformed review must use the configured single escalation tier')
  const resumed = await runAgentRuntimeInvocation({ ...options, resume: true, approve: ['archive'] })
  assert.equal(resumed.failed, false, resumed.errorText)
  assert.equal(resumed.tokens, 24, 'Nonterminal resume rechecks and recertifies the candidate once')
  const completed = inspect(contextPath)
  assert.equal(completed.state.status, 'succeeded')
  assert.equal(completed.pipeline.verification.valid, true)
  assert.equal(completed.pipeline.phases.archive.status, 'done')
  assert.equal(fs.readFileSync(path.join(repository, 'result.txt'), 'utf8'), 'ready\n')
  assert(fs.existsSync(path.join(repository, 'openspec/specs/paired-runtime/spec.md')))
  assert.equal(git(['rev-parse', 'HEAD']), originalHead, 'Core must preserve host delivery ownership')
  const evidence = spawnSync(process.execPath, [path.join(path.dirname(entry), 'cli.js'), 'evidence', '--context', contextPath], { encoding: 'utf8' })
  assert.equal(evidence.status, 0, evidence.stderr)
  const listed = JSON.parse(evidence.stdout)
  assert(listed.items.some(item => item.sources.length === 1), 'Persisted harness sources must be discoverable')
  assert(completed.efficiencySummary.currentEvidenceIds.length === 2)
  assert(completed.efficiencySummary.checks.reused >= 1, 'Unchanged host evidence must be reusable on continuation')
  assert(rawEvents.some(event => event.kind === 'check-invalidated'), 'Failed verification must invalidate its evidence')
  const repeated = await runAgentRuntimeInvocation({ ...options, resume: true })
  assert.equal(repeated.failed, false, repeated.errorText)
  assert.equal(repeated.tokens, 0)
  assert.equal(calls.length, 12, 'Terminal resume must retain completed roles')
  assert(rawEvents.some(event => event.type === 'verification-output' && event.text.includes('paired verification passed')))
  console.log('Verified paired Desktop → Core → local HTTP tools → failed verification/correction → reviewer escalation → reused evidence → approval → archive; resume preserves roles, usage and Git ownership')
} finally {
  os.homedir = originalHomedir
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
