#!/usr/bin/env node
// Generates soak-night2.json: the second overnight soak of Implement. It covers what
// the first night did not reach: runs of 3–6 hours (≈160-task specs, slow suites and
// slow unit tests), chaos on live long runs (SIGSTOP of the server and of a Core child,
// SIGKILL mid-step, graceful restarts), a simulated provider limit with the automatic
// resume, a provider switch from a limited Codex to Claude haiku, a question held
// 100 minutes and an approval held 75, a long capacity-queue hold (two rails of one
// project with SPECRAILS_MAX_RUNS_PER_PROJECT=1), a project daily budget across
// midnight, the run cap held over restarts, and a trickle of short runs.
// Run: node make-soak2.mjs (clock-based entries use the local time at generation).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { epicSpec, bigSpec, slowSuite, slowUnit } from '../lib/big-repos.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const long = { timeoutMinutes: 720, answers: [{ recommended: true, once: false }], expect: { status: 'delivered' }, group: 'long' }
const shortSpec = 'Add `applyDiscount(total, percent)` to src/cart.js. It returns `total` reduced by `percent` (0-100), rounded to 2 decimals, and throws a RangeError when percent is outside 0-100. Add unit tests in test/cart.test.js. `npm test` must pass.'
const slowRepo = (template, name, [subtests, seconds], unitSeconds) => ({ template, name, files: {
  'test/integration/integration.test.js': slowSuite(subtests, seconds),
  ...(unitSeconds ? { 'test/unit/zz-warmup.test.js': slowUnit(unitSeconds) } : {}) } })
const minutesUntil = clock => {
  const [h, m] = clock.split(':').map(Number); const at = new Date(); at.setHours(h, m, 0, 0)
  if (at < new Date()) at.setDate(at.getDate() + 1)
  return Math.max(0, Math.round((at - Date.now()) / 60_000))
}

