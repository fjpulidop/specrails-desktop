// Soak (long-running) mode of the benchmark: runs for `--duration-min`, launches
// each scenario at its `startAtMin` (trickles via `repeat`), gates launches on the
// app's quota signal (stops at the weekly threshold, WAITS while a short window is
// hot), fires a chaos schedule (restart, SIGKILL, SIGSTOP/SIGCONT, a simulated
// provider limit), and samples leaks and drift the whole time (lib/soak.mjs).
// The report is rewritten every few minutes, so a long night is never lost.

import fs from 'node:fs'
import path from 'node:path'
import { quotaDecision, quotaSample, windowGate, resetWords } from './quota.mjs'
import { runScenario } from './driver.mjs'
import { createSoakSampler, createWsWatcher } from './soak.mjs'
import { renderSoak, summarizeSoak } from './soak-report.mjs'
import { renderReport } from './report.mjs'
import { readRunTimings } from './timings.mjs'
import { listenerPid, ownedListener } from './server.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const CHAOS = new Set(['restart', 'kill', 'sigstop', 'fake-limit'])

/** Validate the scenario file's `chaos` list: [{ atMin, do, seconds?, match?, resetInMin? }]. Pure. */
export function normalizeChaos(list = []) {
  if (!Array.isArray(list)) throw new Error('"chaos" must be a list')
  return list.map((c, i) => {
    const atMin = Number(c?.atMin)
    if (!Number.isFinite(atMin) || atMin < 0 || !CHAOS.has(c?.do)) throw new Error(`chaos[${i}] needs atMin >= 0 and do (${[...CHAOS].join(' | ')})`)
    if (c.do === 'sigstop' && !(Number(c.seconds) > 0 && Number(c.seconds) <= 1800)) throw new Error(`chaos[${i}].seconds must be 1..1800`)
    if (c.do === 'fake-limit' && (!c.match || !(Number(c.resetInMin) > 0))) throw new Error(`chaos[${i}] fake-limit needs match and resetInMin`)
    return { atMin, do: c.do, seconds: Number(c.seconds ?? 0), match: c.match ?? null, resetInMin: Number(c.resetInMin ?? 0), fired: false }
  }).sort((a, b) => a.atMin - b.atMin)
}

/** Next scenarios to launch now: due by `startAtMin`, in order, up to `free` slots. Pure. */
export function dueScenarios(pending, elapsedMin, free) {
  return pending.filter(s => (s.startAtMin ?? 0) <= elapsedMin).slice(0, Math.max(0, free))
}

