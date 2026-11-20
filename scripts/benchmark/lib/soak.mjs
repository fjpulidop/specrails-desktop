// Soak (long-running) sampler: everything that can leak or drift over hours,
// sampled every `intervalMs` and appended to a JSONL file so a crash of the
// harness never loses the series. Server heap comes from the server's own
// inspector (loopback, `--inspect-port`); a WebSocket client stays connected
// the whole soak and counts reconnects and silent gaps.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const run = (file, args, timeoutMs = 20_000) => new Promise(resolve => {
  execFile(file, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => resolve(error && !stdout ? '' : stdout))
})

/** Parse `ps -A -o pid=,ppid=,stat=,rss=,command=`. Pure. */
export function parsePsStat(text) {
  const rows = []
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], rssKb: Number(m[4]), command: m[5].trim() })
  }
  return rows
}

/** Descendants of `rootPid` (root excluded). Pure. */
export function descendants(rows, rootPid) {
  const kids = new Map()
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r) }
  const out = []
  const stack = [...(kids.get(rootPid) ?? [])]
  const seen = new Set()
  while (stack.length) {
    const r = stack.pop()
    if (seen.has(r.pid)) continue
    seen.add(r.pid); out.push(r)
    stack.push(...(kids.get(r.pid) ?? []))
  }
  return out
}

/**
 * Process counters for the soak: tree size, Core children (count and RSS), provider
 * CLIs, zombies in the tree, and orphans (re-parented to launchd/init) whose command
 * names one of `markers` (the isolated home, the work dir, the Core under test). Pure.
 */
export function processCounters(rows, rootPid, markers = []) {
  const tree = descendants(rows, rootPid)
  // Core runs from the shared runtime-package cache (…/runtime-packages/<digest>/dist/agent-runtime/cli.js).
  const core = tree.filter(r => /specrails-core|runtime-packages\/[^/]+\/dist\/agent-runtime\/cli\.js/.test(r.command))
  // The harness itself (detached, so re-parented to launchd) names the home too: never an orphan.
  const orphans = rows.filter(r => r.ppid === 1 && r.pid !== process.pid && !/scripts\/benchmark\/index\.mjs/.test(r.command) && markers.some(m => m && r.command.includes(m)))
  return {
    treeProcesses: tree.length,
    coreProcesses: core.length,
    coreRssMb: Math.round(core.reduce((a, r) => a + r.rssKb, 0) / 1024),
    providerProcesses: tree.filter(r => /(^|\/)claude(\s|$)|@anthropic-ai\/claude-code/.test(r.command)).length,
    zombies: tree.filter(r => r.stat.startsWith('Z')).length,
    orphans: orphans.length,
    orphanCommands: orphans.slice(0, 5).map(r => `${r.pid} ${r.command.slice(0, 140)}`),
  }
}

/** Bytes of files under `dir` whose name matches `re` (recursive, symlinks not followed). */
export function sizeOf(dir, re = /.*/, { maxEntries = 200_000 } = {}) {
  let bytes = 0, files = 0, seen = 0
  const stack = [dir]
  while (stack.length && seen < maxEntries) {
    const d = stack.pop()
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      seen++
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (e.name !== '.git' || re.source === '.*') stack.push(p); continue }
      if (!e.isFile() || !re.test(e.name)) continue
      try { bytes += fs.statSync(p).size; files++ } catch { /* gone */ }
    }
  }
  return { bytes, files }
}

const mb = bytes => Math.round(bytes / 1024 / 1024 * 10) / 10

/** `du -sk` of a directory in MB (null when it does not exist). */
async function duMb(dir) {
  if (!dir || !fs.existsSync(dir)) return null
  const out = await run('du', ['-sk', dir], 120_000)
  const kb = Number(String(out).split(/\s/)[0])
  return Number.isFinite(kb) ? Math.round(kb / 1024) : null
}

/** One heap reading over the inspector protocol (Node's global WebSocket). */
export async function readHeap(inspectPort, timeoutMs = 10_000) {
  const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })).json()
  const url = list?.[0]?.webSocketDebuggerUrl
  if (!url) throw new Error('no inspector target')
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => { try { ws.close() } catch { /* closed */ } reject(new Error('inspector timeout')) }, timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify(Object.assign(process.memoryUsage(), { handles: process._getActiveHandles().length, requests: process._getActiveRequests().length }))', returnByValue: true } }))
    ws.onmessage = event => {
      const msg = JSON.parse(String(event.data))
      if (msg.id !== 1) return
      clearTimeout(timer); ws.close()
      try { resolve(JSON.parse(msg.result.result.value)) } catch (error) { reject(error) }
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('inspector socket error')) }
  })
}

/**
 * A WebSocket client that stays connected to the server's event socket all soak long
 * (`ws` from the Desktop's dependencies, with the bearer token). Reconnects 2 s after a
 * close. Counts connects, closes, messages and the longest silence while connected.
 */
