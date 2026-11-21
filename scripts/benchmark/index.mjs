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
import { quotaDecision, quotaSample, windowGate } from './lib/quota.mjs'
import { createApi } from './lib/api.mjs'
import { startServer, restartServer, stopServer, listenerPid, listenerPath, whichOnPath } from './lib/server.mjs'
import { needsFakeInstaller, installerIsFake } from './lib/isolation.mjs'
import { runScenario, prepareScenario } from './lib/driver.mjs'
import { createMetricsSampler } from './lib/metrics.mjs'
import { readRunTimings } from './lib/timings.mjs'
import { summarizeBurst, renderBurst } from './lib/parallel-report.mjs'
import { mergeObjective, pendingDeliveries } from './lib/merge.mjs'
import { renderReport } from './lib/report.mjs'
import { parseArgs } from './lib/args.mjs'
import { soakMain } from './lib/soak-main.mjs'

/** Per-run time attribution of every run of a result (an automatic continuation adds a run). */
function timingsOf(home, result) {
  try { return result.runIds?.length ? result.runIds.map((id, i) => readRunTimings(home, id, i === 0 ? result.launchedAt : null)).filter(Boolean) : null } catch (error) { result.notes.push(`timings: ${error.message}`); return null }
}

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

  const serverOpts = { desktopDir, home: target.home, port: target.port, clientPort: target.clientPort, coreBin: opts.coreBin, pathPrepend: opts.pathPrepend, inspectPort: opts.inspectPort, logFile: path.join(workDir, 'logs', 'server.log') }
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
  const writeReport = () => { session.finishedAt = new Date().toISOString(); fs.writeFileSync(reportFile, renderReport(session) + (session.burst ? ['', '## Parallel burst', '', ...renderBurst(`Burst of ${session.burst.n}`, session.burst)].join('\n') + '\n' : '')); fs.writeFileSync(reportFile.replace(/\.md$/, '.json'), JSON.stringify(session, null, 2)) }

  async function readQuota() {
    await api.post('/subscription-usage/refresh', {}).catch(() => null)
    await sleep(opts.quotaSettleMs)
    const usage = (await api.get('/subscription-usage')).data
    session.quota.push(quotaSample(usage))
    return usage
  }
  const cache = {}
  const server = { restart: graceful => restartServer(serverOpts, { graceful }) }
  if (opts.soak) {
    // Soak: a long night of runs with leak sampling, quota gating and a chaos schedule.
    const rawFile = /\.ya?ml$/i.test(opts.scenarios) ? {} : JSON.parse(fs.readFileSync(opts.scenarios, 'utf8'))
    if (opts.dryRun) { log(`soak dry run: ${chosen.length} scenarios, chaos ${JSON.stringify(rawFile.chaos ?? [])}`); return }
    await soakMain({ opts, chosen: chosen.slice(0, opts.budgetRuns), rawFile, target, api, workDir, log, server, serverOpts, desktopDir, cache })
    if (opts.stopServer) await stopServer({ port: target.port, home: target.home })
    process.exit(0)
  }
  if (opts.burst) {
    // Burst: prepare every scenario, then launch them all in the same instant,
    // so N rails really compete for the machine, the provider and the server.
    const chosenNow = chosen.slice(0, opts.budgetRuns)
    for (const s of chosen.slice(opts.budgetRuns)) session.skipped.push({ name: s.name, reason: `run budget (${opts.budgetRuns}) reached` })
    for (const provider of new Set(chosenNow.map(s => s.provider))) {
      const decision = quotaDecision(await readQuota(), { provider, stopAtWeekly: opts.stopAtWeekly })
      log(`quota: ${decision.reason}`)
      if (!decision.ok) { session.stopReason = decision.reason; for (const s of chosenNow) session.skipped.push({ name: s.name, reason: decision.reason }); writeReport(); return }
    }
    if (opts.dryRun) { writeReport(); return }
    const ctx = { api, workDir, server, log, cache }
    const prepared = new Map()
    const pending = [...chosenNow]
    await Promise.all(Array.from({ length: 4 }, async () => { for (let s = pending.shift(); s; s = pending.shift()) prepared.set(s.name, await prepareScenario(s, ctx)) }))
    log(`prepared ${prepared.size} scenarios`)
    const sampler = createMetricsSampler({ api, rootPid: () => listenerPid(target.port) })
    let quotaTicking = true
    const quotaTicker = (async () => { while (quotaTicking) { await sleep(opts.quotaEveryS * 1000); if (quotaTicking) await readQuota().catch(() => null) } })()
    const burstStart = Date.now()
    const results = await Promise.all(chosenNow.map(s => runScenario(s, ctx, prepared.get(s.name)).then(r => { log(`${s.name}: ${r.status} ${r.costUsd ?? '-'} USD ${r.durationS}s`); return r })))
    const burstEnd = Date.now()
    quotaTicking = false
    const metrics = await sampler.stop()
    await quotaTicker
    for (const r of results) { r.runTimings = timingsOf(target.home, r); r.timings = r.runTimings?.[0] ?? null }
    session.results.push(...results)
    session.metrics = metrics
    session.burst = summarizeBurst({ results, startedAt: burstStart, finishedAt: burstEnd, metrics })
    if (opts.mergeAfter) {
      // One objective, many rails: integrate every delivery of each shared project, in finishing order.
      session.merges = []
      for (const projectId of new Set(results.filter(r => r.projectId).map(r => r.projectId))) {
        const rails = await api.get(`/projects/${projectId}/rails`)
        const repoPath = path.join(workDir, 'repos', chosenNow.find(s => results.find(r => r.name === s.name)?.projectId === projectId).repos[0].name)
        const merged = await mergeObjective(api, projectId, { repoPath, log, deliveries: pendingDeliveries(rails.data) })
        session.merges.push({ projectId, ...merged })
      }
    }
    await readQuota().catch(() => null)
    writeReport()
    log(`report: ${reportFile}`)
    if (opts.stopServer) await stopServer({ port: target.port, home: target.home })
    return
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

  const queue = [...chosen]
  let launched = 0
  const running = new Set()
  while (queue.length || running.size) {
    while (queue.length && running.size < opts.parallel) {
      const s = queue.shift()
      if (launched >= opts.budgetRuns) { session.skipped.push({ name: s.name, reason: `run budget (${opts.budgetRuns}) reached` }); continue }
      let usage = await readQuota()
      // A short window (the 5-hour session) at --pause-at-window: wait for it to drop instead of launching.
      for (let gate = windowGate(usage, { provider: s.provider, pauseAt: opts.pauseAtWindow }); gate.wait && !opts.dryRun; gate = windowGate(usage, { provider: s.provider, pauseAt: opts.pauseAtWindow })) {
        log(`quota: waiting, ${gate.reason}`)
        await sleep(300_000)
        usage = await readQuota()
      }
      const decision = quotaDecision(usage, { provider: s.provider, stopAtWeekly: opts.stopAtWeekly })
      log(`quota: ${decision.reason}`)
      if (!decision.ok) { session.stopReason = decision.reason; session.skipped.push({ name: s.name, reason: decision.reason }); continue }
      if (opts.dryRun) { session.skipped.push({ name: s.name, reason: 'dry run (quota allowed launch)' }); continue }
      launched++
      const p = runScenario(s, { api, workDir, server, log, cache }).then(r => { r.runTimings = timingsOf(target.home, r); r.timings = r.runTimings?.[0] ?? null; session.results.push(r); running.delete(p); log(`${s.name}: ${r.status} ${r.costUsd ?? '-'} USD ${r.durationS}s`); writeReport() })
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