export async function soakMain({ opts, chosen, rawFile, target, api, workDir, log, server, serverOpts, desktopDir, cache }) {
  const t0 = Date.now()
  const durationMs = opts.durationMin * 60_000
  const launchUntil = t0 + (opts.launchUntilMin ?? opts.durationMin) * 60_000
  const deadline = t0 + durationMs
  const chaos = normalizeChaos(rawFile.chaos ?? [])
  const reportFile = path.resolve(opts.report ?? path.join(workDir, 'soak.md'))
  const samplesFile = reportFile.replace(/\.md$/, '.samples.jsonl')
  const session = { mode: 'soak', startedAt: new Date(t0).toISOString(), target, options: opts, results: [], quota: [], latency: [], skipped: [], stopReason: null, chaos: [], waits: [], inFlight: [] }

  const ws = createWsWatcher({ port: target.port, desktopDir, getToken: async () => (await (await fetch(`${api.base}/api/token`)).json()).token, log })
  const sampler = createSoakSampler({ api, rootPid: () => listenerPid(target.port), home: target.home, workDir, inspectPort: opts.inspectPort, outFile: samplesFile,
    markers: [target.home, workDir, opts.coreBin ? path.dirname(path.dirname(opts.coreBin)) : null].filter(Boolean), ws, intervalMs: opts.sampleEveryS * 1000, log })

  let usage = null
  async function readQuota() {
    await api.post('/subscription-usage/refresh', {}).catch(() => null)
    await sleep(opts.quotaSettleMs)
    usage = (await api.get('/subscription-usage')).data
    const sample = quotaSample(usage)
    session.quota.push(sample)
    log(`quota ${JSON.stringify(sample)}`)
    return usage
  }
  const writeReport = () => {
    session.finishedAt = new Date().toISOString()
    session.soak = summarizeSoak(sampler.samples)
    const md = [renderReport(session), '## Chaos', '', ...session.chaos.map(c => `- ${c.at} +${c.atMin} min: ${c.do} → ${c.result}`), '',
      '## Launch waits', '', ...session.waits.slice(-40).map(w => `- ${w.at}: ${w.reason}`), '',
      '## In flight at report time', '', ...session.inFlight.map(x => `- ${x}`), '', renderSoak(sampler.samples, { title: 'Soak series' })].join('\n')
    fs.writeFileSync(reportFile, md)
    fs.writeFileSync(reportFile.replace(/\.md$/, '.json'), JSON.stringify({ ...session, samples: undefined }, null, 2))
  }

  const ctx = { api, workDir, server, log, cache, maxAutoResumes: opts.maxAutoResumes }
  const pending = [...chosen].sort((a, b) => (a.startAtMin ?? 0) - (b.startAtMin ?? 0))
  const running = new Map()
  let launched = 0, lastQuota = 0, lastReport = Date.now(), stopped = false

  async function fireChaos(c) {
    const at = new Date().toISOString()
    let result = 'ok'
    try {
      if (c.do === 'restart' || c.do === 'kill') { const r = await server.restart(c.do === 'restart'); result = `server back in ${r.readyMs} ms (pid ${r.pid})` }
      else if (c.do === 'sigstop') {
        const pid = ownedListener(target.port, target.home)
        process.kill(pid, 'SIGSTOP'); log(`chaos: SIGSTOP ${pid} for ${c.seconds}s`)
        await sleep(c.seconds * 1000)
        process.kill(pid, 'SIGCONT')
        const h0 = performance.now(); await fetch(`${api.base}/api/health`, { signal: AbortSignal.timeout(120_000) }).catch(() => null)
        result = `stopped ${c.seconds}s; health answered ${Math.round(performance.now() - h0)} ms after SIGCONT`
      } else if (c.do === 'fake-limit') {
        const words = resetWords(new Date(), c.resetInMin)
        fs.mkdirSync(path.dirname(opts.limitSimFile), { recursive: true })
        fs.writeFileSync(opts.limitSimFile, `${c.match}|${words}\n`)
        setTimeout(() => { try { fs.rmSync(opts.limitSimFile, { force: true }); log('chaos: simulated limit lifted') } catch { /* gone */ } }, c.resetInMin * 60_000).unref?.()
        result = `simulated limit for cwd *${c.match}* until ${words}`
      }
    } catch (error) { result = `error: ${error.message}` }
    api.resetToken()
    session.chaos.push({ at, atMin: c.atMin, do: c.do, result })
    log(`chaos ${c.do}: ${result}`)
  }

  while (!stopped) {
    const now = Date.now()
    const elapsedMin = (now - t0) / 60_000
    for (const c of chaos) if (!c.fired && elapsedMin >= c.atMin) { c.fired = true; await fireChaos(c) }
    if (now - lastQuota >= opts.quotaEveryS * 1000 || !usage) { lastQuota = now; await readQuota().catch(error => log(`quota read failed: ${error.message}`)) }
    if (now < launchUntil && pending.length && running.size < opts.parallel && launched < opts.budgetRuns) {
      for (const s of dueScenarios(pending, elapsedMin, opts.parallel - running.size)) {
        const decision = quotaDecision(usage, { provider: s.provider, stopAtWeekly: opts.stopAtWeekly })
        if (!decision.ok) { session.stopReason = decision.reason; log(`quota stop: ${decision.reason}`); pending.length = 0; break }
        const gate = windowGate(usage, { provider: s.provider, pauseAt: opts.pauseAtWindow })
        if (gate.wait) { if (session.waits.at(-1)?.reason !== gate.reason) { session.waits.push({ at: new Date().toISOString(), reason: gate.reason }); log(`launch wait: ${gate.reason}`) } break }
        pending.splice(pending.indexOf(s), 1)
        launched++
        log(`soak launch ${s.name} at +${elapsedMin.toFixed(1)} min`)
        const p = runScenario(s, ctx).then(r => {
          try { r.timings = r.runIds?.[0] ? readRunTimings(target.home, r.runIds[0], r.launchedAt) : null } catch (error) { r.notes.push(`timings: ${error.message}`) }
          session.results.push(r); running.delete(s.name); log(`${s.name}: ${r.status} ${r.costUsd ?? '-'} USD ${r.durationS}s`); writeReport()
        })
        running.set(s.name, p)
      }
    }
    if (now >= launchUntil && pending.length) { for (const s of pending.splice(0)) session.skipped.push({ name: s.name, reason: 'launch window over' }) }
    if (now - lastReport >= 5 * 60_000) { lastReport = now; session.inFlight = [...running.keys()]; writeReport() }
    if (now >= deadline || (!pending.length && !running.size && chaos.every(c => c.fired))) stopped = true
    else await sleep(15_000)
  }
  session.inFlight = [...running.keys()]
  if (running.size) log(`soak deadline: ${running.size} scenario(s) still running: ${[...running.keys()].join(', ')}`)
  await sampler.stop()
  ws.stop()
  await readQuota().catch(() => null)
  writeReport()
  log(`soak report: ${reportFile}`)
  return session
}
