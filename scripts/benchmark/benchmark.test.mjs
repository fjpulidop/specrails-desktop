import test from 'node:test'
import assert from 'node:assert/strict'
import { assertIsolatedTarget, assertLocalRemote, IsolationError } from './lib/isolation.mjs'
import { quotaDecision, quotaSample, quotaWindows } from './lib/quota.mjs'
import { parseScenarioText, chooseAnswer, ScenarioError } from './lib/scenarios.mjs'
import { renderReport, latencySummary } from './lib/report.mjs'
import { parseArgs, ArgsError } from './lib/args.mjs'
import { repoFiles } from './lib/repos.mjs'
import { withApproval, outcomeOf } from './lib/driver.mjs'

const env = { userHome: '/Users/me' }

test('isolation refuses the person\'s data home and ports', () => {
  assert.throws(() => assertIsolatedTarget({ home: '~/.specrails', port: 4660 }, env), IsolationError)
  assert.throws(() => assertIsolatedTarget({ home: '/Users/me/.specrails/', port: 4660 }, env), IsolationError)
  assert.throws(() => assertIsolatedTarget({ home: '/Users/me/.specrails/sub', port: 4660 }, env), IsolationError)
  assert.throws(() => assertIsolatedTarget({ home: '/Users/me', port: 4660 }, env), IsolationError)
  assert.throws(() => assertIsolatedTarget({ home: '~/.specrails-dev', port: 4660 }, env), IsolationError)
  assert.throws(() => assertIsolatedTarget({ home: '~/.specrails-dev-b', port: 4200 }, env), /4200/)
  assert.throws(() => assertIsolatedTarget({ home: '~/.specrails-dev-b', port: 4660, clientPort: 4201 }, env), /4201/)
  assert.throws(() => assertIsolatedTarget({ home: '~/.specrails-dev-b', port: 4660, clientPort: 4660 }, env), /differ/)
  assert.throws(() => assertIsolatedTarget({ port: 4660 }, env), /--home/)
  assert.deepEqual(assertIsolatedTarget({ home: '~/.specrails-dev-b', port: '4660', clientPort: 4661 }, env), { home: '/Users/me/.specrails-dev-b', port: 4660, clientPort: 4661 })
})

test('generation only pushes to local bare remotes inside the work dir', () => {
  assert.equal(assertLocalRemote('/w/remotes/a.git', '/w'), '/w/remotes/a.git')
  assert.throws(() => assertLocalRemote('git@github.com:me/a.git', '/w'), IsolationError)
  assert.throws(() => assertLocalRemote('https://github.com/me/a.git', '/w'), IsolationError)
  assert.throws(() => assertLocalRemote('/elsewhere/a.git', '/w'), IsolationError)
})

const usage = (claudeWeekly, claudeSession = 10) => ({ providers: [
  { providerId: 'claude', windows: [
    { id: 'five_hour', label: 'session', scope: 'account', usedPercent: claudeSession, resetsAt: '2026-11-20T00:00:00Z' },
    { id: 'seven_day', label: 'weekly', scope: 'account', usedPercent: claudeWeekly },
    { id: 'model:x', label: 'weekly', scope: 'model', usedPercent: 99 }] },
  { providerId: 'codex', windows: [] }] })

test('quota guard stops at the weekly threshold and on a full window', () => {
  assert.equal(quotaWindows(usage(50)).length, 2, 'model-scoped windows are ignored')
  assert.equal(quotaDecision(usage(94), { provider: 'claude', stopAtWeekly: 95 }).ok, true)
  const stop = quotaDecision(usage(95), { provider: 'claude', stopAtWeekly: 95 })
  assert.equal(stop.ok, false)
  assert.match(stop.reason, /weekly window at 95%/)
  assert.equal(quotaDecision(usage(40, 100), { provider: 'claude' }).ok, false)
  assert.match(quotaDecision(usage(40, 100), { provider: 'claude' }).reason, /session window at 100% until/)
  const none = quotaDecision(usage(99), { provider: 'codex' })
  assert.equal(none.ok, true)
  assert.match(none.reason, /no codex quota data/)
  assert.deepEqual(quotaSample(usage(80), new Date('2026-11-19T21:00:00Z')), { at: '2026-11-19T21:00:00.000Z', claude: { session: 10, weekly: 80 } })
})

