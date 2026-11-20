import test from 'node:test'
import assert from 'node:assert/strict'
import { slopePerHour, summarizeSoak, segmentByPid, downsample, renderSoak } from './lib/soak-report.mjs'
import { parsePsStat, processCounters, descendants } from './lib/soak.mjs'
import { normalizeChaos, dueScenarios } from './lib/soak-main.mjs'
import { expandRepeats, normalizeScenarios, chooseAnswer } from './lib/scenarios.mjs'
import { windowGate, resetWords } from './lib/quota.mjs'
import { shouldResumeHeld } from './lib/driver.mjs'
import { parseArgs } from './lib/args.mjs'
import { bigLibFiles, bigSpec, MODULES } from './lib/big-repos.mjs'

const H = 3_600_000

test('slopePerHour fits a line and reports R²', () => {
  const pts = [0, 1, 2, 3].map(h => ({ x: h * H, y: 100 + 10 * h }))
  const s = slopePerHour(pts)
  assert.equal(Math.round(s.perHour), 10)
  assert.equal(s.r2, 1)
  assert.equal(slopePerHour(pts.slice(0, 2)), null)
  assert.equal(slopePerHour([{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }]), null)
})

test('summarizeSoak flags a memory leak only within one server process', () => {
  // Two server processes: the restart drops RSS; within the longest one RSS grows 30 MB/h.
  const samples = [
    ...[0, 1].map(h => ({ at: h * H, serverPid: 1, serverRssMb: 500 })),
    ...[2, 3, 4, 5, 6].map(h => ({ at: h * H, serverPid: 2, serverRssMb: 200 + 30 * (h - 2), walMb: 4 })),
  ]
  assert.equal(segmentByPid(samples).length, 2)
  const s = summarizeSoak(samples)
  assert.equal(s.serverProcesses, 2)
  assert.equal(Math.round(s.metrics.serverRssMb.slopePerHour), 30)
  assert.equal(s.metrics.serverRssMb.leak, true)
  assert.equal(s.metrics.walMb.leak, false)
})

test('renderSoak and downsample keep the last sample', () => {
  const samples = Array.from({ length: 100 }, (_, i) => ({ at: i * 60_000, serverPid: 1, serverRssMb: 100, healthMs: 2 }))
  const d = downsample(samples, 10)
  assert.ok(d.length <= 11)
  assert.equal(d.at(-1), samples.at(-1))
  const md = renderSoak(samples, { rows: 5 })
  assert.match(md, /Server RSS \(MB\) \| 100 \| 100/)
  assert.match(md, /\| Time \| Server RSS/)
})

test('processCounters counts Core children, zombies and marked orphans', () => {
  const rows = parsePsStat([
    '  10     1 Ss   1000 node server/index.ts',
    '  11    10 S    2048 node /h/.dev/runtime/bin/specrails-core.mjs run',
    '  12    11 S     512 claude -p',
    '  13    11 Z       0 (node)',
    '  14     1 S     100 node /h/.dev/runtime/bin/specrails-core.mjs stale',
    '  15     1 S     100 claude --other-user-session',
  ].join('\n'))
  assert.equal(descendants(rows, 10).length, 3)
  const c = processCounters(rows, 10, ['/h/.dev'])
  assert.deepEqual([c.treeProcesses, c.coreProcesses, c.coreRssMb, c.providerProcesses, c.zombies, c.orphans], [3, 1, 2, 1, 1, 1])
})

test('expandRepeats makes a trickle of copies with their own repository and start time', () => {
  const out = expandRepeats([{ name: 'short', repo: 'node-lib', startAtMin: 10, repeat: { count: 3, everyMin: 25 }, ticket: { title: 't' } }])
  assert.deepEqual(out.map(s => [s.name, s.repo.name, s.startAtMin]), [['short-1', 'short-1', 10], ['short-2', 'short-2', 35], ['short-3', 'short-3', 60]])
  const { scenarios } = normalizeScenarios({ scenarios: out })
  assert.deepEqual(scenarios.map(s => s.startAtMin), [10, 35, 60])
  assert.throws(() => expandRepeats([{ name: 'x', repeat: { count: 0 } }]), /repeat needs/)
})

