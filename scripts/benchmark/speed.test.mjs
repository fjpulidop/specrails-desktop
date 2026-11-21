import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseTapSummary, unexpectedPaths, acceptanceVerdict, checkRepository } from './lib/acceptance.mjs'
import { quantile, median, specOf, runRow, summarize, mannWhitney, fisherExact, compareMetric, qualityFloor } from './lib/speed-stats.mjs'
import { attributeRun } from './lib/timings.mjs'
import { speedScenarios, SPEED_SPECS } from './lib/speed-suite.mjs'
import { normalizeScenarios } from './lib/scenarios.mjs'
import { createRepo } from './lib/repos.mjs'

test('parseTapSummary reads node --test TAP totals', () => {
  assert.deepEqual(parseTapSummary('ok 1 - a\n# tests 5\n# suites 0\n# pass 4\n# fail 1\n'), { tests: 5, pass: 4, fail: 1 })
  assert.deepEqual(parseTapSummary('garbage'), { tests: null, pass: null, fail: null })
})

test('unexpectedPaths flags lockfiles and stray files only', () => {
  assert.deepEqual(unexpectedPaths(['src/a.js', 'test/a.test.js', 'README.md', 'openspec/specs/x/spec.md', 'package-lock.json', 'notes.txt']), ['package-lock.json', 'notes.txt'])
})

test('acceptanceVerdict needs a branch, a green suite and every hidden test passing', () => {
  const ok = { branch: 'feat/1', suite: 'pass', lint: 'pass', hidden: { tests: 3, pass: 3, fail: 0 }, hiddenFiles: 1 }
  assert.equal(acceptanceVerdict(ok), true)
  assert.equal(acceptanceVerdict({ ...ok, lint: 'fail' }), false)
  assert.equal(acceptanceVerdict({ ...ok, hidden: { tests: 3, pass: 2, fail: 1 } }), false)
  assert.equal(acceptanceVerdict({ ...ok, hidden: { tests: null, pass: null, fail: null } }), false)
  assert.equal(acceptanceVerdict({ ...ok, branch: null }), false)
})

test('the speed suite expands into valid scenarios with hidden files kept out of the repository', () => {
  const { scenarios } = normalizeScenarios({ scenarios: speedScenarios({ tag: 'x1', reps: 2 }) })
  assert.equal(scenarios.length, SPEED_SPECS.length * 2)
  const multi = scenarios.find(s => s.name === 'x1-mr-email-1')
  assert.equal(multi.repos.length, 2)
  assert.ok(Object.keys(multi.repos[1].hidden)[0].startsWith('.acceptance/'))
  assert.equal(specOf('x1-mr-email-2'), 'mr-email')
})

test('checkRepository runs the hidden tests on the delivered branch, not on the base', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-test-'))
  try {
    const spec = { template: 'shop-lib', name: 'acc', files: {}, branch: 'main', hidden: SPEED_SPECS.find(s => s.key === 'discount').hidden[0] }
    const repo = createRepo(spec, work)
    const git = args => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'pipe' })
    assert.equal(checkRepository(repo, spec).failures[0], 'no delivered branch')
    git(['checkout', '-qb', 'feat/1'])
    fs.appendFileSync(path.join(repo, 'src/cart.js'), '\n/**\n * Discount.\n * @param {number} totalCents\n * @param {number} percent\n * @returns {number}\n */\nexport function applyDiscount(totalCents, percent) {\n  const valid = typeof percent === \'number\' && percent >= 0 && percent <= 100\n  if (!valid) throw new RangeError(\'percent\')\n  if (!Number.isInteger(totalCents) || totalCents < 0) throw new TypeError(\'total\')\n  return Math.floor((totalCents * (100 - percent)) / 100 + 0.5 + 1e-9)\n}\n')
    git(['commit', '-qam', 'discount'])
    git(['checkout', '-q', 'main'])
    const out = checkRepository(repo, spec)
    assert.equal(out.branch, 'feat/1')
    assert.deepEqual(out.changed, ['src/cart.js'])
    assert.equal(out.suite, 'pass'); assert.equal(out.lint, 'pass')
    assert.equal(out.hidden.fail, 0); assert.ok(out.hidden.pass > 0)
    assert.equal(out.pass, true)
    assert.equal(fs.existsSync(path.join(repo, '.acceptance')), false)
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
})

