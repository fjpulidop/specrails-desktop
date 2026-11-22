import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { parseArgs, ArgsError } from './lib/args.mjs'
import { assertEvalTarget, assertClientHome, clientEnv, IsolationError } from './lib/isolation.mjs'
import { clientArgs, codexConfig, parseClientOutput, addUsage, mergeUsage, authProblem } from './lib/clients.mjs'
import { nextReply, pendingConfirmation, asksPerson } from './lib/person.mjs'
import { SCENARIOS, selectScenarios, pendingReason, promptOf, spanishEnough } from './lib/scenarios.mjs'
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
  // Codex reports the thread's running total on every turn (resume included): the latest turn wins.
  const turn1 = { input: 224171, output: 500, cacheRead: 180000, cacheWrite: null, costUsd: null }
  const turn2 = { input: 306684, output: 726, cacheRead: 251392, cacheWrite: null, costUsd: null }
  assert.deepEqual(mergeUsage('codex', turn1, turn2), turn2)
  assert.equal(mergeUsage('claude', { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, costUsd: 0.1 }, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, costUsd: 0.1 }).input, 2)
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
  assert.ok(asksPerson('I need your go-ahead first.\n\n' + 'Details. '.repeat(80) + 'If you want it merged as-is, say so and I will run it.'))
})

test('scenario catalogue: 16 scenarios, selection, pending reasons, prompts', () => {
  assert.equal(SCENARIOS.length, 16)
  assert.deepEqual(SCENARIOS.map(s => s.id), Array.from({ length: 16 }, (_, i) => `S${i + 1}`))
  assert.equal(selectScenarios('all').length, 16)
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
    // Every scenario is wired now that phase 2 landed: it is pending only when a tool is missing on the instance.
    assert.equal(pendingReason(s, {}), null, `${s.id} is wired`)
  }
  // S13 runs the mcp connect CLI: only the replay client can play it.
  const s13 = SCENARIOS.find(s => s.id === 'S13')
  assert.match(pendingReason(s13, {}, { client: 'claude' }), /replay only/)
  assert.equal(pendingReason(s13, {}, { client: 'replay' }), null)
})

test('live-run lessons: dry runs never count as executed; the person answers a go-ahead request and a dry-run preview', () => {
  const dry = { tool: 'specrails_deliveries', args: { action: 'decide', decision: 'merge_local', dryRun: true }, ok: true, envelope: { data: { confirmToken: 'ct1.a.b.c.d' } } }
  const done = { tool: 'specrails_deliveries', args: { action: 'decide', decision: 'merge_local', confirm: 'ct1.a.b.c.d' }, ok: true }
  assert.equal(confirmedWithToken([dry, done], 'specrails_deliveries', 'decide').pass, true)
  assert.equal(called([dry], 'specrails_deliveries', 'decide').pass, false)
  assert.ok(pendingConfirmation([dry]))
  assert.equal(pendingConfirmation([dry, done]), null)
  assert.equal(nextReply({ confirm: 'Yes.' }, { calls: [dry], lastText: 'Here is what it would do.', used: 0 }), 'Yes.')
  assert.ok(asksPerson('Switching starts paid AI work, so I need your explicit go-ahead first.'))
  assert.equal(nextReply({ confirm: 'Yes, switch it.' }, { calls: [], lastText: 'Switching costs money, so I need your go-ahead first.', used: 0 }), 'Yes, switch it.')
  assert.ok(asksPerson('Necesito tu confirmación para fusionarla.'))
  assert.equal(asksPerson('Merged. Spend this week is $0.00.'), false)
})