test('a delayed answer rule carries its delay', () => {
  const { scenarios } = normalizeScenarios({ scenarios: [{ name: 'a', repo: 'node-lib', ticket: { title: 't' }, answers: [{ recommended: true, delayMinutes: 90 }] }] })
  const pick = chooseAnswer({ interruptId: 'i', options: [{ id: 'x', label: 'X' }], recommended: 'x' }, scenarios[0].answers)
  assert.equal(pick.delayMs, 90 * 60_000)
  assert.throws(() => normalizeScenarios({ scenarios: [{ name: 'a', repo: 'node-lib', ticket: { title: 't' }, answers: [{ text: 'x', delayMinutes: -1 }] }] }), /delayMinutes/)
})

test('soak quota gate waits on a hot short window and never on the weekly one', () => {
  const usage = { providers: [{ providerId: 'claude', windows: [{ label: 'session', usedPercent: 80, resetsAt: 'R', scope: 'account' }, { label: 'weekly', usedPercent: 90, scope: 'account' }] }] }
  assert.equal(windowGate(usage, { provider: 'claude', pauseAt: 75 }).wait, true)
  assert.match(windowGate(usage, { provider: 'claude', pauseAt: 75 }).reason, /session window at 80%/)
  assert.equal(windowGate(usage, { provider: 'claude', pauseAt: 85 }).wait, false)
  assert.equal(windowGate(usage, { provider: 'codex', pauseAt: 1 }).wait, false)
})

test('resetWords formats a provider-style reset time in the zone', () => {
  assert.equal(resetWords(new Date('2026-11-20T23:30:00Z'), 35, 'Europe/Madrid'), '1:05am (Europe/Madrid)')
})

test('chaos schedule and due scenarios', () => {
  const c = normalizeChaos([{ atMin: 20, do: 'kill' }, { atMin: 5, do: 'sigstop', seconds: 60 }])
  assert.deepEqual(c.map(x => x.do), ['sigstop', 'kill'])
  assert.throws(() => normalizeChaos([{ atMin: 1, do: 'reboot' }]), /chaos\[0\]/)
  assert.throws(() => normalizeChaos([{ atMin: 1, do: 'fake-limit' }]), /fake-limit needs/)
  const pending = [{ name: 'a', startAtMin: 0 }, { name: 'b', startAtMin: 30 }, { name: 'c', startAtMin: 5 }]
  assert.deepEqual(dueScenarios(pending, 10, 5).map(s => s.name), ['a', 'c'])
  assert.deepEqual(dueScenarios(pending, 10, 1).map(s => s.name), ['a'])
})

test('soak options and a configurable resume ceiling', () => {
  const o = parseArgs(['--scenarios', 'x.json', '--soak', '--duration-min', '700', '--inspect-port', '9471', '--max-auto-resumes', '12'])
  assert.deepEqual([o.soak, o.durationMin, o.inspectPort, o.maxAutoResumes, o.pauseAtWindow], [true, 700, 9471, 12, 85])
  assert.throws(() => parseArgs(['--scenarios', 'x', '--soak', '--burst']), /exclusive/)
  const held = { hold: { kind: 'restart' } }
  assert.equal(shouldResumeHeld(held, 3), false)
  assert.equal(shouldResumeHeld(held, 3, 12), true)
})

test('big libraries pass their own lint and the long spec numbers every module', () => {
  const files = bigLibFiles('x', { count: 5, slow: [2, 1] })
  assert.ok(files['scripts/lint.mjs'].includes("test/unit/' + stem"))
  assert.match(files['src/money.js'], /\/\*\*[\s\S]*@param \{\*\} a[\s\S]*@returns[\s\S]*export function add/)
  assert.match(files['test/integration/integration.test.js'], /for \(let i = 1; i <= 2; i\+\+\)/)
  const spec = bigSpec({ count: 3, extra: ['Extra.'] })
  assert.match(spec, /^1\. `src\/money\.js`/m)
  assert.match(spec, /^4\. Extra\./m)
  assert.equal(new Set(MODULES.map(m => m[0])).size, MODULES.length)
})