const minimal = extra => JSON.stringify({ scenarios: [{ name: 'a', repo: 'node-lib', ticket: { title: 'T' }, ...extra }] })

test('scenario parsing fills defaults and validates', () => {
  const { scenarios } = parseScenarioText(minimal({}))
  assert.equal(scenarios[0].provider, 'claude')
  assert.equal(scenarios[0].model, 'haiku')
  assert.deepEqual(scenarios[0].repos, [{ template: 'node-lib', name: 'a', files: {} }])
  assert.equal(scenarios[0].expect.status, 'delivered')
  const multi = parseScenarioText(JSON.stringify({ scenarios: [{ name: 'm', repos: ['mr-api', 'mr-web'], ticket: { title: 'T' } }] })).scenarios[0]
  assert.deepEqual(multi.repos.map(r => r.name), ['m-mr-api', 'm-mr-web'])
  assert.throws(() => parseScenarioText('{'), ScenarioError)
  assert.throws(() => parseScenarioText(JSON.stringify({ scenarios: [] })), /non-empty/)
  assert.throws(() => parseScenarioText(minimal({ name: 'Bad Name' })), /name/)
  assert.throws(() => parseScenarioText(JSON.stringify({ scenarios: [{ name: 'a', repo: 'x', ticket: { title: 'T' } }, { name: 'a', repo: 'x', ticket: { title: 'T' } }] })), /Duplicate/)
  assert.throws(() => parseScenarioText(minimal({ provider: 'nope' })), /provider/)
  assert.throws(() => parseScenarioText(minimal({ answers: [{ optionId: 'a', approve: true }] })), /exactly one/)
  assert.throws(() => parseScenarioText(minimal({ answers: [{ match: '(' }] })), /regular expression/)
  assert.throws(() => parseScenarioText(minimal({ actions: [{ when: 'later', do: 'restart' }] })), /when/)
  assert.throws(() => parseScenarioText(minimal({ repo: { template: 'node-lib', files: { '../x': 'y' } } })), /relative/)
  assert.throws(() => parseScenarioText('a: 1', { format: 'yaml' }), /js-yaml/)
  assert.equal(parseScenarioText('x', { format: 'yaml', yamlLoad: () => JSON.parse(minimal({})) }).scenarios[0].name, 'a')
})

const question = { interruptId: 'i1', kind: 'question', asker: 'developer', text: 'Keep the string format?', options: [{ id: 'keep', label: 'Keep it' }, { id: 'cents', label: 'Use cents', meaning: 'integers' }], recommended: 'cents' }

test('answers pick options by id, recommended, approval and rejection', () => {
  const parse = answers => parseScenarioText(minimal({ answers })).scenarios[0].answers
  assert.deepEqual(chooseAnswer(question, parse([{ optionId: 'keep' }])).body, { text: 'Keep it', interruptId: 'i1', optionId: 'keep' })
  assert.deepEqual(chooseAnswer(question, parse([{ recommended: true }])).body, { text: 'Use cents — integers', interruptId: 'i1', optionId: 'cents' })
  assert.equal(chooseAnswer(question, parse([{ optionId: 'missing' }])), null, 'an option the card does not offer never matches')
  assert.equal(chooseAnswer(question, parse([{ asker: 'planner', text: 'x' }])), null)
  assert.equal(chooseAnswer(question, parse([{ match: 'string format', text: 'yes' }])).body.text, 'yes')
  const approval = { interruptId: 'a1', kind: 'approval', asker: 'run', text: 'Approve archive' }
  assert.deepEqual(chooseAnswer(approval, parse([{ kind: 'approval', approve: true }])).body, { text: '', interruptId: 'a1', approve: true })
  assert.deepEqual(chooseAnswer(approval, parse([{ kind: 'approval', reject: 'not now' }])).body, { text: 'not now', interruptId: 'a1', reject: true })
  const once = parse([{ text: 'first' }, { text: 'second' }])
  assert.equal(chooseAnswer(question, once, new Set([0])).body.text, 'second', 'a used once-only rule is skipped')
})

