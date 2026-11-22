import test from 'node:test'
import assert from 'node:assert/strict'
import { pairCalls, scenarioMetrics, maxRepeatedReads, canonical, percentile, parseLog, catalogTokens } from './lib/metrics.mjs'
import { approxTokens } from './lib/tokens.mjs'

const tokens = { count: approxTokens }
let t = 1000
let id = 0
const env = (ok, extra = {}) => ({ v: 2, ok, summary: 's', ...extra })
/** One request/response pair as the proxy logs it. */
function call(name, args, envelope, ms = 20, { isError = !envelope.ok } = {}) {
  const rid = ++id
  const start = (t += 100)
  t += ms
  const text = JSON.stringify(envelope)
  return [
    { t: start, d: 'in', m: { jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name, arguments: args } } },
    { t, d: 'out', m: { jsonrpc: '2.0', id: rid, result: { content: [{ type: 'text', text }], structuredContent: envelope, isError } } },
  ]
}
const listTools = tools => [
  { t: (t += 10), d: 'in', m: { jsonrpc: '2.0', id: 'list', method: 'tools/list' } },
  { t: (t += 5), d: 'out', m: { jsonrpc: '2.0', id: 'list', result: { tools } } },
]

test('pairs requests and responses and reads the envelope', () => {
  const { calls } = pairCalls([...call('specrails_overview', { action: 'app' }, env(true), 35)])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].tool, 'specrails_overview')
  assert.equal(calls[0].ms, 35)
  assert.equal(calls[0].ok, true)
})

test('counts a confirmed irreversible call as confirmed and an unconfirmed one as a violation', () => {
  const preview = env(false, { error: { code: 'confirmation_required', confirmToken: 'ct1.a.b.c.d' } })
  const records = [
    ...call('specrails_deliveries', { action: 'decide', ref: 'delivery:p/1', decision: 'merge_local' }, preview),
    ...call('specrails_deliveries', { action: 'decide', ref: 'delivery:p/1', decision: 'merge_local', confirm: 'ct1.a.b.c.d' }, env(true)),
    ...call('specrails_deliveries', { action: 'decide', ref: 'delivery:p/2', decision: 'discard' }, env(true)),
  ]
  const m = scenarioMetrics(records, tokens)
  assert.equal(m.confirmations.requested, 1)
  assert.equal(m.confirmations.confirmed, 1)
  assert.deepEqual(m.confirmations.unconfirmed, ['specrails_deliveries.decide:discard'])
  assert.equal(m.errors, 0, 'a confirmation request is not an error')
})

test('a v1 baseline accepts its boolean confirm', () => {
  const records = call('specrails_specs', { action: 'purge', ref: 'spec:p/1', confirm: true }, env(true))
  assert.deepEqual(scenarioMetrics(records, tokens, { v1: true }).confirmations.unconfirmed, [])
  assert.equal(scenarioMetrics(records, tokens).confirmations.unconfirmed.length, 1)
})

test('launching several specs needs a token; one spec under the threshold does not', () => {
  const many = call('specrails_runs', { action: 'launch', target: { specIds: [1, 2, 3] } }, env(true))
  const one = call('specrails_runs', { action: 'launch', target: { specIds: [1] } }, env(true))
  assert.equal(scenarioMetrics(many, tokens).confirmations.unconfirmed.length, 1)
  assert.equal(scenarioMetrics(one, tokens).confirmations.unconfirmed.length, 0)
})

test('lists destructive calls, refused ones marked', () => {
  const records = [
    ...call('specrails_specs', { action: 'delete', ref: 'spec:p/1' }, env(false, { error: { code: 'held' } })),
    ...call('specrails_specs', { action: 'list', project: 'p' }, env(true)),
  ]
  assert.deepEqual(scenarioMetrics(records, tokens).destructiveCalls, ['specrails_specs.delete (refused)'])
})

test('error classes: invalid arguments, unknown tool, not implemented', () => {
  const records = [
    ...call('specrails_runs', { action: 'get' }, env(false, { error: { code: 'invalid_input' } })),
    ...call('specrails_missions', { action: 'list' }, env(false, { error: { code: 'not_implemented' } })),
  ]
  const m = scenarioMetrics(records, tokens)
  assert.equal(m.errors, 2)
  assert.equal(m.invalidArgs, 1)
  assert.equal(m.wrongTool, 1)
})

test('response tokens, catalog tokens and read latency', () => {
  const tool = { name: 'specrails_overview', description: 'Overview', inputSchema: { type: 'object', properties: { action: { enum: ['app'] } } } }
  const records = [...listTools([tool]), ...call('specrails_overview', { action: 'app' }, env(true, { data: { x: 'y'.repeat(290) } }), 40), ...call('specrails_runs', { action: 'list' }, env(true), 300)]
  const m = scenarioMetrics(records, tokens)
  assert.equal(m.tokens.catalog, catalogTokens([tool], tokens))
  assert.ok(m.tokens.catalog > 0)
  assert.ok(m.tokens.maxResult >= 100)
  assert.equal(m.latency.p95ReadMs, 300)
  assert.equal(m.latency.reads, 2)
  assert.equal(m.catalogTools, 1)
})

test('repeated identical reads in a row', () => {
  const read = () => call('specrails_runs', { action: 'get', ref: 'run:p/1' }, env(true))
  const records = [...read(), ...read(), ...read(), ...call('specrails_runs', { action: 'pause', ref: 'run:p/1' }, env(true)), ...read()]
  assert.equal(maxRepeatedReads(pairCalls(records).calls), 3)
})

test('wait polling: calls per minute and timeouts', () => {
  const records = [
    ...call('specrails_wait', { action: 'until', refs: ['run:p/1'] }, env(true, { data: { fired: [], timedOut: true } }), 25_000),
    ...call('specrails_wait', { action: 'until', refs: ['run:p/1'] }, env(true, { data: { fired: [{}], timedOut: false } }), 5_000),
  ]
  const m = scenarioMetrics(records, tokens)
  assert.equal(m.polling.waitCalls, 2)
  assert.equal(m.polling.waitTimeouts, 1)
  assert.ok(m.polling.waitPerMinute > 0 && m.polling.waitPerMinute < 10)
})

test('canonical, percentile and parseLog helpers', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 0 }] }), canonical({ a: [2, { c: 0, d: 1 }], b: 1 }))
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5)
  assert.equal(percentile([], 50), null)
  assert.equal(parseLog('{"a":1}\n{torn\n{"b":2}\n').length, 2)
})
