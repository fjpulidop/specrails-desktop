// Machine and server metrics for parallel benchmarks: CPU and memory of the
// isolated server's process tree (Core children, provider CLIs, verification
// commands), machine load, free memory, provider process counts, event-loop
// stalls and HTTP latency. The parsers are pure; `createMetricsSampler` polls.

import { execFile } from 'node:child_process'
import os from 'node:os'

const run = (file, args, timeoutMs = 10_000) => new Promise(resolve => {
  execFile(file, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? '' : stdout))
})

/** Parse `ps -A -o pid=,ppid=,pcpu=,rss=,comm=` output. Pure. */
export function parsePs(text) {
  const rows = []
  for (const line of String(text).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), cpu: Number(match[3]), rssKb: Number(match[4]), command: match[5].trim() })
  }
  return rows
}

/** Every process descending from `rootPid` (the root included). Pure. */
export function processTree(rows, rootPid) {
  const children = new Map()
  for (const row of rows) { if (!children.has(row.ppid)) children.set(row.ppid, []); children.get(row.ppid).push(row) }
  const out = []
  const root = rows.find(row => row.pid === rootPid)
  if (!root) return out
  const stack = [root]
  const seen = new Set()
  while (stack.length) {
    const row = stack.pop()
    if (seen.has(row.pid)) continue
    seen.add(row.pid)
    out.push(row)
    for (const child of children.get(row.pid) ?? []) stack.push(child)
  }
  return out
}

/** Classify a process of the server tree for the counters. Pure. */
export function processKind(command) {
  const c = String(command)
  if (/(^|\/)claude(\s|$)/.test(c) || /@anthropic-ai\/claude-code|claude-code\/cli/.test(c)) return 'claude'
  if (/(^|\/)codex(\s|$)/.test(c) || /@openai\/codex/.test(c)) return 'codex'
  if (/specrails-core/.test(c)) return 'core'
  if (/(^|\/)(npm|node|npx|tsx|vitest|pytest|cargo|go|git)(\s|$)/.test(c)) return /(^|\/)git(\s|$)/.test(c) ? 'git' : 'node'
  return 'other'
}

/** Sum one process tree: CPU % (100 = one core), RSS MB and a count per kind. Pure. */
export function summarizeTree(tree) {
  const kinds = {}
  let cpu = 0, rssKb = 0
  for (const row of tree) { cpu += row.cpu; rssKb += row.rssKb; const kind = processKind(row.command); kinds[kind] = (kinds[kind] ?? 0) + 1 }
  return { processes: tree.length, cpu: Math.round(cpu), rssMb: Math.round(rssKb / 1024), kinds }
}

/** Parse macOS `vm_stat` into the MB of free + inactive + speculative pages (what the OS can hand out). Pure. */
export function parseVmStat(text) {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 16384)
  const pages = name => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(text)?.[1] ?? 0)
  const available = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')
  return { availableMb: Math.round(available * size / 1024 / 1024), compressedMb: Math.round(pages('Pages occupied by compressor') * size / 1024 / 1024) }
}

/** Percentile of a numeric list (nearest rank), null when empty. Pure. */
export function percentile(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!xs.length) return null
  return xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]
}

/** Summarize metric samples for one benchmark window. Pure. */
export function summarizeMetrics(samples) {
  const pick = key => samples.map(sample => sample[key]).filter(Number.isFinite)
  const max = key => { const xs = pick(key); return xs.length ? Math.max(...xs) : null }
  return {
    samples: samples.length,
    cpuPeak: max('treeCpu'), cpuP50: percentile(pick('treeCpu'), 50), rssPeakMb: max('treeRssMb'),
    loadPeak: max('load1'), availableMinMb: (() => { const xs = pick('availableMb'); return xs.length ? Math.min(...xs) : null })(),
    providersPeak: max('providerProcesses'), queuedPeak: max('queuedRuns'), activePeak: max('activeRuns'),
    queuedFor: [...new Set(samples.flatMap(sample => sample.queuedFor ?? []))],
    health: { p50: percentile(pick('healthMs'), 50), p95: percentile(pick('healthMs'), 95), max: max('healthMs') },
    board: { p50: percentile(pick('boardMs'), 50), p95: percentile(pick('boardMs'), 95), max: max('boardMs') },
    stallLongestMs: max('stallLongestMs'), stallCount: (() => { const xs = pick('stallTotal'); return xs.length ? Math.max(...xs) - Math.min(...xs) : null })(),
  }
}

/**
 * Poll every `intervalMs`: the server tree (`rootPid()` is re-read, a restart
 * changes it), machine load and memory, `/api/health`, `/api/live-board` and
 * `/api/diagnostics/stalls`. `stop()` resolves with the samples.
 */
export function createMetricsSampler({ api, rootPid, intervalMs = 5000 }) {
  const samples = []
  let running = true
  const loop = (async () => {
    while (running) {
      const at = Date.now()
      const sample = { at, load1: Math.round(os.loadavg()[0] * 100) / 100 }
      try {
        const [psText, vmText] = await Promise.all([run('ps', ['-A', '-o', 'pid=,ppid=,pcpu=,rss=,command=']), run('vm_stat', [])])
        const pid = rootPid()
        if (pid) {
          const summary = summarizeTree(processTree(parsePs(psText), pid))
          Object.assign(sample, { treeCpu: summary.cpu, treeRssMb: summary.rssMb, treeProcesses: summary.processes, kinds: summary.kinds,
            providerProcesses: (summary.kinds.claude ?? 0) + (summary.kinds.codex ?? 0) })
        }
        if (vmText) Object.assign(sample, parseVmStat(vmText))
      } catch { /* best effort */ }
      try {
        const t0 = performance.now()
        await fetch(`${api.base}/api/health`, { signal: AbortSignal.timeout(30_000) })
        sample.healthMs = Math.round(performance.now() - t0)
        const board = await api.get('/live-board', { timeoutMs: 60_000 })
        sample.boardMs = Math.round(board.ms)
        sample.cards = board.data?.cards?.length ?? null
        const stalls = await api.get('/diagnostics/stalls', { timeoutMs: 30_000 })
        const capacity = await api.get('/capacity', { timeoutMs: 30_000 })
        if (capacity.status === 200 && capacity.data?.enabled) { sample.activeRuns = capacity.data.active?.length ?? null; sample.queuedRuns = capacity.data.queued?.length ?? null; sample.queuedFor = [...new Set((capacity.data.queued ?? []).map(q => q.waitingFor))] }
        if (stalls.status === 200) { sample.stallTotal = stalls.data?.total ?? null; sample.stallLongestMs = stalls.data?.recent?.[0]?.durationMs ?? null; sample.stallLongestEverMs = stalls.data?.longestMs ?? null }
      } catch { /* restarting */ }
      samples.push(sample)
      const wait = intervalMs - (Date.now() - at)
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    }
  })()
  return { samples, async stop() { running = false; await loop; return samples } }
}
