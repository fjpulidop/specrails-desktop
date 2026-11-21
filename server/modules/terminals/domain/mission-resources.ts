/**
 * Pure model for the per-mission Resources view: parse a process-table
 * snapshot, group it into the process trees a mission owns and total them.
 * No I/O here; the sampler in `runtime/resource-sampler.ts` feeds it.
 */

export interface ProcessSample {
  pid: number
  ppid: number
  /** Percent of one core, as reported by `ps` (may exceed 100 on multi-core). */
  cpuPercent: number
  rssBytes: number
  command: string
}

export type MissionResourceKind = 'agent-session' | 'background-process' | 'mission-activity'

/** A root the mission owns; its OS descendants are measured with it. */
export interface MissionResourceRoot {
  id: string
  kind: MissionResourceKind
  label: string
  pid: number
}

export interface MissionResourceEntry {
  id: string
  kind: MissionResourceKind
  label: string
  pid: number
  /** False when the root pid is gone from the process table. */
  running: boolean
  cpuPercent: number
  memoryBytes: number
  processCount: number
}

export interface MissionResourceTotals {
  cpuPercent: number
  memoryBytes: number
  processCount: number
}

/** Parses `ps -axo pid=,ppid=,pcpu=,rss=,command=` (rss in KiB). Bad lines are skipped. */
export function parsePsOutput(text: string): ProcessSample[] {
  const samples: ProcessSample[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s*(.*)$/.exec(line)
    if (!match) continue
    const [, pid, ppid, cpu, rss, command] = match
    const cpuPercent = Number(cpu)
    if (!Number.isFinite(cpuPercent)) continue
    samples.push({ pid: Number(pid), ppid: Number(ppid), cpuPercent, rssBytes: Number(rss) * 1024, command: command.trim() })
  }
  return samples
}

/** A row of the Windows process table before CPU is derived (Windows reports cumulative CPU time, not a rate). */
export interface WindowsProcessRow {
  pid: number
  ppid: number
  rssBytes: number
  /** Kernel + user CPU time consumed since the process started, in milliseconds. */
  cpuTimeMs: number
  command: string
}

/**
 * Parses `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,
 * UserModeTime,CommandLine | ConvertTo-Json`. PowerShell emits a bare object for a single row and an array
 * otherwise; times are 100 ns units. Malformed rows are skipped.
 */
export function parseWindowsProcessJson(text: string): WindowsProcessRow[] {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed) return []
  let data: unknown
  try { data = JSON.parse(trimmed) } catch { return [] }
  const list = Array.isArray(data) ? data : [data]
  const rows: WindowsProcessRow[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const pid = Number(r.ProcessId)
    const ppid = Number(r.ParentProcessId)
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue
    const rss = Number(r.WorkingSetSize)
    const ticks = Number(r.KernelModeTime) + Number(r.UserModeTime)
    rows.push({
      pid, ppid,
      rssBytes: Number.isFinite(rss) && rss > 0 ? rss : 0,
      cpuTimeMs: Number.isFinite(ticks) && ticks > 0 ? ticks / 10_000 : 0,
      command: typeof r.CommandLine === 'string' ? r.CommandLine.trim() : '',
    })
  }
  return rows
}

/**
 * Turns cumulative CPU time into a percent of one core by comparing with the previous sample.
 * A process with no previous sample, a reused pid (time went backwards) or no elapsed time reads 0.
 * Returns the samples plus the map to keep for the next call.
 */
export function applyCpuDeltas(
  previous: ReadonlyMap<number, number>,
  rows: WindowsProcessRow[],
  elapsedMs: number,
): { samples: ProcessSample[]; next: Map<number, number> } {
  const next = new Map<number, number>()
  const samples = rows.map((row) => {
    next.set(row.pid, row.cpuTimeMs)
    const before = previous.get(row.pid)
    const used = before === undefined ? 0 : row.cpuTimeMs - before
    const cpuPercent = elapsedMs > 0 && used > 0 ? Math.round((used / elapsedMs) * 1000) / 10 : 0
    return { pid: row.pid, ppid: row.ppid, cpuPercent, rssBytes: row.rssBytes, command: row.command }
  })
  return { samples, next }
}