const scenarios = [
  { ...long, name: 'epic-chaos', notes: '160 tasks, 13-min suite, 40-s unit tests; target of SIGSTOP-core, restarts and SIGKILL',
    repo: slowRepo('big-lib-xl', 'epic-chaos', [26, 30], 40),
    ticket: { title: 'One hundred sixty library requirements', description: epicSpec({ perModule: 4 }) } },
  { ...long, name: 'epic-limit', notes: '160 tasks, 12-min suite; simulated Claude session limit at +150 min (auto-resume at the reset)',
    repo: slowRepo('big-lib-xl', 'epic-limit', [24, 30], 40),
    ticket: { title: 'One hundred sixty requirements, provider limit mid-run', description: epicSpec({ perModule: 4 }) } },
  { ...long, name: 'epic-held', notes: '120 tasks, 10-min suite; a question held 100 min, then the archive approval held 75 min',
    approvalBeforeArchive: true,
    answers: [{ recommended: true, delayMinutes: 100 }, { kind: 'approval', approve: true, delayMinutes: 75 }, { recommended: true, once: false }],
    repo: slowRepo('big-lib-xl', 'epic-held', [20, 30], 30),
    ticket: { title: 'One hundred twenty requirements pending a formatting decision', description: epicSpec({ perModule: 3, extra: [
      'Before implementing `formatDuration`, ASK the person which output style they want: compact `1h 2m 3s` or clock `01:02:03`. Do not guess: the product owner has not decided yet.'] }) } },
  { ...long, name: 'queued-behind', startAtMin: 15, rail: 1, expect: { status: 'any' },
    notes: 'second rail of the epic-held project; SPECRAILS_MAX_RUNS_PER_PROJECT=1 keeps it queued for hours',
    repo: slowRepo('big-lib-xl', 'epic-held', [20, 30], 30),
    ticket: { title: 'Library-wide input contract', description: [
      'Every EXISTING exported function in `src/` validates its arguments and throws `TypeError` with the message `<module>.<function>: invalid <param>` for a wrong type; add one test per function in `test/unit/<module>.test.js`.',
      '', 'Out of scope: renaming or removing any existing export, adding dependencies.'].join('\n') } },
  { ...long, name: 'switch-codex', startAtMin: 20, provider: 'codex', model: undefined, providers: ['codex', 'claude'], expect: { status: 'delivered' },
    notes: 'starts on Codex, whose shim always answers a usage limit; the limit card switch moves it to Claude haiku',
    onLimit: { switchTo: { provider: 'claude', model: 'haiku' }, afterSeconds: 60 },
    repo: slowRepo('big-lib-a', 'switch-codex', [16, 30], 0),
    ticket: { title: 'Twenty features after a provider switch', description: bigSpec({ count: 20 }) } },
  { ...long, name: 'cap-held', startAtMin: 30, runCapUsd: 0.4, expect: { status: 'any' },
    notes: 'run cap $0.40: must stay held at its budget across the restarts (live recheck of D3)',
    repo: { template: 'big-lib-a', name: 'cap-held' },
    ticket: { title: 'Twenty features under a run cost cap', description: bigSpec({ count: 20 }) } },
  { ...long, name: 'midnight-budget', startAtMin: minutesUntil('23:05'), expect: { status: 'any' },
    notes: 'project daily budget set below its spend at 23:40, resumed after midnight, paused again by the new day\'s budget, cleared at 00:45',
    repo: slowRepo('big-lib-xl', 'midnight-budget', [12, 30], 20),
    ticket: { title: 'Eighty requirements across midnight', description: epicSpec({ perModule: 2 }) } },
  // A second wave of long runs after the first 5-hour window, to keep 3–4 long runs in flight.
  { ...long, name: 'epic-late', startAtMin: 270, notes: '160 tasks started at +4.5 h, crosses the 5-hour window and the late chaos',
    repo: slowRepo('big-lib-xl', 'epic-late', [24, 30], 40),
    ticket: { title: 'One hundred sixty requirements, second wave', description: epicSpec({ perModule: 4 }) } },
  { name: 'short', group: 'trickle', timeoutMinutes: 240, startAtMin: 10, repeat: { count: 18, everyMin: 30 },
    repo: { template: 'node-lib' }, ticket: { title: 'Add a discount helper', description: shortSpec },
    answers: [{ recommended: true, once: false }], expect: { status: 'delivered' } },
]

const chaos = [
  { atMin: 60, do: 'sigstop-core', seconds: 180, match: 'epic-chaos' },
  { atMin: 80, do: 'restart' },
  { atMin: 115, do: 'sigstop', seconds: 240 },
  { atMin: 150, do: 'fake-limit', match: 'epic-limit', resetInMin: 30 },
  { atMin: 185, do: 'kill' },
  { atClock: '23:40', do: 'api', label: 'project daily budget below its spend', method: 'PATCH', path: '/projects/{project:midnight-budget}/budget', body: { dailyBudgetUsd: 0.05 } },
  { atClock: '00:04', do: 'api', label: 'resume after midnight', method: 'POST', path: '/projects/{project:midnight-budget}/loop-runs/{run:midnight-budget}/resume', body: {} },
  { atClock: '00:45', do: 'api', label: 'clear the project daily budget', method: 'PATCH', path: '/projects/{project:midnight-budget}/budget', body: { dailyBudgetUsd: null } },
  { atClock: '00:46', do: 'api', label: 'resume after clearing', method: 'POST', path: '/projects/{project:midnight-budget}/loop-runs/{run:midnight-budget}/resume', body: {} },
  { atMin: 300, do: 'restart' },
  { atMin: 340, do: 'sigstop-core', seconds: 300 },
  { atMin: 400, do: 'kill' },
  { atMin: 470, do: 'sigstop', seconds: 300 },
  { atMin: 520, do: 'restart' },
]

fs.writeFileSync(path.join(here, 'soak-night2.json'), JSON.stringify({ defaults: { provider: 'claude', model: 'haiku', timeoutMinutes: 720 }, scenarios, chaos }, null, 2) + '\n')
console.log(`soak-night2.json: ${scenarios.length} scenario entries, ${chaos.length} chaos events`)