test('report renders totals, quota timeline and latency', () => {
  const md = renderReport({ startedAt: '2026-11-19T21:00:00Z', target: { port: 4660, home: '/h' }, options: { provider: 'claude', model: 'haiku', budgetRuns: 5, stopAtWeekly: 95 },
    stopReason: 'claude weekly window at 96%',
    results: [{ name: 'a', group: 'g', provider: 'claude', model: 'haiku', expected: 'delivered', status: 'delivered', pass: true, costUsd: 0.05, durationS: 120, launchMs: 300, questions: [{ asker: 'developer', answer: { optionId: 'x' } }], actions: [{ do: 'restart', t: 40 }], phases: [{ phase: 'build', t: 30 }], notes: [] },
      { name: 'b|c', group: 'g', provider: 'claude', model: 'haiku', expected: 'delivered', status: 'failed', pass: false, costUsd: 0.02, durationS: 60, questions: [], actions: [], phases: [], notes: ['x'] }],
    skipped: [{ name: 'z', reason: 'quota' }], quota: [{ at: '2026-11-19T21:00:00.000Z', claude: { weekly: 96 } }],
    latency: [{ healthMs: 3, boardMs: 30 }, { healthMs: 9, boardMs: 80 }] })
  assert.match(md, /\| 2 \| 1 \| 1 \| 0 \| 0 \| 0 \| 1\/2 \| \$0\.070 \|/)
  assert.match(md, /developer→x/)
  assert.match(md, /restart@40s/)
  assert.match(md, /\*\*failed\*\*/)
  assert.match(md, /b\\\|c/)
  assert.match(md, /\| 21:00Z \| 96% \|/)
  assert.match(md, /Stopped launching:\*\* claude weekly window at 96%/)
  assert.match(md, /build@30s/)
  assert.deepEqual(latencySummary([{ healthMs: 1, boardMs: 2 }]).health, { p50: 1, p95: 1, max: 1 })
})

test('args parse with defaults and reject unknown flags', () => {
  const o = parseArgs(['--scenarios', 's.json', '--home', 'h', '--port', '4660', '--budget-runs=3', '--only', 'a,b', '--dry-run'])
  assert.equal(o.budgetRuns, 3)
  assert.deepEqual(o.only, ['a', 'b'])
  assert.equal(o.dryRun, true)
  assert.equal(o.stopAtWeekly, 95)
  assert.equal(o.providerForced, false)
  assert.throws(() => parseArgs(['--scenarios']), ArgsError)
  assert.throws(() => parseArgs(['--bogus', 'x']), /Unknown/)
  assert.throws(() => parseArgs(['--home', 'h']), /--scenarios/)
  assert.throws(() => parseArgs(['--scenarios', 's', '--stop-at-weekly', '101']), /at most 100/)
})

test('templates, approval graph edit and outcome mapping', () => {
  assert.ok(repoFiles({ template: 'node-lib', name: 'x', files: { 'extra.md': 'y' } })['extra.md'])
  assert.throws(() => repoFiles({ template: 'nope', name: 'x' }), /Unknown repository template/)
  const g = withApproval({ config: { agents: { approvalBeforeArchive: false } }, nodes: [{ id: 'approve', data: { params: { enabled: false } } }, { id: 'x', data: { params: { enabled: false } } }] })
  assert.equal(g.config.agents.approvalBeforeArchive, true)
  assert.equal(g.nodes[0].data.params.enabled, true)
  assert.equal(g.nodes[1].data.params.enabled, false)
  assert.equal(outcomeOf({ final_outcome: 'success' }), 'delivered')
  assert.equal(outcomeOf({ final_outcome: 'cancelled' }), 'stopped')
  assert.equal(outcomeOf({ final_outcome: 'failure', runtime_status_json: JSON.stringify({ endReason: 'Not implemented: the person declined this ticket' }) }), 'declined')
  assert.equal(outcomeOf({ final_outcome: 'failure' }), 'failed')
})