test('attributeRun sums role usage, verification commands and idle gaps', () => {
  const steps = [
    { type: 'start', nodeId: 'architect', attemptId: 'a', startedAtMs: 1000 }, { type: 'end', nodeId: 'architect', attemptId: 'a', durationMs: 10_000 },
    { type: 'start', nodeId: 'verify', attemptId: 'v', startedAtMs: 13_000 }, { type: 'end', nodeId: 'verify', attemptId: 'v', durationMs: 1000 },
  ]
  const roles = [{ nodePath: 'architect', durationMs: 9000, toolCalls: 4, promptBytes: 100, usage: { costUsd: 0.01, inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 900, uncachedInputTokens: 10 } }]
  const t = attributeRun({ run: { id: 'r', started_at: new Date(0).toISOString(), finished_at: new Date(16_000).toISOString() }, steps, logs: [], roles, checks: [{ nodePath: 'verify', durationMs: 700 }] })
  assert.equal(t.usage.plan.turns, 1); assert.equal(t.usage.plan.toolCalls, 4); assert.equal(t.usage.plan.costUsd, 0.01)
  assert.deepEqual(t.verification, { runs: 1, commandS: 0.7, byNode: { verify: 1 } })
  assert.deepEqual(t.idle, { betweenStepsS: 2, steps: 2, headS: 1, tailS: 2 })
})

test('quantile, median and the rank and exact tests', () => {
  assert.equal(median([3, 1, 2]), 2); assert.equal(quantile([1, 2, 3, 4], 0.9), 3.7); assert.equal(median([]), null)
  assert.ok(mannWhitney([1, 2, 3, 4, 5, 6], [10, 11, 12, 13, 14, 15]).p < 0.01)
  assert.ok(mannWhitney([1, 2, 3], [1, 2, 3]).p > 0.9)
  assert.ok(Math.abs(fisherExact(1, 9, 11, 3) - 0.0028) < 0.0005)
  assert.equal(fisherExact(5, 0, 5, 0), 1)
})

const row = (name, wallS, extra = {}) => runRow({ name, status: 'delivered', durationS: wallS, costUsd: 0.05, acceptance: { pass: true, repos: [{ suite: 'pass', lint: 'pass', hidden: { tests: 4, pass: 4 }, unexpected: [] }] }, runTimings: [{ usage: { plan: { turns: 1, durationS: wallS / 2, inputTokens: 10, outputTokens: 1, toolCalls: 3 } }, verification: { runs: 3, commandS: 1 }, idle: {}, totalS: wallS }], ...extra })

test('compareMetric normalizes by spec so a faster variant shows a ratio below 1', () => {
  const a = [row('a1-x-1', 100), row('a1-x-2', 110), row('a1-x-3', 90), row('a1-y-1', 300), row('a1-y-2', 320), row('a1-y-3', 280)]
  const b = [row('b1-x-1', 80), row('b1-x-2', 85), row('b1-x-3', 75), row('b1-y-1', 240), row('b1-y-2', 250), row('b1-y-3', 230)]
  const c = compareMetric(a, b, 'wallS')
  assert.ok(c.ratio > 0.7 && c.ratio < 0.85, String(c.ratio))
  assert.ok(c.ci[1] < 1)
  assert.ok(c.p < 0.05)
  assert.deepEqual(c.perSpec.x, { a: 100, b: 80 })
})

test('qualityFloor flags a variant that delivers or passes less', () => {
  const a = summarize([row('a1-x-1', 100), row('a1-x-2', 100)])
  const b = summarize([row('b1-x-1', 50), runRow({ name: 'b1-x-2', status: 'failed', durationS: 50 })])
  const floor = Object.fromEntries(qualityFloor(a, b).map(q => [q.key, q.worse]))
  assert.equal(floor.delivered, true); assert.equal(floor.accepted, true)
  assert.equal(qualityFloor(a, a).some(q => q.worse), false)
})

test('settledDelivery waits for the delivery of the run to leave building with its commits', async () => {
  const { settledDelivery } = await import('./lib/driver.mjs')
  const payload = decision => ({ prDeliveries: { d1: { id: 'd1', decision, runIds: ['r1'], branches: [{ branch: 'feat/1', finalSha: decision === 'building' ? null : 'abc' }] } } })
  assert.equal(settledDelivery(payload('building'), ['r1']), null)
  assert.equal(settledDelivery(payload('on_review'), ['other']), null)
  assert.deepEqual(settledDelivery(payload('on_review'), ['r1']), { id: 'd1', decision: 'on_review', statusCode: null, branches: [{ branch: 'feat/1', finalSha: 'abc' }] })
})
