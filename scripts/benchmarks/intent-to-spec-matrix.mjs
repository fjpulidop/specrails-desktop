#!/usr/bin/env node
/**
 * Runs several Intent → Spec benchmark cases (intent-to-spec.mjs), a few at a time.
 *
 *   node scripts/benchmarks/intent-to-spec-matrix.mjs [case names…] [--parallel 2] [engine flags…]
 *
 * Without case names it runs every case in <registry>/.specrails/bench/cases/. Engine and
 * variant flags (--provider, --model, --effort, --tag, --max-quota) pass through to each case.
 * A case that exits 3 (the provider's quota is too low) stops further launches: the running
 * cases finish, the rest wait for the next scheduled pass. Logs: <registry>/.specrails/bench/logs/.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bench = path.join(process.env.SPECRAILS_REGISTRY_HOME || path.join(os.homedir(), '.specrails-dev'), '.specrails', 'bench')
const args = process.argv.slice(2)
const passthrough = []
const names = []
let parallel = 2
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === '--parallel') parallel = Math.max(1, Number(args[++index]) || 1)
  else if (arg.startsWith('--')) passthrough.push(arg, args[++index])
  else names.push(arg)
}
const casesDir = path.join(bench, 'cases')
const cases = (names.length ? names : fs.readdirSync(casesDir).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5)))
  .map((name) => path.join(casesDir, `${name}.json`))
const logs = path.join(bench, 'logs')
fs.mkdirSync(logs, { recursive: true })

const log = (...line) => console.log(new Date().toISOString().slice(11, 19), ...line)
let stopped = false
const outcomes = []

function runCase(file) {
  const name = path.basename(file, '.json')
  const logFile = path.join(logs, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}.log`)
  const out = fs.openSync(logFile, 'a')
  log(`start ${name} → ${logFile}`)
  return new Promise((done) => {
    const child = spawn(process.execPath, [path.join(here, 'intent-to-spec.mjs'), file, ...passthrough], { stdio: ['ignore', out, out] })
    child.on('exit', (code) => {
      fs.closeSync(out)
      if (code === 3) stopped = true
      outcomes.push({ name, code })
      log(`end ${name}: exit ${code}${code === 3 ? ' (quota: no more launches this pass)' : ''}`)
      done()
    })
  })
}

const queue = [...cases]
await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
  while (queue.length && !stopped) await runCase(queue.shift())
}))
log(`matrix done: ${outcomes.filter((entry) => entry.code === 0).length}/${cases.length} recorded${queue.length ? `, ${queue.length} not launched` : ''}`)
