import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePs, processTree, summarizeTree, processKind, parseVmStat, percentile, summarizeMetrics } from './lib/metrics.mjs'
import { attributeRun, phaseOf } from './lib/timings.mjs'
import { summarizeBurst, renderBurst } from './lib/parallel-report.mjs'
import { pendingDeliveries, previewSummary } from './lib/merge.mjs'
import { parseScenarioText } from './lib/scenarios.mjs'
import { parseArgs } from './lib/args.mjs'

test('process tree metrics: CPU, memory and provider processes of the server tree only', () => {
  const rows = parsePs([
    '  10     1  12.5  204800 /usr/bin/node server/index.ts',
    '  11    10  50.0  102400 claude -p --model haiku',
    '  12    11   5.0   10240 /bin/zsh -c git status',
    '  13    10  80.0  51200 node --test test/a.test.js',
    '  99     1 400.0  999999 unrelated',
  ].join('\n'))
  const tree = processTree(rows, 10)
  assert.deepEqual(tree.map(r => r.pid).sort(), [10, 11, 12, 13])
  const summary = summarizeTree(tree)
  assert.equal(summary.cpu, 148)
  assert.equal(summary.rssMb, 360)
  assert.equal(summary.kinds.claude, 1)
  assert.equal(processKind('/opt/codex exec'), 'codex')
  assert.deepEqual(processTree(rows, 12345), [])
})

test('vm_stat and percentiles', () => {
  const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  1000.\nPages inactive:  1000.\nPages speculative:  48.\nPages occupied by compressor:  64.\n'
  assert.deepEqual(parseVmStat(vm), { availableMb: 32, compressedMb: 1 })
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3)
  assert.equal(percentile([], 95), null)
  const s = summarizeMetrics([{ treeCpu: 100, healthMs: 2, stallTotal: 3, load1: 4, availableMb: 900 }, { treeCpu: 300, healthMs: 40, stallTotal: 7, load1: 9, availableMb: 700 }])
  assert.equal(s.cpuPeak, 300)
  assert.equal(s.stallCount, 4)
  assert.equal(s.availableMinMb, 700)
})

test('phase attribution of one run from its step events', () => {
  assert.equal(phaseOf('architect'), 'plan')
  assert.equal(phaseOf('developer'), 'develop')
  assert.equal(phaseOf('reviewer'), 'review')
  assert.equal(phaseOf('review-policy'), 'engine')
  assert.equal(phaseOf('fixer'), 'fix')
  assert.equal(phaseOf('verify-archive'), 'verify')
  const t = attributeRun({
    run: { id: 'r', final_outcome: 'success', status: 'completed', total_cost_usd: 0.05, started_at: '2026-11-20 10:00:00', finished_at: '2026-11-20 10:05:00' },
    steps: [
      { type: 'start', nodeId: 'architect', attemptId: 'a1', startedAtMs: 1000 }, { type: 'end', nodeId: 'architect', attemptId: 'a1', durationMs: 30_000 },
      { type: 'start', nodeId: 'architect', attemptId: 'a2', startedAtMs: 31_000 }, { type: 'end', nodeId: 'architect', attemptId: 'a2', durationMs: 10_000 },
      { type: 'start', nodeId: 'verify', attemptId: 'v', startedAtMs: 41_000 }, { type: 'end', nodeId: 'verify', attemptId: 'v', durationMs: 5_000 },
      { type: 'start', nodeId: 'fixer', attemptId: 'f', startedAtMs: 46_000 }, { type: 'end', nodeId: 'fixer', attemptId: 'f', durationMs: 7_000 },
    ],
    logs: ['[verification] Verification turn acquired after 12 s.', '[runtime] Core runtime ready (4.0 s)'],
    limits: [{ utilization: 0.28 }, { utilization: 0.3 }], launchedAt: 0,
  })
  assert.equal(t.totalS, 300)
  assert.equal(t.launchToFirstStepS, 1)
  assert.deepEqual(t.phaseS, { plan: 40, verify: 5, fix: 7 })
  assert.equal(t.planRepairs, 1)
  assert.equal(t.corrections, 1)
  assert.equal(t.verifyWaitS, 12)
  assert.equal(t.corePrepS, 4)
  assert.deepEqual(t.fiveHourUtilization, { first: 0.28, last: 0.3 })
})

test('burst summary: wall time, throughput, first-attempt deliveries and cost', () => {
  const results = [
    { status: 'delivered', runIds: ['a'], durationS: 100, launchMs: 500, costUsd: 0.04, timings: { phaseS: { plan: 10 }, corrections: 0, planRepairs: 0, reviewRejections: 0, verifyWaitS: 0, verifyWaits: 0 } },
    { status: 'delivered', runIds: ['b', 'b2'], durationS: 200, launchMs: 1500, costUsd: 0.06, timings: { phaseS: { plan: 30 }, corrections: 2, planRepairs: 1, reviewRejections: 1, verifyWaitS: 10, verifyWaits: 1 } },
  ]
  const s = summarizeBurst({ results, startedAt: 0, finishedAt: 200_000, metrics: [] })
  assert.equal(s.delivered, 2)
  assert.equal(s.firstAttempt, 1)
  assert.equal(s.throughputPerHour, 36)
  assert.equal(s.costPerRun, 0.05)
  assert.equal(s.phaseAvgS.plan, 20)
  assert.match(renderBurst('Burst of 2', s).join('\n'), /\| 2 \| 2 \| 1 \| 200 s \| 36\/h/)
})

test('one objective: pending deliveries in finishing order and preview summary', () => {
  const rails = { prDeliveries: { 0: { id: 'd0', railIndex: 0, decision: 'on_review', updatedAt: '2026-11-20T10:02:00Z' }, 1: { id: 'd1', railIndex: 1, decision: 'on_review', updatedAt: '2026-11-20T10:01:00Z' }, 2: { id: 'd2', railIndex: 2, decision: 'merged' } } }
  assert.deepEqual(pendingDeliveries(rails).map(d => d.id), ['d1', 'd0'])
  assert.deepEqual(previewSummary({ previews: [{ deliveryId: 'd0', railIndex: 0, status: 'conflicts', conflictFiles: ['src/cart.js'], baseAdvancedBy: 1, siblings: [{ railIndex: 1, files: ['src/cart.js'] }] }] }),
    [{ deliveryId: 'd0', rail: 0, status: 'conflicts', conflictFiles: ['src/cart.js'], baseAdvancedBy: 1, siblings: [{ rail: 1, status: null, files: ['src/cart.js'] }] }])
})

test('scenarios take a rail slot; burst and merge-after flags parse', () => {
  const { scenarios } = parseScenarioText(JSON.stringify({ scenarios: [{ name: 'o1', repo: { template: 'node-lib', name: 'shop' }, rail: 3, ticket: { title: 'x' } }] }))
  assert.equal(scenarios[0].rail, 3)
  assert.throws(() => parseScenarioText(JSON.stringify({ scenarios: [{ name: 'o1', repo: 'node-lib', rail: 12, ticket: { title: 'x' } }] })), /rail/)
  const o = parseArgs(['--scenarios', 'f.json', '--burst', '--merge-after', '--quota-every-s', '30'])
  assert.equal(o.burst, true)
  assert.equal(o.mergeAfter, true)
  assert.equal(o.quotaEveryS, 30)
})
