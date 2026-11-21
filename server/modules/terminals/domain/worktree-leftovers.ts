/**
 * Pure selection of the processes a settled run left behind in its worktree.
 *
 * Provider CLIs and the test tools they drive (Playwright `webServer`, `vite
 * preview`, dev servers started from a Bash tool) often run in their own
 * process group. When the CLI exits normally — or is killed — those children
 * are re-parented to init/launchd, so no ppid walk from the run's root reaches
 * them any more. What they keep is the worktree path in their command line.
 *
 * A leftover is a process whose command line references the worktree (same
 * boundary rules as `findWorktreeRoots`) plus its descendants, minus everything
 * that must outlive the run: the trees of live owned roots (other runs, jobs,
 * agent sessions, registered background processes, terminals), the server, its
 * ancestors and its own tooling (`git`, `ps`). No I/O here.
 */
import { findWorktreeRoots, type ProcessSample } from './mission-resources'

export interface LeftoverProcess {
  pid: number
  ppid: number
  command: string
  /** The worktree whose path the process (or its matched ancestor) references. */
  worktreePath: string
}

export interface LeftoverSelectionOptions {
  /** Live roots whose whole trees are protected (owned by something that outlives this run). */
  protectedRootPids: readonly number[]
  /** The Specrails server process: itself, its ancestors and its git/ps children are protected. */
  serverPid: number
  windows?: boolean
}

/** Executables the server runs as its own short-lived tooling (git in the worktree, the process-table read). */
const SERVER_TOOLING = /^(git|ps|powershell|pwsh|taskkill|du|lsof)$/i

function executableName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const name = first.replace(/^["']|["']$/g, '').split(/[\\/]/).pop() ?? ''
  return name.replace(/\.exe$/i, '')
}

function childrenIndex(samples: readonly ProcessSample[]): Map<number, ProcessSample[]> {
  const children = new Map<number, ProcessSample[]>()
  for (const s of samples) {
    if (s.ppid === s.pid) continue
    const list = children.get(s.ppid)
    if (list) list.push(s)
    else children.set(s.ppid, [s])
  }
  return children
}

function subtree(rootPid: number, children: Map<number, ProcessSample[]>, byPid: Map<number, ProcessSample>): ProcessSample[] {
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

/** Every pid that must survive: protected trees, the server, its ancestors and its tooling subtrees. */
export function protectedPids(samples: readonly ProcessSample[], options: LeftoverSelectionOptions): Set<number> {
  const byPid = new Map(samples.map((s) => [s.pid, s]))
  const children = childrenIndex(samples)
  const kept = new Set<number>([0, 1, options.serverPid])
  for (const root of options.protectedRootPids) {
    kept.add(root)
    for (const s of subtree(root, children, byPid)) kept.add(s.pid)
  }
  // The server's ancestors (the Tauri shell, a terminal running `npm run dev`).
  let cursor = byPid.get(options.serverPid)
  const climbed = new Set<number>()
  while (cursor && !climbed.has(cursor.pid)) {
    climbed.add(cursor.pid)
    kept.add(cursor.ppid)
    cursor = byPid.get(cursor.ppid)
  }
  // The server's own tooling: a `git -C <worktree> …` of the settlement itself.
  for (const child of children.get(options.serverPid) ?? []) {
    if (!SERVER_TOOLING.test(executableName(child.command))) continue
    for (const s of subtree(child.pid, children, byPid)) kept.add(s.pid)
  }
  return kept
}

/**
 * The processes to terminate for these worktrees, parents before children, each pid once. A
 * protected process is never returned, and neither is anything under it.
 */
export function selectWorktreeLeftovers(
  samples: readonly ProcessSample[],
  worktreePaths: readonly string[],
  options: LeftoverSelectionOptions,
): LeftoverProcess[] {
  const kept = protectedPids(samples, options)
  const byPid = new Map(samples.map((s) => [s.pid, s]))
  const children = childrenIndex(samples)
  const selected = new Map<number, LeftoverProcess>()
  for (const worktreePath of worktreePaths) {
    for (const root of findWorktreeRoots(samples as ProcessSample[], worktreePath, { windows: options.windows })) {
      if (kept.has(root.pid)) continue
      // Descend, but stop at a protected process: its subtree is owned elsewhere.
      const stack = [byPid.get(root.pid)!]
      while (stack.length) {
        const next = stack.pop()!
        if (kept.has(next.pid) || selected.has(next.pid)) continue
        selected.set(next.pid, { pid: next.pid, ppid: next.ppid, command: next.command, worktreePath })
        stack.push(...(children.get(next.pid) ?? []))
      }
    }
  }
  return [...selected.values()]
}

/**
 * A path the reaper may act on: absolute, at least three segments deep, and neither equal to nor an
 * ancestor of a forbidden path (the home directory, the server's cwd, a registered project checkout).
 */
export function isReapableWorktreePath(worktreePath: string, forbidden: readonly string[], options: { windows?: boolean } = {}): boolean {
  const normalize = (value: string) => {
    const slashed = (options.windows ? value.replace(/\\/g, '/') : value).replace(/\/+$/, '')
    return options.windows ? slashed.toLowerCase() : slashed
  }
  const target = normalize(worktreePath.trim())
  const absolute = options.windows ? /^[a-z]:\//.test(target) || target.startsWith('//') : target.startsWith('/')
  if (!absolute) return false
  if (target.split('/').filter(Boolean).length < 3) return false
  for (const raw of forbidden) {
    if (!raw) continue
    const other = normalize(raw)
    if (other === target || other.startsWith(`${target}/`)) return false
  }
  return true
}

/** A short command head for logs (the full line can carry long prompts). */
export function commandHead(command: string, max = 160): string {
  const flat = command.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