export function createWsWatcher({ port, getToken, desktopDir, log = () => {} }) {
  const WS = createRequire(path.join(desktopDir, 'package.json'))('ws')
  const state = { connects: 0, closes: 0, messages: 0, lastMessageAt: null, longestGapMs: 0, connected: false, lastClose: null }
  let socket = null, stopped = false
  const connect = async () => {
    if (stopped) return
    let token
    try { token = await getToken() } catch { setTimeout(connect, 2000); return }
    socket = new WS(`ws://127.0.0.1:${port}/`, { headers: { Authorization: `Bearer ${token}` } })
    socket.on('open', () => { state.connects++; state.connected = true; state.lastMessageAt = Date.now() })
    socket.on('message', () => {
      const now = Date.now()
      if (state.lastMessageAt) state.longestGapMs = Math.max(state.longestGapMs, now - state.lastMessageAt)
      state.lastMessageAt = now; state.messages++
    })
    socket.on('close', (code, reason) => {
      if (state.connected) { state.closes++; state.lastClose = { at: Date.now(), code, reason: String(reason ?? '') }; log(`ws closed ${code}`) }
      state.connected = false
      if (!stopped) setTimeout(connect, 2000)
    })
    socket.on('error', () => { /* close follows */ })
  }
  connect()
  return { state, stop() { stopped = true; try { socket?.close() } catch { /* closed */ } } }
}

/**
 * Sample the soak every `intervalMs` (heavier disk walks every `diskEveryMs`) and
 * append each sample to `outFile` (JSONL). `rootPid()` is re-read every sample, so
 * restarts are followed; memory slopes are later computed per server process.
 */
export function createSoakSampler({ api, rootPid, home, workDir, inspectPort, outFile, markers = [], ws, intervalMs = 60_000, diskEveryMs = 5 * 60_000, extraDirs = {}, log = () => {} }) {
  const samples = []
  let running = true
  let lastDisk = 0, disk = {}
  const loop = (async () => {
    while (running) {
      const at = Date.now()
      const sample = { at }
      const pid = rootPid()
      sample.serverPid = pid
      try {
        const rows = parsePsStat(await run('ps', ['-A', '-o', 'pid=,ppid=,stat=,rss=,command=']))
        const me = rows.find(r => r.pid === pid)
        if (me) sample.serverRssMb = Math.round(me.rssKb / 1024)
        if (pid) Object.assign(sample, processCounters(rows, pid, markers))
      } catch { /* best effort */ }
      if (pid) {
        const lsof = await run('lsof', ['-n', '-P', '-p', String(pid)], 30_000)
        if (lsof) sample.serverFds = Math.max(0, lsof.trim().split('\n').length - 1)
      }
      if (inspectPort) {
        try { const h = await readHeap(inspectPort); Object.assign(sample, { heapUsedMb: mb(h.heapUsed), heapTotalMb: mb(h.heapTotal), externalMb: mb(h.external), arrayBuffersMb: mb(h.arrayBuffers ?? 0), activeHandles: h.handles, activeRequests: h.requests }) } catch (error) { sample.heapError = String(error.message ?? error) }
      }
      try {
        const t0 = performance.now()
        await fetch(`${api.base}/api/health`, { signal: AbortSignal.timeout(30_000) })
        sample.healthMs = Math.round(performance.now() - t0)
        const board = await api.get('/live-board', { timeoutMs: 60_000 })
        sample.boardMs = Math.round(board.ms); sample.cards = board.data?.cards?.length ?? null
        const stalls = await api.get('/diagnostics/stalls', { timeoutMs: 30_000 })
        if (stalls.status === 200) { sample.stallTotal = stalls.data?.total ?? null; sample.stallLongestMs = stalls.data?.recent?.[0]?.durationMs ?? null; sample.stallLongestEverMs = stalls.data?.longestMs ?? null }
        const capacity = await api.get('/capacity', { timeoutMs: 30_000 })
        if (capacity.status === 200 && capacity.data?.enabled) { sample.activeRuns = capacity.data.active?.length ?? null; sample.queuedRuns = capacity.data.queued?.length ?? null }
      } catch { sample.apiDown = true }
      if (ws) Object.assign(sample, { wsConnected: ws.state.connected, wsReconnects: Math.max(0, ws.state.connects - 1), wsMessages: ws.state.messages, wsLongestGapMs: ws.state.longestGapMs })
      if (at - lastDisk >= diskEveryMs) {
        lastDisk = at
        try {
          const root = path.join(home, '.specrails')
          const dbs = sizeOf(root, /\.(sqlite|db)$/)
          const wals = sizeOf(root, /-wal$/)
          const logs = sizeOf(root, /\.(log|jsonl|ndjson)$/)
          let eventRows = 0
          const projects = path.join(root, 'projects')
          for (const slug of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
            const db = path.join(projects, slug, 'jobs.sqlite')
            if (!fs.existsSync(db)) continue
            const out = await run('sqlite3', ['-readonly', db, 'select count(*) from events'])
            const n = Number(String(out).trim()); if (Number.isFinite(n)) eventRows += n
          }
          disk = { dbMb: mb(dbs.bytes), walMb: mb(wals.bytes), logsMb: mb(logs.bytes), eventRows, homeMb: await duMb(home), workMb: await duMb(path.join(workDir, 'repos')) }
          for (const [key, dir] of Object.entries(extraDirs)) disk[key] = await duMb(typeof dir === 'function' ? dir() : dir)
        } catch (error) { log(`soak disk sample: ${error.message}`) }
      }
      Object.assign(sample, disk)
      samples.push(sample)
      try { fs.appendFileSync(outFile, JSON.stringify(sample) + '\n') } catch { /* disk full? keep sampling */ }
      const wait = intervalMs - (Date.now() - at)
      if (wait > 0 && running) await new Promise(resolve => setTimeout(resolve, wait))
    }
  })()
  return { samples, async stop() { running = false; await loop; return samples } }
}

/** Read a soak JSONL file back (a resumed report). */
export function readSoakFile(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
}
