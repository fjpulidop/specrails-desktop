// Summary of one parallel burst (pure): wall time to all settled, throughput,
// first-attempt delivery, corrections, cost, where the time went, and the
// machine/server metrics of the window.

import { summarizeMetrics } from './metrics.mjs'

const avg = (xs, digits = 1) => { const ys = xs.filter(Number.isFinite); const f = 10 ** digits; return ys.length ? Math.round(ys.reduce((a, b) => a + b, 0) / ys.length * f) / f : null }
const max = xs => { const ys = xs.filter(Number.isFinite); return ys.length ? Math.max(...ys) : null }

/**
 * @param {{ results: object[], startedAt: number, finishedAt: number, metrics: object[] }} burst
 * `results[i].timings` is `attributeRun` output for the run's first attempt (and
 * `attempts` the count of runs it took).
 */
export function summarizeBurst({ results, startedAt, finishedAt, metrics = [] }) {
  const n = results.length
  const delivered = results.filter(r => r.status === 'delivered')
  const wallS = Math.round((finishedAt - startedAt) / 1000)
  const firstAttempt = delivered.filter(r => (r.runIds?.length ?? 1) === 1).length
  const timings = results.map(r => r.timings).filter(Boolean)
  const phaseKeys = [...new Set(timings.flatMap(t => Object.keys(t.phaseS ?? {})))]
  return {
    n, delivered: delivered.length, firstAttempt, wallS,
    throughputPerHour: wallS > 0 ? Math.round(delivered.length / (wallS / 3600) * 10) / 10 : null,
    runS: { avg: avg(results.map(r => r.durationS)), max: max(results.map(r => r.durationS)) },
    launchMs: { avg: avg(results.map(r => r.launchMs)), max: max(results.map(r => r.launchMs)) },
    launchToFirstStepS: { avg: avg(timings.map(t => t.launchToFirstStepS)), max: max(timings.map(t => t.launchToFirstStepS)) },
    corePrepS: { avg: avg(timings.map(t => t.corePrepS)), max: max(timings.map(t => t.corePrepS)) },
    verifyWaitS: { avg: avg(timings.map(t => t.verifyWaitS)), max: max(timings.map(t => t.verifyWaitS)), waits: timings.reduce((s, t) => s + (t.verifyWaits ?? 0), 0) },
    phaseAvgS: Object.fromEntries(phaseKeys.map(key => [key, avg(timings.map(t => t.phaseS?.[key] ?? 0))])),
    corrections: avg(timings.map(t => t.corrections)),
    planRepairs: avg(timings.map(t => t.planRepairs)), reviewRejections: avg(timings.map(t => t.reviewRejections)),
    costPerRun: avg(results.map(r => r.costUsd), 3), costTotal: Math.round(results.reduce((s, r) => s + (Number(r.costUsd) || 0), 0) * 1000) / 1000,
    metrics: summarizeMetrics(metrics),
  }
}

/** Markdown lines for one burst summary. */
export function renderBurst(label, s) {
  const m = s.metrics
  return [
    `### ${label}`, '',
    `| N | Delivered | First attempt | Wall | Throughput | Run avg/max | Launch HTTP avg/max | Launch→first step | Core prep | Verify wait avg/max (waits) | Corrections | Cost/run | Health p50/p95/max | Board p95 | Stall max | CPU peak | RSS peak | Load peak | Free mem min |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
    `| ${s.n} | ${s.delivered} | ${s.firstAttempt} | ${s.wallS} s | ${s.throughputPerHour}/h | ${s.runS.avg}/${s.runS.max} s | ${s.launchMs.avg}/${s.launchMs.max} ms | ${s.launchToFirstStepS.avg}/${s.launchToFirstStepS.max} s | ${s.corePrepS.avg ?? '—'} s | ${s.verifyWaitS.avg}/${s.verifyWaitS.max} s (${s.verifyWaitS.waits}) | ${s.corrections} | $${s.costPerRun} | ${m.health.p50}/${m.health.p95}/${m.health.max} ms | ${m.board.p95} ms | ${m.stallLongestMs ?? '—'} ms | ${m.cpuPeak}% | ${m.rssPeakMb} MB | ${m.loadPeak} | ${m.availableMinMb} MB |`,
    '', `Plan repairs/run ${s.planRepairs}, review rejections/run ${s.reviewRejections}. Average seconds per phase: ${Object.entries(s.phaseAvgS).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '',
  ]
}