test('legal offers: lean inbox items list offers as bare ids', () => {
  const calls = [
    { tool: 'specrails_inbox', args: { action: 'list' }, ok: true, text: '{"items":[{"ref":"inbox:p:review:d","offers":["decide.merge_local",{"id":"answer","needs":["answer"]}]}]}' },
    { tool: 'specrails_inbox', args: { action: 'act', offerId: 'decide.merge_local' }, ok: true, text: '' },
    { tool: 'specrails_inbox', args: { action: 'act', offerId: 'answer' }, ok: true, text: '' },
  ]
  assert.equal(onlyAdvertisedOffers(calls).pass, true)
  assert.equal(onlyAdvertisedOffers([...calls, { tool: 'specrails_inbox', args: { action: 'act', offerId: 'decide.discard' }, ok: true, text: '' }]).pass, false)
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

test('session auth: real HOME, eval server only, no config written outside the work dir', async () => {
  const { prepareClientHome, codexSessionOverrides, CODEX_SESSION_DISABLED_FEATURES } = await import('./lib/clients.mjs')
  const { parseArgs } = await import('./lib/args.mjs')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-auth-'))
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-user-'))
  const proxy = { command: '/usr/bin/node', args: ['/x/proxy.mjs', '--log', '/tmp/a b.jsonl'] }
  try {
    const claude = prepareClientHome({ client: 'claude', dir: path.join(root, 'c'), root, proxy, auth: 'session', userHome })
    assert.equal(claude.home, userHome)
    assert.ok(claude.cwd.startsWith(root + path.sep) && claude.configFile.startsWith(root + path.sep))
    const argv = clientArgs({ client: 'claude', model: 'haiku', prompt: 'hi', configFile: claude.configFile, auth: 'session', budgetUsd: 1 })
    assert.ok(argv.includes('--strict-mcp-config'))
    assert.equal(argv[argv.indexOf('--setting-sources') + 1], 'project,local')
    assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '1')
    assert.ok(!argv.some(a => /dangerously/.test(a)))
    const codex = prepareClientHome({ client: 'codex', dir: path.join(root, 'x'), root, proxy, auth: 'session', userHome })
    assert.equal(codex.codexHome, path.join(userHome, '.codex'))
    assert.deepEqual(fs.readdirSync(userHome), [], 'nothing is written to the person\'s home')
    const first = clientArgs({ client: 'codex', model: null, prompt: 'p', auth: 'session', codexOverrides: codex.codexOverrides })
    for (const flag of ['--ignore-user-config', '--ignore-rules']) assert.ok(first.includes(flag), flag)
    assert.ok(first.includes('mcp_servers.specrails.args=["/x/proxy.mjs", "--log", "/tmp/a b.jsonl"]'))
    assert.ok(first.includes('model_reasoning_effort="low"'))
    for (const f of CODEX_SESSION_DISABLED_FEATURES) assert.ok(first.includes(f), f)
    const resumed = clientArgs({ client: 'codex', model: null, prompt: 'yes', session: 't1', auth: 'session', codexOverrides: codex.codexOverrides })
    assert.deepEqual(resumed.slice(0, 2), ['exec', 'resume'])
    assert.ok(resumed.includes('--ignore-user-config'), 'a resumed turn ignores the person\'s config too')
    assert.ok(!codexSessionOverrides(proxy, { effort: null }).some(a => a.startsWith('model_reasoning_effort')))
    assert.throws(() => clientArgs({ client: 'codex', prompt: 'p', auth: 'session' }))
    assert.equal(parseArgs(['--client', 'codex', '--auth', 'session'], { userHome, tmp: root }).auth, 'session')
    assert.throws(() => parseArgs(['--client', 'replay', '--auth', 'session'], { userHome, tmp: root }))
    assert.throws(() => parseArgs(['--client', 'claude', '--auth', 'keychain'], { userHome, tmp: root }))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(userHome, { recursive: true, force: true })
  }
})

test('a Spanish reply reads as Spanish, short ones included; English does not', () => {
  assert.equal(spanishEnough('1 entregas; 1 esperan tu decisión.'), true)
  assert.equal(spanishEnough('5 eventos.'), true)
  assert.equal(spanishEnough('Se clasificaron 3 de 3 specs.'), true)
  assert.equal(spanishEnough('5 events.'), false)
  assert.equal(spanishEnough('Started 1 run(s). Call specrails_wait to follow them.'), false)
})
