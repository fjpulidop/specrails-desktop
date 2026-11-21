// Speed benchmark statistics (pure): one row per scenario result, per-variant
// summaries (median, p90) and an A/B comparison that normalizes every run by its
// spec's baseline median, so specs of different sizes pool into one test.

const sum = xs => xs.reduce((a, b) => a + b, 0)
export const median = xs => quantile(xs, 0.5)
/** Linear-interpolated quantile; null for an empty list. */
export function quantile(xs, q) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!s.length) return null
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

/** `<tag>-<spec key>-<k>` → spec key (the key itself may contain dashes). */
export function specOf(name) {
  const parts = String(name).split('-')
  return parts.length >= 3 ? parts.slice(1, -1).join('-') : String(name)
}

/** One comparable row per scenario result of a benchmark session JSON. */
export function runRow(result) {
  const timings = result.runTimings ?? (result.timings ? [result.timings] : [])
  const phase = {}, tokens = { input: 0, output: 0, uncached: 0 }, turns = {}
  let toolCalls = 0, verifyRuns = 0, verifyS = 0, idleS = 0, coreS = 0
  for (const t of timings) {
    for (const [p, u] of Object.entries(t.usage ?? {})) {
      phase[p] = (phase[p] ?? 0) + u.durationS
      turns[p] = (turns[p] ?? 0) + u.turns
      tokens.input += u.inputTokens; tokens.output += u.outputTokens; tokens.uncached += u.uncachedInputTokens ?? 0
      toolCalls += u.toolCalls
    }
    verifyRuns += t.verification?.runs ?? 0
    verifyS += t.verification?.commandS ?? 0
    verifyS += t.verifyWaitS ?? 0
    idleS += (t.idle?.betweenStepsS ?? 0) + (t.idle?.headS ?? 0) + (t.idle?.tailS ?? 0)
    coreS += t.totalS ?? 0
  }
  const repos = result.acceptance?.repos ?? []
  const hiddenTests = sum(repos.map(r => r.hidden?.tests ?? 0)), hiddenPass = sum(repos.map(r => r.hidden?.pass ?? 0))
  return {
    name: result.name, spec: specOf(result.name), status: result.status, delivered: result.status === 'delivered',
    wallS: result.durationS ?? null, coreS: coreS || null, costUsd: result.costUsd ?? null,
    tokensIn: tokens.input, tokensOut: tokens.output, toolCalls,
    planS: phase.plan ?? 0, developS: phase.develop ?? 0, reviewS: phase.review ?? 0, fixS: phase.fix ?? 0,
    verifyS, verifyRuns, idleS, corrections: turns.fix ?? 0, planTurns: turns.plan ?? 0, reviewTurns: turns.review ?? 0,
    accepted: result.acceptance ? result.acceptance.pass : false,
    suitePass: repos.length ? repos.every(r => r.suite === 'pass') : false,
    lintPass: repos.length ? repos.every(r => r.lint !== 'fail') : false,
    hiddenPass, hiddenTests, unexpectedFiles: sum(repos.map(r => r.unexpected?.length ?? 0)),
    continuations: Math.max(0, timings.length - 1),
  }
}

const METRICS = ['wallS', 'coreS', 'costUsd', 'tokensIn', 'tokensOut', 'toolCalls', 'planS', 'developS', 'reviewS', 'fixS', 'verifyS', 'verifyRuns', 'idleS', 'corrections']

/** Per-variant summary: medians/p90 of each metric and quality counts. */
export function summarize(rows) {
  const out = { runs: rows.length, delivered: rows.filter(r => r.delivered).length, accepted: rows.filter(r => r.accepted).length,
    suitePass: rows.filter(r => r.suitePass).length, lintPass: rows.filter(r => r.lintPass).length,
    hiddenPass: sum(rows.map(r => r.hiddenPass)), hiddenTests: sum(rows.map(r => r.hiddenTests)),
    firstPassReview: rows.filter(r => r.delivered && r.corrections === 0).length, unexpectedFiles: sum(rows.map(r => r.unexpectedFiles)),
    totalCostUsd: Math.round(sum(rows.map(r => r.costUsd ?? 0)) * 1000) / 1000 }
  for (const m of METRICS) out[m] = { median: median(rows.map(r => r[m])), p90: quantile(rows.map(r => r[m]), 0.9), mean: rows.length ? sum(rows.map(r => r[m] ?? 0)) / rows.length : null }
  return out
}

