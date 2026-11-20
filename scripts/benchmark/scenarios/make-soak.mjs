#!/usr/bin/env node
// Generates soak-night.json: an overnight soak of Implement (several long runs on
// large repositories with slow suites, a multi-repo run, a held question, a run cost
// cap, a trickle of short runs, and a chaos schedule). Run: node make-soak.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bigSpec, slowSuite } from '../lib/big-repos.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const long = { timeoutMinutes: 660, answers: [{ recommended: true, once: false }], expect: { status: 'delivered' }, group: 'long' }
const shortSpec = 'Add `applyDiscount(total, percent)` to src/cart.js. It returns `total` reduced by `percent` (0-100), rounded to 2 decimals, and throws a RangeError when percent is outside 0-100. Add unit tests in test/cart.test.js. `npm test` must pass.'

const scenarios = [
  { ...long, name: 'long-xl-40', notes: '40 tasks, 40 files, 6-minute integration suite',
    repo: { template: 'big-lib-xl', name: 'long-xl-40' },
    ticket: { title: 'Forty small library features', description: bigSpec({ count: 40 }) } },
  { ...long, name: 'long-a-20', notes: '20 tasks, 3-minute suite, convention lint (correction rounds)',
    repo: { template: 'big-lib-a', name: 'long-a-20' },
    ticket: { title: 'Twenty library features with documented conventions', description: bigSpec({ count: 20, extra: ['Every new function also gets a usage example in README.md under a "## <module>" heading.'] }) } },
  { ...long, name: 'long-multi', notes: 'multi-repo: two large libraries, 12 + 12 tasks',
    repos: [{ template: 'big-lib-a', name: 'long-multi-core' }, { template: 'big-lib-b', name: 'long-multi-ext' }],
    ticket: { title: 'Features across both libraries', description: [
      'This change spans two repositories: `long-multi-core` (modules money … stats) and `long-multi-ext` (modules luhn … bloom). Implement each requirement in the repository that owns the module.',
      '', bigSpec({ count: 12 }), '', bigSpec({ count: 12, offset: 20 })].join('\n') } },
  { ...long, name: 'long-held', notes: 'question held 90 minutes before the answer; crosses 5-hour window boundaries',
    answers: [{ recommended: true, delayMinutes: 90 }, { recommended: true, once: false }],
    repo: { template: 'big-lib-b', name: 'long-held' },
    ticket: { title: 'Library features pending a formatting decision', description: bigSpec({ count: 20, offset: 20, extra: [
      'Before implementing `formatDuration`, ASK the person which output style they want: compact `1h 2m 3s` or clock `01:02:03`. Do not guess: the product owner has not decided yet.'] }) } },
  { ...long, name: 'long-cap', notes: 'run cost cap $0.40 on a long run', runCapUsd: 0.4, expect: { status: 'any' },
    repo: { template: 'big-lib-a', name: 'long-cap' },
    ticket: { title: 'Twenty features under a run cost cap', description: bigSpec({ count: 20 }) } },
  // Second wave of long runs once the first ones finish (keeps 3–5 long runs in flight).
  { ...long, name: 'long-xl-b', startAtMin: 240, notes: 'second 40-task run, starts at +4 h',
    repo: { template: 'big-lib-xl', name: 'long-xl-b' },
    ticket: { title: 'Forty library features, second wave', description: bigSpec({ count: 40 }) } },
  { ...long, name: 'long-a-limit', startAtMin: 200, notes: 'target of the simulated provider limit at +260 min',
    repo: { template: 'big-lib-a', name: 'long-a-limit' },
    ticket: { title: 'Twenty features, provider limit mid-run', description: bigSpec({ count: 20 }) } },
  // Trickle of short runs all night.
  { name: 'short', group: 'trickle', timeoutMinutes: 240, startAtMin: 10, repeat: { count: 26, everyMin: 25 },
    repo: { template: 'node-lib' }, ticket: { title: 'Add a discount helper', description: shortSpec },
    answers: [{ recommended: true, once: false }], expect: { status: 'delivered' } },
]

const chaos = [
  { atMin: 75, do: 'restart' },
  { atMin: 150, do: 'sigstop', seconds: 240 },
  { atMin: 225, do: 'kill' },
  { atMin: 260, do: 'fake-limit', match: 'long-a-limit', resetInMin: 25 },
  { atMin: 400, do: 'restart' },
  { atMin: 480, do: 'sigstop', seconds: 300 },
]

// A follow-up multi-repository soak (no chaos): launched beside soak-night by a second harness.
const multi = scenarios.find(s => s.name === 'long-multi')
fs.writeFileSync(path.join(here, 'soak-multi.json'), JSON.stringify({ defaults: { provider: 'claude', model: 'haiku', timeoutMinutes: 660 }, scenarios: [{ ...multi, name: 'long-multi2',
  repos: [{ template: 'big-lib-a', name: 'long-multi2-core' }, { template: 'big-lib-b', name: 'long-multi2-ext' }],
  ticket: { ...multi.ticket, description: multi.ticket.description.replaceAll('long-multi-', 'long-multi2-') } }] }, null, 2) + '\n')
// Second wave (a third harness, no chaos): a marathon (40 tasks, cross-cutting work, a
// 10-minute suite) and a suite slower than Core's 15-minute verification timeout.
fs.writeFileSync(path.join(here, 'soak-wave2.json'), JSON.stringify({ defaults: { provider: 'claude', model: 'haiku', timeoutMinutes: 660 }, scenarios: [
  { ...long, name: 'marathon', notes: '40 tasks + cross-cutting changes in every file, 10-minute suite',
    repo: { template: 'big-lib-xl', name: 'marathon', files: { 'test/integration/integration.test.js': slowSuite(40, 15) } },
    ticket: { title: 'Forty features plus a library-wide input contract', description: bigSpec({ count: 40, extra: [
      'Library-wide: every EXISTING exported function in `src/` validates its arguments and throws `TypeError` with the message `<module>.<function>: invalid <param>` for a wrong type; add one test per function in its unit test file.',
      'Add `src/index.js` re-exporting every module as a namespace (`export * as money from \'./money.js\'` …) and a test that imports each namespace.',
      'README.md: one `## <module>` section per module with a usage example of each new function.'] }) } },
  { ...long, name: 'verify-timeout', notes: 'integration suite of ~16 minutes, beyond the 15-minute verification timeout', expect: { status: 'any' },
    repo: { template: 'big-lib-a', name: 'verify-timeout', files: { 'test/integration/integration.test.js': slowSuite(32, 30) } },
    ticket: { title: 'Three features on a very slow suite', description: bigSpec({ count: 3 }) } },
] }, null, 2) + '\n')
fs.writeFileSync(path.join(here, 'soak-night.json'), JSON.stringify({ defaults: { provider: 'claude', model: 'haiku', timeoutMinutes: 660 }, scenarios, chaos }, null, 2) + '\n')
console.log(`soak-night.json: ${scenarios.length} scenario entries, ${chaos.length} chaos events`)
