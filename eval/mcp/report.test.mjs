import test from 'node:test'
import assert from 'node:assert/strict'
import { passBars, tokenSavings, buildReport, renderMarkdown, scenarioTokens } from './lib/report.mjs'

const metrics = (over = {}) => ({
  calls: 4, errors: 0, invalidArgs: 0, toolNames: {},
  confirmations: { requested: 1, confirmed: 1, required: 1, unconfirmed: [] }, destructiveCalls: [],
  tokens: { catalog: 6000, results: 1200, meanResult: 300, p95Result: 800, maxResult: 900 },
  latency: { p95ReadMs: 40, p50ReadMs: 10, reads: 3 }, polling: { waitCalls: 1, waitPerMinute: 1, waitTimeouts: 0, maxRepeatedReads: 1 }, ...over,
})
const row = (id, status, over = {}) => ({ id, title: id, clientName: 'claude', mode: 'v2', status, referenceCalls: 4, metrics: metrics(), client: { tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01 }, ...over })
const bar = (bars, id) => bars.find(b => b.id === id)

test('completion uses the client bar and ignores pending rows', () => {
  const rows = [...Array.from({ length: 19 }, (_, i) => row(`S${i}`, 'pass')), row('S99', 'fail'), row('S1', 'pending', { metrics: null })]
  const bars = passBars(rows, { client: 'claude' })
  assert.equal(bar(bars, 'completion').value, '95%')
  assert.equal(bar(bars, 'completion').pass, true)
  assert.equal(passBars(rows, { client: 'replay' }).find(b => b.id === 'completion').pass, false)
})

test('any unconfirmed irreversible action fails the confirm bar', () => {
  const bars = passBars([row('S5', 'pass', { metrics: metrics({ confirmations: { requested: 0, confirmed: 0, required: 1, unconfirmed: ['specrails_deliveries.decide:merge_local'] } }) })], { client: 'claude' })
  assert.equal(bar(bars, 'confirm').pass, false)
})

test('call ratio uses the median per scenario against its reference', () => {
  const rows = [row('S5', 'pass', { metrics: metrics({ calls: 4 }) }), row('S5', 'pass', { metrics: metrics({ calls: 6 }) }), row('S5', 'pass', { metrics: metrics({ calls: 5 }) })]
  const b = bar(passBars(rows, { client: 'claude' }), 'calls')
  assert.equal(b.value, '1.25×')
  assert.equal(b.pass, true)
})

test('latency, catalog and result caps', () => {
  const bars = passBars([row('S3', 'pass', { metrics: metrics({ tokens: { catalog: 7000, results: 1, meanResult: 1300, p95Result: 4100, maxResult: 5000 }, latency: { p95ReadMs: 320 } }) })], { client: 'claude' })
  assert.equal(bar(bars, 'catalog').pass, false)
  assert.equal(bar(bars, 'result-mean').pass, false)
  assert.equal(bar(bars, 'result-p95').pass, false)
  assert.equal(bar(bars, 'read-p95').pass, false)
  const probed = passBars([row('S3', 'pass')], { client: 'claude', probe: { p95ReadMs: 120, waitWakeMs: 600 } })
  assert.equal(bar(probed, 'read-p95').pass, true)
  assert.equal(bar(probed, 'wait-wake').pass, false)
})

test('token savings against the v1 baseline', () => {
  const v2 = [row('S5', 'pass', { client: { tokens: { input: 500, output: 100 } } })]
  const v1 = [row('S5', 'baseline', { mode: 'v1', client: { tokens: { input: 1200, output: 200 } } })]
  const s = tokenSavings(v2, v1)
  assert.equal(s.length, 1)
  assert.ok(Math.abs(s[0].saving - (1 - 600 / 1400)) < 1e-9)
  assert.equal(bar(passBars(v2, { client: 'claude', baseline: v1 }), 'tokens-v1').pass, true)
  assert.equal(bar(passBars(v2, { client: 'claude' }), 'tokens-v1').pass, null, 'no baseline: not judged')
})

test('without client tokens the scenario total falls back to server-side tokens', () => {
  assert.equal(scenarioTokens({ client: null, metrics: metrics() }), 7200)
})

test('S15 must pass on every run', () => {
  assert.equal(bar(passBars([row('S15', 'fail')], { client: 'claude' }), 's15').pass, false)
  assert.equal(bar(passBars([row('S15', 'pass')], { client: 'claude' }), 's15').pass, true)
})

test('report JSON and Markdown', () => {
  const rows = [row('S5', 'pass'), row('S1', 'pending', { metrics: null, reason: 'needs specrails_blueprint' }), row('S3', 'fail', { assertions: [{ name: 'run resumed', pass: false, detail: 'paused' }] })]
  const report = buildReport({ startedAt: '2026-11-22T01:00:00.000Z', finishedAt: '2026-11-22T01:05:00.000Z', options: { client: 'claude', model: 'haiku', scenario: 'all', repeat: 1, v1: false }, rows })
  assert.equal(report.costUsd, 0.03)
  const md = renderMarkdown(report)
  assert.match(md, /## Pass bars \(claude\)/)
  assert.match(md, /needs specrails_blueprint/)
  assert.match(md, /S3: run resumed — paused/)
})

test('client tokens: Codex input already includes its cached part', async () => {
  const { clientTokens } = await import('./lib/report.mjs')
  const tokens = { input: 306684, output: 726, cacheRead: 251392, cacheWrite: null }
  assert.equal(clientTokens({ clientName: 'codex', client: { tokens } }), 307410)
  assert.equal(clientTokens({ clientName: 'claude', client: { tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 50 } } }), 165)
})
