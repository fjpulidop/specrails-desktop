#!/usr/bin/env node
// Generates one batch of the speed benchmark: every spec of lib/speed-suite.mjs
// `--reps` times, each copy on its own fresh repository, names prefixed by `--tag`.
//   node scripts/benchmark/scenarios/make-speed.mjs --tag a1 --reps 3 [--only money,slugify] > /tmp/speed-a1.json
import { speedScenarios } from '../lib/speed-suite.mjs'

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback }
const tag = arg('tag')
if (!/^[a-z0-9]{1,8}$/.test(tag ?? '')) { console.error('--tag <a-z0-9, at most 8> is required'); process.exit(2) }
const only = arg('only') ? arg('only').split(',') : null
process.stdout.write(JSON.stringify({ defaults: { provider: 'claude', model: 'haiku', timeoutMinutes: 40 }, scenarios: speedScenarios({ tag, reps: Number(arg('reps', 3)), only }) }, null, 2) + '\n')
