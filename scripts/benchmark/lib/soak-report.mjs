// Soak (long-running) benchmark analysis: leak slopes and time-series tables
// from the soak sampler's samples. Pure: samples in, numbers and Markdown out.

/**
 * Least-squares slope of `points` ([{ x: ms, y }]) per hour, with R² and the
 * number of points. Null when fewer than 3 finite points or no time spread.
 */
export function slopePerHour(points) {
  const xs = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
  if (xs.length < 3) return null
  const n = xs.length
  const mx = xs.reduce((a, p) => a + p.x, 0) / n
  const my = xs.reduce((a, p) => a + p.y, 0) / n
  let sxx = 0, sxy = 0, syy = 0
  for (const p of xs) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); syy += (p.y - my) ** 2 }
  if (sxx === 0) return null
  const slopePerMs = sxy / sxx
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy)
  return { perHour: slopePerMs * 3_600_000, r2: Math.round(r2 * 1000) / 1000, n }
}

/** Metrics a soak report follows: key → { label, unit, leakPerHour (a slope that counts as a leak when R² ≥ 0.6) }. */
export const SOAK_METRICS = {
  serverRssMb: { label: 'Server RSS', unit: 'MB', leakPerHour: 20 },
  heapUsedMb: { label: 'Server heap used', unit: 'MB', leakPerHour: 10 },
  externalMb: { label: 'Server external memory', unit: 'MB', leakPerHour: 10 },
  activeHandles: { label: 'Server active handles', unit: '', leakPerHour: 20 },
  serverFds: { label: 'Server open fds', unit: '', leakPerHour: 20 },
  coreRssMb: { label: 'Core children RSS', unit: 'MB', leakPerHour: null },
  coreProcesses: { label: 'Core child processes', unit: '', leakPerHour: null },
  treeProcesses: { label: 'Server tree processes', unit: '', leakPerHour: null },
  zombies: { label: 'Zombie processes (tree)', unit: '', leakPerHour: 1 },
  orphans: { label: 'Orphaned benchmark processes', unit: '', leakPerHour: 1 },
  dbMb: { label: 'SQLite DBs', unit: 'MB', leakPerHour: null },
  walMb: { label: 'SQLite WAL files', unit: 'MB', leakPerHour: 50 },
  eventRows: { label: 'Event rows (all projects)', unit: '', leakPerHour: null },
  logsMb: { label: 'Run logs', unit: 'MB', leakPerHour: null },
  worktreesMb: { label: 'Worktrees on disk', unit: 'MB', leakPerHour: null },
  corePackagesMb: { label: 'Core runtime packages', unit: 'MB', leakPerHour: 50 },
  healthMs: { label: '/api/health latency', unit: 'ms', leakPerHour: null },
  boardMs: { label: '/api/live-board latency', unit: 'ms', leakPerHour: null },
  stallLongestMs: { label: 'Latest event-loop stall', unit: 'ms', leakPerHour: null },
  wsReconnects: { label: 'WebSocket reconnects (cumulative)', unit: '', leakPerHour: null },
  activeRuns: { label: 'Active runs (capacity)', unit: '', leakPerHour: null },
  queuedRuns: { label: 'Queued runs (capacity)', unit: '', leakPerHour: null },
}

/** Percentile (nearest rank) of finite values, or null. */
export function pct(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b)
  return xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null
}

/**
 * Per-metric summary: first, last, min, max, p95 and the slope per hour. A
 * server restart resets process memory, so the memory slopes are computed per
 * server process (`serverPid`) and the longest segment is reported.
 */
export function summarizeSoak(samples, metrics = SOAK_METRICS) {
  const out = {}
  const segments = segmentByPid(samples)
  const longest = segments.reduce((best, seg) => (seg.length > best.length ? seg : best), [])
  for (const [key, meta] of Object.entries(metrics)) {
    const ys = samples.map(s => s[key]).filter(Number.isFinite)
    if (!ys.length) continue
    const perProcess = /^(serverRssMb|heapUsedMb|externalMb|activeHandles|serverFds)$/.test(key)
    const basis = perProcess ? longest : samples
    const slope = slopePerHour(basis.map(s => ({ x: s.at, y: s[key] })))
    const leak = Boolean(meta.leakPerHour && slope && slope.r2 >= 0.6 && slope.perHour > meta.leakPerHour)
    out[key] = { label: meta.label, unit: meta.unit, first: ys[0], last: ys[ys.length - 1], min: Math.min(...ys), max: Math.max(...ys), p95: pct(ys, 95),
      slopePerHour: slope ? Math.round(slope.perHour * 100) / 100 : null, r2: slope?.r2 ?? null, basis: perProcess ? 'longest server process' : 'whole soak', leak }
  }
  return { samples: samples.length, startedAt: samples[0]?.at ?? null, endedAt: samples[samples.length - 1]?.at ?? null, serverProcesses: segments.length, metrics: out }
}

/** Consecutive samples of one server process. Pure. */
export function segmentByPid(samples) {
  const segs = []
  let cur = null
  for (const s of samples) {
    if (!s.serverPid) continue
    if (!cur || cur.pid !== s.serverPid) { cur = { pid: s.serverPid, rows: [] }; segs.push(cur) }
    cur.rows.push(s)
  }
  return segs.map(seg => seg.rows)
}

/** Every `step`-th sample (and the last), for a readable time-series table. */
export function downsample(samples, rows = 30) {
  if (samples.length <= rows) return samples
  const step = Math.ceil(samples.length / rows)
  const out = samples.filter((_, i) => i % step === 0)
  if (out[out.length - 1] !== samples[samples.length - 1]) out.push(samples[samples.length - 1])
  return out
}

const fmt = v => (v === null || v === undefined ? '–' : typeof v === 'number' ? String(Math.round(v * 10) / 10) : String(v))

/** Markdown: the slope table, then a downsampled time series. `tz` formats the clock column. */
export function renderSoak(samples, { title = 'Soak', rows = 30, tz = 'Europe/Madrid', columns = ['serverRssMb', 'heapUsedMb', 'serverFds', 'activeHandles', 'coreRssMb', 'coreProcesses', 'zombies', 'dbMb', 'walMb', 'eventRows', 'worktreesMb', 'healthMs', 'boardMs', 'activeRuns', 'queuedRuns', 'wsReconnects'] } = {}) {
  const summary = summarizeSoak(samples)
  const clock = at => new Date(at).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' })
  const lines = [`## ${title}`, '', `${summary.samples} samples, ${summary.serverProcesses} server process(es).`, '',
    '| Metric | First | Last | Min | Max | p95 | Slope / h | R² | Basis | Leak? |', '|---|---|---|---|---|---|---|---|---|---|']
  for (const m of Object.values(summary.metrics)) lines.push(`| ${m.label}${m.unit ? ` (${m.unit})` : ''} | ${fmt(m.first)} | ${fmt(m.last)} | ${fmt(m.min)} | ${fmt(m.max)} | ${fmt(m.p95)} | ${fmt(m.slopePerHour)} | ${fmt(m.r2)} | ${m.basis} | ${m.leak ? '**yes**' : 'no'} |`)
  const cols = columns.filter(c => samples.some(s => Number.isFinite(s[c])))
  lines.push('', '| Time | ' + cols.map(c => SOAK_METRICS[c]?.label ?? c).join(' | ') + ' |', '|---|' + cols.map(() => '---').join('|') + '|')
  for (const s of downsample(samples, rows)) lines.push(`| ${clock(s.at)} | ` + cols.map(c => fmt(s[c])).join(' | ') + ' |')
  return lines.join('\n') + '\n'
}