/** Mulberry32: a small seeded generator, so a report is reproducible. */
function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** Two-sided Mann-Whitney U p-value (normal approximation with tie correction). */
export function mannWhitney(a, b) {
  const all = [...a.map(v => [v, 0]), ...b.map(v => [v, 1])].sort((x, y) => x[0] - y[0])
  const ranks = new Array(all.length)
  let tie = 0
  for (let i = 0; i < all.length;) {
    let j = i
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++
    const r = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[k] = r
    const t = j - i + 1; tie += t ** 3 - t
    i = j + 1
  }
  const n1 = a.length, n2 = b.length, n = n1 + n2
  if (!n1 || !n2) return { u: null, p: null }
  const r1 = sum(all.map((x, i) => (x[1] === 0 ? ranks[i] : 0)))
  const u = r1 - (n1 * (n1 + 1)) / 2
  const mu = (n1 * n2) / 2
  const sigma = Math.sqrt(((n1 * n2) / 12) * ((n + 1) - tie / (n * (n - 1))))
  if (!sigma) return { u, p: 1 }
  const z = (Math.abs(u - mu) - 0.5) / sigma
  return { u, p: Math.min(1, 2 * (1 - normalCdf(Math.max(0, z)))) }
}

function normalCdf(z) {
  // Abramowitz-Stegun 26.2.17
  const t = 1 / (1 + 0.2316419 * z)
  const d = 0.3989422804014327 * Math.exp(-z * z / 2)
  return 1 - d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
}

/** Two-sided Fisher exact test for 2×2 counts [[a, b], [c, d]]. */
export function fisherExact(a, b, c, d) {
  const lf = n => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s }
  const n = a + b + c + d, r1 = a + b, c1 = a + c
  const p = x => Math.exp(lf(r1) + lf(n - r1) + lf(c1) + lf(n - c1) - lf(n) - lf(x) - lf(r1 - x) - lf(c1 - x) - lf(n - r1 - c1 + x))
  const observed = p(a)
  let total = 0
  for (let x = Math.max(0, r1 + c1 - n); x <= Math.min(r1, c1); x++) { const px = p(x); if (px <= observed * (1 + 1e-9)) total += px }
  return Math.min(1, total)
}

/**
 * Compare variant B with baseline A on `metric`. Each run is divided by its spec's
 * baseline median (specs with no baseline run are skipped), then: the geometric-mean
 * ratio B/A with a spec-stratified bootstrap 95 % CI, and a Mann-Whitney p-value.
 */
export function compareMetric(rowsA, rowsB, metric, { resamples = 2000, seed = 7 } = {}) {
  const base = {}
  for (const spec of new Set(rowsA.map(r => r.spec))) base[spec] = median(rowsA.filter(r => r.spec === spec).map(r => r[metric]))
  const norm = rows => rows.filter(r => base[r.spec] > 0 && Number.isFinite(r[metric]) && r[metric] > 0).map(r => ({ spec: r.spec, v: Math.log(r[metric] / base[r.spec]) }))
  const a = norm(rowsA), b = norm(rowsB)
  if (!a.length || !b.length) return { metric, ratio: null, ci: null, p: null, perSpec: {} }
  const gm = (xa, xb) => Math.exp(sum(xb) / xb.length - sum(xa) / xa.length)
  const ratio = gm(a.map(x => x.v), b.map(x => x.v))
  const rand = rng(seed), specs = [...new Set(b.map(x => x.spec))]
  const draws = []
  for (let i = 0; i < resamples; i++) {
    const sa = [], sb = []
    for (const spec of specs) {
      const pa = a.filter(x => x.spec === spec), pb = b.filter(x => x.spec === spec)
      for (let k = 0; k < pa.length; k++) sa.push(pa[Math.floor(rand() * pa.length)].v)
      for (let k = 0; k < pb.length; k++) sb.push(pb[Math.floor(rand() * pb.length)].v)
    }
    if (sa.length && sb.length) draws.push(gm(sa, sb))
  }
  const perSpec = {}
  for (const spec of specs) perSpec[spec] = { a: base[spec], b: median(rowsB.filter(r => r.spec === spec).map(r => r[metric])) }
  return { metric, ratio, ci: [quantile(draws, 0.025), quantile(draws, 0.975)], p: mannWhitney(a.map(x => x.v), b.map(x => x.v)).p, perSpec }
}

/** Quality floor check: B may not have fewer successes than A on any quality count (per run). */
export function qualityFloor(sa, sb) {
  const rate = (s, k) => (s.runs ? s[k] / s.runs : 0)
  const keys = ['delivered', 'accepted', 'suitePass', 'lintPass', 'firstPassReview']
  const checks = keys.map(k => ({ key: k, a: `${sa[k]}/${sa.runs}`, b: `${sb[k]}/${sb.runs}`, worse: rate(sb, k) < rate(sa, k), p: fisherExact(sa[k], sa.runs - sa[k], sb[k], sb.runs - sb[k]) }))
  const hidden = { key: 'hiddenTests', a: `${sa.hiddenPass}/${sa.hiddenTests}`, b: `${sb.hiddenPass}/${sb.hiddenTests}`, worse: (sb.hiddenTests ? sb.hiddenPass / sb.hiddenTests : 0) < (sa.hiddenTests ? sa.hiddenPass / sa.hiddenTests : 0) }
  return [...checks, hidden, { key: 'unexpectedFiles', a: String(sa.unexpectedFiles), b: String(sb.unexpectedFiles), worse: sb.unexpectedFiles / Math.max(1, sb.runs) > sa.unexpectedFiles / Math.max(1, sa.runs) }]
}
