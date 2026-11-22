import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { parseArgs, ArgsError } from './lib/args.mjs'
import { assertEvalTarget, assertClientHome, clientEnv, IsolationError } from './lib/isolation.mjs'
import { clientArgs, codexConfig, parseClientOutput, addUsage, authProblem } from './lib/clients.mjs'
import { nextReply, pendingConfirmation, asksPerson } from './lib/person.mjs'
import { SCENARIOS, selectScenarios, pendingReason, promptOf } from './lib/scenarios.mjs'
import { called, confirmedWithToken, neverCalled, onlyAdvertisedOffers, answeredIn, passed } from './lib/checks.mjs'
import { coreSelection, instanceEnv } from './lib/instance.mjs'

const userHome = '/Users/someone'

test('args: client is required, defaults are isolated', () => {
  assert.throws(() => parseArgs([], { userHome }), ArgsError)
  const o = parseArgs(['--client', 'claude', '--scenario', 'S5', '--repeat', '3'], { userHome, tmp: '/tmp' })
  assert.equal(o.home, '/Users/someone/.specrails-dev-mcpeval')
  assert.equal(o.port, 4400)
  assert.equal(o.clientPort, 4401)
  assert.equal(o.repeat, 3)
  assert.equal(o.stopAtWindow, 70)
  assert.throws(() => parseArgs(['--client', 'replay', '--v1'], { userHome }), /v1 needs a real client/)
  assert.throws(() => parseArgs(['--client', 'claude', '--repeat', '0'], { userHome }), /repeat/)
  assert.throws(() => parseArgs(['--client', 'claude', '--bogus'], { userHome }), /Unknown option/)
})

test('isolation: refuses the person\'s homes and ports', () => {
  const env = { userHome }
  assert.throws(() => assertEvalTarget({ home: '/Users/someone/.specrails', port: 4400 }, env), IsolationError)
  assert.throws(() => assertEvalTarget({ home: '/Users/someone/.specrails-dev', port: 4400 }, env), IsolationError)
  for (const port of [4200, 4201, 4300, 4301]) assert.throws(() => assertEvalTarget({ home: '/x/eval', port }, env), IsolationError)
  assert.deepEqual(assertEvalTarget({ home: '/x/eval', port: 4400, clientPort: 4401 }, env), { home: '/x/eval', port: 4400, clientPort: 4401 })
  assert.throws(() => assertClientHome('/Users/someone/.claude', '/tmp/w', env), IsolationError)
  assert.throws(() => assertClientHome('/Users/someone/.codex', '/tmp/w', env), IsolationError)
  assert.throws(() => assertClientHome('/elsewhere/h', '/tmp/w', env), IsolationError)
  assert.equal(assertClientHome('/tmp/w/runs/a/clients/S5-1', '/tmp/w', env), '/tmp/w/runs/a/clients/S5-1')
})

test('client env: temp HOME, no host session variables, credentials only when passed', () => {
  const base = { PATH: '/bin', HOME: '/Users/someone', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', ANTHROPIC_BASE_URL: 'http://proxy', SPECRAILS_MCP_V2: 'true', CLAUDE_CODE_OAUTH_TOKEN: 'tok', SECRET: 's' }
  const env = clientEnv(base, { home: '/tmp/w/h', pass: ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SESSION_ID', 'SECRET'] })
  assert.equal(env.HOME, '/tmp/w/h')
  assert.equal(env.PATH, '/bin')
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'tok')
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'ANTHROPIC_BASE_URL', 'SPECRAILS_MCP_V2']) assert.equal(env[key], undefined, key)
  assert.equal(env.SECRET, 's', 'an explicitly passed non-host variable is kept')
})