function treeOf(rootPid: number, children: Map<number, ProcessSample[]>, byPid: Map<number, ProcessSample>): ProcessSample[] {
  const root = byPid.get(rootPid)
  if (!root) return []
  const out: ProcessSample[] = []
  const seen = new Set<number>()
  const stack = [root]
  while (stack.length) {
    const next = stack.pop()!
    if (seen.has(next.pid)) continue
    seen.add(next.pid)
    out.push(next)
    stack.push(...(children.get(next.pid) ?? []))
  }
  return out
}

/**
 * Measures each root with its descendants. A process reachable from two roots
 * is counted once, under the first root, so totals never double-count.
 */
export function measureRoots(samples: ProcessSample[], roots: MissionResourceRoot[]): MissionResourceEntry[] {
  const byPid = new Map(samples.map((s) => [s.pid, s]))
  const children = new Map<number, ProcessSample[]>()
  for (const s of samples) {
    if (s.ppid === s.pid) continue
    const list = children.get(s.ppid)
    if (list) list.push(s)
    else children.set(s.ppid, [s])
  }
  const claimed = new Set<number>()
  return roots.map((root) => {
    const tree = treeOf(root.pid, children, byPid).filter((s) => !claimed.has(s.pid))
    for (const s of tree) claimed.add(s.pid)
    return {
      id: root.id, kind: root.kind, label: root.label, pid: root.pid,
      running: byPid.has(root.pid),
      cpuPercent: Math.round(tree.reduce((sum, s) => sum + s.cpuPercent, 0) * 10) / 10,
      memoryBytes: tree.reduce((sum, s) => sum + s.rssBytes, 0),
      processCount: tree.length,
    }
  })
}

export function totalEntries(entries: MissionResourceEntry[]): MissionResourceTotals {
  return {
    cpuPercent: Math.round(entries.reduce((sum, e) => sum + e.cpuPercent, 0) * 10) / 10,
    memoryBytes: entries.reduce((sum, e) => sum + e.memoryBytes, 0),
    processCount: entries.reduce((sum, e) => sum + e.processCount, 0),
  }
}

/**
 * Whether a command line names `worktreePath` as a whole path component: `ticket-4` never
 * matches `ticket-40`. Windows paths use either separator and compare case-insensitively.
 */
export function commandReferencesPath(command: string, worktreePath: string, windows = false): boolean {
  const normalize = (value: string) => {
    const slashed = windows ? value.replace(/\\/g, '/') : value
    return windows ? slashed.toLowerCase() : slashed
  }
  const base = normalize(worktreePath).replace(/\/+$/, '')
  if (!base) return false
  const text = normalize(command)
  let from = 0
  for (;;) {
    const i = text.indexOf(base, from)
    if (i < 0) return false
    const previous = text[i - 1]
    const next = text[i + base.length]
    if ((previous === undefined || /\s|["'=]/.test(previous)) &&
        (next === undefined || next === '/' || /\s|["':=]/.test(next))) return true
    from = i + 1
  }
}

/**
 * Finds processes that belong to the mission by working location: any process
 * whose command line references the mission worktree (sub-agents, jobs and tools
 * launched as a consequence of the mission). Only top-most matches become roots;
 * their descendants are measured with them.
 */
export function findWorktreeRoots(samples: ProcessSample[], worktreePath: string, options: { windows?: boolean } = {}): MissionResourceRoot[] {
  const matched = new Set(samples.filter((s) => commandReferencesPath(s.command, worktreePath, options.windows)).map((s) => s.pid))
  return samples
    .filter((s) => matched.has(s.pid) && !matched.has(s.ppid))
    .map((s) => ({ id: `mission-activity:${s.pid}`, kind: 'mission-activity' as const, label: s.command, pid: s.pid }))
}

/** One point of a mission's resource history (totals across everything the mission owns). */
export interface MissionResourceSample {
  at: number
  cpuPercent: number
  memoryBytes: number
  processCount: number
}

/**
 * Whether a measurement belongs in the history: while the mission has live processes, plus the single
 * closing point where they drop to zero. An idle mission adds nothing, so history never fills with zeros.
 */
export function shouldRecordSample(last: Pick<MissionResourceSample, 'processCount'> | null, totals: Pick<MissionResourceTotals, 'processCount'>): boolean {
  return totals.processCount > 0 || (last !== null && last.processCount > 0)
}
