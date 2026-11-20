#!/usr/bin/env node
// Live Implement benchmark against an ISOLATED Specrails server.
//
//   npm run benchmark -- --scenarios scripts/benchmark/scenarios/regression.json \
//     --home ~/.specrails-dev-bench --port 4660 --provider claude --model haiku \
//     --budget-runs 10 --stop-at-weekly 95 [--start-server --core-bin <path>] [--dry-run]
//
// Refuses ~/.specrails and ports 4200/4201. Never pushes anywhere but the local
// bare remotes it creates under --work-dir. See scripts/benchmark/README.md.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertIsolatedTarget } from './lib/isolation.mjs'
import { parseScenarioText } from './lib/scenarios.mjs'
import { quotaDecision, quotaSample } from './lib/quota.mjs'
import { createApi } from './lib/api.mjs'
import { startServer, restartServer, stopServer, listenerPid, listenerPath, whichOnPath } from './lib/server.mjs'
import { needsFakeInstaller, installerIsFake } from './lib/isolation.mjs'
import { runScenario } from './lib/driver.mjs'
import { renderReport } from './lib/report.mjs'
import { parseArgs } from './lib/args.mjs'

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function loadScenarios(file) {
  const text = fs.readFileSync(file, 'utf8')
  const yaml = /\.ya?ml$/i.test(file)
  let yamlLoad
  if (yaml) yamlLoad = (await import('js-yaml')).load
  return parseScenarioText(text, { format: yaml ? 'yaml' : 'json', yamlLoad })
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { process.stdout.write(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'README.md'), 'utf8')); return }
  const target = assertIsolatedTarget({ home: opts.home, port: opts.port, clientPort: opts.clientPort }, { userHome: os.homedir() })
  const { scenarios } = await loadScenarios(opts.scenarios)
  const chosen = scenarios.filter(s => !opts.only.length || opts.only.includes(s.name))
    .map(s => ({ ...s, provider: opts.providerForced ? opts.provider : s.provider, model: opts.modelForced ? opts.model : s.model }))
  const workDir = path.resolve(opts.workDir ?? path.join(os.tmpdir(), 'specrails-benchmark'))
  fs.mkdirSync(path.join(workDir, 'logs'), { recursive: true })
  const logFile = path.join(workDir, 'logs', 'benchmark.log')
  const log = line => { const l = `${new Date().toISOString().slice(11, 19)} ${line}`; fs.appendFileSync(logFile, l + '\n'); if (!opts.quiet) console.log(l) }

  const serverOpts = { desktopDir, home: target.home, port: target.port, clientPort: target.clientPort, coreBin: opts.coreBin, pathPrepend: opts.pathPrepend, logFile: path.join(workDir, 'logs', 'server.log') }
  if (opts.startServer && !listenerPid(target.port)) { const s = await startServer(serverOpts); log(`server started pid ${s.pid} in ${s.readyMs} ms`) }
  if (!listenerPid(target.port)) throw new Error(`Nothing listens on port ${target.port}; pass --start-server`)
  // Install questions run the installer on the SERVER's PATH: refuse unless its brew is a fake one.
  if (chosen.some(needsFakeInstaller)) {
    const brew = whichOnPath('brew', listenerPath(target.port, target.home))
    if (!installerIsFake(brew)) throw new Error(`Refusing install scenarios: the isolated server's brew is ${brew ?? 'missing'}, not a fake installer (pass --path-prepend scripts/benchmark/fake-installers:$BENCH_INSTALLED_DIR and restart it)`)
  }
  const api = createApi(target.port)
  const session = { startedAt: new Date().toISOString(), target, options: opts, results: [], quota: [], latency: [], skipped: [], stopReason: null }
  const reportFile = path.resolve(opts.report ?? path.join(workDir, 'report.md'))
  const writeReport = () => { session.finishedAt = new Date().toISOString(); fs.writeFileSync(reportFile, renderReport(session)); fs.writeFileSync(reportFile.replace(/\.md$/, '.json'), JSON.stringify(session, null, 2)) }

  async function readQuota() {
    await api.post('/subscription-usage/refresh', {}).catch(() => null)
    await sleep(opts.quotaSettleMs)
    const usage = (await api.get('/subscription-usage')).data
    session.quota.push(quotaSample(usage))
    return usage
  }
  // Responsiveness sampler: /api/health and /api/live-board latency every 5 s.
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      try {
        const t0 = performance.now(); await fetch(`${api.base}/api/health`, { signal: AbortSignal.timeout(30_000) }); const healthMs = Math.round(performance.now() - t0)
        const board = await api.get('/live-board', { timeoutMs: 60_000 })
        session.latency.push({ at: Date.now(), healthMs, boardMs: Math.round(board.ms), cards: board.data?.cards?.length ?? null })
      } catch { /* restarting */ }
      await sleep(5000)
    }
  })()

  const cache = {}
  const server = { restart: graceful => restartServer(serverOpts, { graceful }) }
  const queue = [...chosen]
  let launched = 0
  const running = new Set()
  while (queue.length || running.size) {
    while (queue.length && running.size < opts.parallel) {
      const s = queue.shift()
      if (launched >= opts.budgetRuns) { session.skipped.push({ name: s.name, reason: `run budget (${opts.budgetRuns}) reached` }); continue }
      const decision = quotaDecision(await readQuota(), { provider: s.provider, stopAtWeekly: opts.stopAtWeekly })
      log(`quota: ${decision.reason}`)
      if (!decision.ok) { session.stopReason = decision.reason; session.skipped.push({ name: s.name, reason: decision.reason }); continue }
      if (opts.dryRun) { session.skipped.push({ name: s.name, reason: 'dry run (quota allowed launch)' }); continue }
      launched++
      const p = runScenario(s, { api, workDir, server, log, cache }).then(r => { session.results.push(r); running.delete(p); log(`${s.name}: ${r.status} ${r.costUsd ?? '-'} USD ${r.durationS}s`); writeReport() })
      running.add(p)
    }
    if (running.size) await Promise.race(running)
  }
  sampling = false
  await sampler
  await readQuota().catch(() => null)
  writeReport()
  log(`report: ${reportFile}`)
  if (opts.stopServer) await stopServer({ port: target.port, home: target.home })
}

main().catch(error => { console.error(`benchmark: ${error.message}`); process.exitCode = 1 })