test('client argv: Claude only sees the eval server; Codex resumes by thread', () => {
  const claude = clientArgs({ client: 'claude', model: 'haiku', prompt: 'hi', configFile: '/tmp/w/mcp.json' })
  assert.ok(claude.includes('--strict-mcp-config'))
  assert.equal(claude[claude.indexOf('--mcp-config') + 1], '/tmp/w/mcp.json')
  assert.equal(claude[claude.indexOf('--allowedTools') + 1], 'mcp__specrails,ToolSearch')
  assert.ok(clientArgs({ client: 'claude', model: 'haiku', prompt: 'yes', session: 's1', configFile: 'c' }).includes('--resume'))
  assert.deepEqual(clientArgs({ client: 'codex', model: null, prompt: 'yes', session: 't1' }).slice(0, 2), ['exec', 'resume'])
  assert.ok(!clientArgs({ client: 'codex', model: null, prompt: 'p' }).includes('-m'))
  const toml = codexConfig({ command: '/usr/bin/node', args: ['/x/proxy.mjs', '--log', '/tmp/a b.jsonl'] })
  assert.match(toml, /\[mcp_servers\.specrails\]/)
  assert.match(toml, /args = \["\/x\/proxy\.mjs", "--log", "\/tmp\/a b\.jsonl"\]/)
  assert.match(toml, /tool_timeout_sec = 90/)
})

test('client output parsing: Claude stream-json and Codex JSONL', () => {
  const claude = parseClientOutput('claude', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__specrails__specrails_overview' }] } }),
    JSON.stringify({ type: 'result', session_id: 's1', result: 'Done.', is_error: false, total_cost_usd: 0.002, num_turns: 3, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } }),
  ].join('\n'))
  assert.equal(claude.session, 's1')
  assert.equal(claude.text, 'Done.')
  assert.equal(claude.toolUses, 1)
  assert.deepEqual(claude.tokens, { input: 10, output: 5, cacheRead: 100, cacheWrite: 50 })
  assert.equal(claude.costUsd, 0.002)
  const codex = parseClientOutput('codex', [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Hecho.' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 7 } }),
  ].join('\n'))
  assert.equal(codex.session, 't1')
  assert.equal(codex.text, 'Hecho.')
  assert.deepEqual(codex.tokens, { input: 20, output: 7, cacheRead: 5, cacheWrite: null })
  assert.deepEqual(addUsage({ input: 1, output: null, cacheRead: null, cacheWrite: null, costUsd: null }, { input: 2, output: 3, cacheRead: null, cacheWrite: null, costUsd: 0.1 }), { input: 3, output: 3, cacheRead: null, cacheWrite: null, costUsd: 0.1 })
  assert.ok(authProblem({ parsed: { error: 'Not logged in · Please run /login' }, stderr: '' }))
  assert.equal(authProblem({ parsed: { text: 'Merged.' }, stderr: '' }), null)
})

test('simulated person: answers a pending preview, then stops', () => {
  const preview = { tool: 'specrails_deliveries', args: { action: 'decide', decision: 'merge_local' }, code: 'confirmation_required', ok: false }
  const confirmed = { tool: 'specrails_deliveries', args: { action: 'decide', decision: 'merge_local', confirm: 'ct1.x' }, ok: true }
  assert.ok(pendingConfirmation([preview]))
  assert.equal(pendingConfirmation([preview, confirmed]), null)
  assert.equal(nextReply({ confirm: 'Yes.' }, { calls: [preview], lastText: 'Shall I merge it?', used: 0 }), 'Yes.')
  assert.equal(nextReply({ confirm: 'Yes.', decline: 'No.' }, { calls: [preview], lastText: '', used: 0 }), 'No.')
  assert.equal(nextReply({ confirm: 'Yes.' }, { calls: [preview, confirmed], lastText: 'Merged.', used: 1 }), null)
  assert.equal(nextReply({ question: 'Option B.' }, { calls: [], lastText: 'Which option do you prefer?', used: 0 }), 'Option B.')
  assert.equal(nextReply({ replies: ['a'] }, { used: 1 }), null)
  assert.ok(asksPerson('¿Quieres que la fusione?'))
  assert.equal(asksPerson('All done.'), false)
})

