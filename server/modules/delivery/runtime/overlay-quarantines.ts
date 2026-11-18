/**
 * Safety archives left by worktree release (`<worktree>.specrails-overlay-quarantine-XXXXXX`,
 * see rail-worktree-release.ts): list them per project with their files, and
 * delete one a person confirmed.
 *
 * Deletion is deliberately narrow: the target must be a real directory (not a
 * link) whose name is exactly a quarantine name, sitting beneath the project's
 * own Specrails worktrees root once both are resolved. Anything else is
 * refused. Removal never follows links inside the folder. Nothing here is
 * cached across projects.
 */
import * as fs from 'fs'
import * as path from 'path'

/** `mkdtemp` suffix: six characters from [A-Za-z0-9]. */
const QUARANTINE_NAME_RE = /^(.+)\.specrails-overlay-quarantine-[A-Za-z0-9]{6}$/
/** Quarantines sit at `<root>/<run>/<name>` or `<root>/<repositoryId>/<run>/<name>`. */
const MAX_SCAN_DEPTH = 3
/** At most this many files are listed per archive (counts and sizes stay exact). */
const FILE_LIST_CAP = 200
/** Directories walked per archive before the listing gives up (keeps a request bounded). */
const MAX_WALK_ENTRIES = 20_000

export interface QuarantineFile {
  /** Relative to the archive, POSIX separators. */
  path: string
  kind: 'file' | 'link' | 'other'
  bytes: number
}

export interface OverlayQuarantine {
  path: string
  /** Basename of the worktree it was cleared from (e.g. `ticket-14`). */
  worktreeName: string
  /** Epoch ms the folder was created (birth time, else modification time). */
  createdAt: number
  fileCount: number
  bytes: number
  files: QuarantineFile[]
  truncated: boolean
}

export function isOverlayQuarantineName(name: string): boolean {
  return QUARANTINE_NAME_RE.test(name)
}

function realDirectory(target: string): boolean {
  try {
    const stat = fs.lstatSync(target)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** Describe one archive. Links are listed, never followed. */
export function describeOverlayQuarantine(target: string): OverlayQuarantine | null {
  let stat: fs.Stats
  try { stat = fs.lstatSync(target) } catch { return null }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null
  const match = QUARANTINE_NAME_RE.exec(path.basename(target))
  if (!match) return null
  const files: QuarantineFile[] = []
  let fileCount = 0
  let bytes = 0
  let walked = 0
  let truncated = false
  const walk = (dir: string, prefix: string): void => {
    let names: string[]
    try { names = fs.readdirSync(dir).sort() } catch { truncated = true; return }
    for (const name of names) {
      if (++walked > MAX_WALK_ENTRIES) { truncated = true; return }
      const full = path.join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      let entry: fs.Stats
      try { entry = fs.lstatSync(full) } catch { continue }
      if (entry.isDirectory() && !entry.isSymbolicLink()) { walk(full, rel); continue }
      fileCount += 1
      bytes += entry.size
      if (files.length < FILE_LIST_CAP) {
        files.push({ path: rel, kind: entry.isSymbolicLink() ? 'link' : entry.isFile() ? 'file' : 'other', bytes: entry.size })
      } else {
        truncated = true
      }
    }
  }
  walk(target, '')
  const created = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs
  return { path: target, worktreeName: match[1], createdAt: Math.round(created), fileCount, bytes, files, truncated }
}

/** Every archive beneath one project's worktrees root. A missing root is empty. */
export function listOverlayQuarantines(worktreesRoot: string): OverlayQuarantine[] {
  if (!realDirectory(worktreesRoot)) return []
  const found: OverlayQuarantine[] = []
  const scan = (dir: string, depth: number): void => {
    let names: string[]
    try { names = fs.readdirSync(dir) } catch { return }
    for (const name of names) {
      const full = path.join(dir, name)
      if (!realDirectory(full)) continue
      if (isOverlayQuarantineName(name)) {
        const described = describeOverlayQuarantine(full)
        if (described) found.push(described)
        continue
      }
      if (depth < MAX_SCAN_DEPTH) scan(full, depth + 1)
    }
  }
  scan(worktreesRoot, 1)
  return found.sort((a, b) => b.createdAt - a.createdAt || a.path.localeCompare(b.path))
}

export type QuarantineTargetCheck =
  | { ok: true; path: string }
  | { ok: false; reason: 'invalid' | 'missing' | 'not-a-quarantine' | 'outside-project' }

/** Resolve a client-supplied path to an archive of THIS project, or refuse. */
export function checkOverlayQuarantineTarget(worktreesRoot: string, candidate: unknown): QuarantineTargetCheck {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0') || !path.isAbsolute(candidate)) {
    return { ok: false, reason: 'invalid' }
  }
  const normalized = path.resolve(candidate)
  if (!isOverlayQuarantineName(path.basename(normalized))) return { ok: false, reason: 'not-a-quarantine' }
  let stat: fs.Stats
  try { stat = fs.lstatSync(normalized) } catch { return { ok: false, reason: 'missing' } }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, reason: 'not-a-quarantine' }
  let realRoot: string
  let realParent: string
  try {
    realRoot = fs.realpathSync(worktreesRoot)
    realParent = fs.realpathSync(path.dirname(normalized))
  } catch {
    return { ok: false, reason: 'outside-project' }
  }
  const resolved = path.join(realParent, path.basename(normalized))
  if (!inside(realRoot, resolved)) return { ok: false, reason: 'outside-project' }
  return { ok: true, path: resolved }
}

export type QuarantineDeletion =
  | { status: 'deleted'; path: string; fileCount: number; bytes: number }
  | { status: 'refused'; path: string; reason: 'invalid' | 'missing' | 'not-a-quarantine' | 'outside-project' }
  | { status: 'failed'; path: string; error: string }

/** Delete one confirmed archive of this project. Logged for the audit trail. */
export function deleteOverlayQuarantine(
  worktreesRoot: string,
  candidate: unknown,
  context: { projectId: string; log?: (line: string) => void },
): QuarantineDeletion {
  const shown = typeof candidate === 'string' ? candidate : ''
  const check = checkOverlayQuarantineTarget(worktreesRoot, candidate)
  const log = context.log ?? ((line: string) => console.info(line))
  if (!check.ok) {
    log(`[overlay-quarantine] refused delete project=${context.projectId} reason=${check.reason} path=${JSON.stringify(shown)}`)
    return { status: 'refused', path: shown, reason: check.reason }
  }
  const described = describeOverlayQuarantine(check.path)
  try {
    // `rmSync` unlinks links found inside instead of following them.
    fs.rmSync(check.path, { recursive: true })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log(`[overlay-quarantine] delete failed project=${context.projectId} path=${JSON.stringify(check.path)} error=${JSON.stringify(error)}`)
    return { status: 'failed', path: check.path, error }
  }
  const fileCount = described?.fileCount ?? 0
  const bytes = described?.bytes ?? 0
  log(`[overlay-quarantine] deleted project=${context.projectId} path=${JSON.stringify(check.path)} files=${fileCount} bytes=${bytes}`)
  return { status: 'deleted', path: check.path, fileCount, bytes }
}