test('scenario catalogue: 15 scenarios, selection, pending reasons, prompts', () => {
  assert.equal(SCENARIOS.length, 15)
  assert.deepEqual(SCENARIOS.map(s => s.id), Array.from({ length: 15 }, (_, i) => `S${i + 1}`))
  assert.equal(selectScenarios('all').length, 15)
  assert.deepEqual(selectScenarios('s3,S5').map(s => s.id), ['S3', 'S5'])
  assert.throws(() => selectScenarios('S99'), /Unknown scenario/)
  const s1 = SCENARIOS[0]
  assert.match(pendingReason(s1, { specrails_blueprint: false }), /specrails_blueprint/)
  const s5 = SCENARIOS.find(s => s.id === 'S5')
  assert.equal(pendingReason(s5, { specrails_deliveries: true }), null)
  assert.match(pendingReason(s5, { specrails_deliveries: false }), /not implemented/)
  assert.match(promptOf(s5, { title: 'Badge', project: { name: 'shop' } }), /"Badge".*"shop"/)
  assert.match(promptOf(SCENARIOS.find(s => s.id === 'S14'), { title: 'Badge', project: { name: 'shop' } }), /Revisa/)
  for (const s of SCENARIOS) {
    assert.ok(s.referenceCalls > 0, `${s.id} has a reference call count`)
    if (s.seed) assert.equal(typeof s.check, 'function', `${s.id} checks what it seeds`)
    if (s.check) assert.equal(typeof s.reference, 'function', `${s.id} has a reference solution`)
  }
})

test('checks: calls, tokens, destructive calls, legal offers, language', () => {
  const calls = [
    { tool: 'specrails_inbox', args: { action: 'list' }, ok: true, text: '{"offers":[{"id":"decide.merge_local"}]}' },
    { tool: 'specrails_inbox', args: { action: 'act', offerId: 'decide.merge_local', confirm: 'ct1.x' }, ok: true, text: '' },
    { tool: 'specrails_deliveries', args: { action: 'decide', decision: 'merge_local', confirm: 'ct1.x' }, ok: true, text: '' },
  ]
  assert.equal(called(calls, 'specrails_inbox', 'list').pass, true)
  assert.equal(confirmedWithToken(calls, 'specrails_deliveries', 'decide').pass, true)
  assert.equal(confirmedWithToken([{ ...calls[2], args: { action: 'decide', decision: 'merge_local' } }], 'specrails_deliveries', 'decide').pass, false)
  assert.equal(neverCalled(calls, c => c.args.action === 'delete', 'no delete').pass, true)
  assert.equal(onlyAdvertisedOffers(calls).pass, true)
  assert.equal(onlyAdvertisedOffers([{ tool: 'specrails_inbox', args: { action: 'act', offerId: 'decide.discard' }, ok: true, text: '' }]).pass, false)
  assert.equal(answeredIn('He revisado la entrega y está lista para fusionar en local; el gasto de la semana es bajo.', 'es').pass, true)
  assert.equal(answeredIn('I merged the delivery.', 'es').pass, false)
  assert.equal(passed([]), false)
})

test('instance: v2 flag, headless, Core selection', () => {
  assert.deepEqual(instanceEnv({ v2: false }), { SPECRAILS_MCP_V2: 'false', SPECRAILS_HEADLESS: '1' })
  const env = instanceEnv({ v2: true, core: { runtime: '/c/dist/agent-runtime/index.js', bin: '/c/bin/specrails-core.mjs' }, engineLog: '/w/e.jsonl' })
  assert.equal(env.SPECRAILS_MCP_V2, 'true')
  assert.equal(env.SPECRAILS_CORE_RUNTIME_PATH, '/c/dist/agent-runtime/index.js')
  assert.equal(env.EVAL_ENGINE_LOG, '/w/e.jsonl')
  const core = coreSelection({ coreDir: '/c' }, file => file === path.join('/c', 'dist', 'agent-runtime', 'index.js'))
  assert.equal(core.bin, path.join('/c', 'bin', 'specrails-core.mjs'))
})
