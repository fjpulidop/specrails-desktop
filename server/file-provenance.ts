import { execFileSync, execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { DbInstance } from './db'
import type { WsMessage, FileProvenanceUpdatedMessage } from './types'

export type DiffStatus = 'A' | 'M' | 'D' | 'R'

export interface DiffEntry {
  path: string
  status: DiffStatus
  renamedFrom?: string
}

export type ProvenanceKind = 'created' | 'modified' | 'deleted'

export interface ProvenanceRow {
  id: number
  file_path: string
  ticket_id: number | null
  job_id: string | null
  kind: ProvenanceKind
  at: number
}

const MAX_PATCH_BYTES = 512 * 1024

// These git calls run synchronously on the main event loop (pre-spawn snapshot
// and post-exit diff). Bound every one: a timeout so a stuck index.lock /
// filesystem stall / credential prompt can't freeze the whole app, a maxBuffer
// cap, and an env that disables any interactive prompt. The existing try/catch
// in each function degrades a timeout to empty provenance. Mirrors metrics.ts.
const GIT_TIMEOUT_MS = 15_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
// Bound on how many per-file patches we collect after a job. Each is a synchronous
// git spawn on the event loop, so a job touching hundreds of files would otherwise
// block the whole app. Provenance ROWS are recorded for every path regardless; only
// the on-demand diff patches beyond this cap are skipped (the UI shows "diff
// unavailable" for them). Mirrors the existing large-job warn threshold (50).
const MAX_PATCH_FILES = 50
// Exported: project-git.ts (the Agent-Mode git bar) runs the same cwd-scoped
// git calls and needs the identical hostile-repo hardening.
export const GIT_EXEC_ENV = (() => {
  // Inherit the parent env but STRIP git-location vars. If the app process (or a
  // parent) ever exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE, every cwd-scoped
  // git call below would silently operate on that repo instead of the project —
  // corrupting provenance. Always pin git to the cwd we pass.
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_COMMON_DIR
  delete env.GIT_OBJECT_DIRECTORY
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ASKPASS = 'echo'
  env.GCM_INTERACTIVE = 'never'
  // M2: these git calls run INSIDE the project repo (cwd = project.path) for every
  // queued job, and git honors the repo's own .git/config. A hostile repo added as
  // a project can ship `[core] fsmonitor = <script>` (or a hook) that git executes
  // during index refresh (stash create / diff / status) → RCE on job spawn. Strip
  // system config and override the hook-bearing keys for ALL invocations via
  // GIT_CONFIG_PARAMETERS (same precedence as `-c`, so it wins over the repo's
  // local config). Disabling fsmonitor only costs a perf hint; provenance reads
  // never need hooks.
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_PARAMETERS = "'core.fsmonitor=false' 'core.hooksPath=/dev/null' 'protocol.ext.allow=user'"
  return env
})()

export interface WorkingTreeSnapshot {
  /** `git stash create` ref, or '' when the tree was clean / git failed. */
  ref: string
  /** Untracked paths present at snapshot time (excluded from "created" later). */
  untracked: string[]
  /** HEAD commit SHA captured at snapshot time, or '' when git failed / unborn
   *  HEAD. Used as the diff base when `ref` is empty (clean tree): a job that
   *  commits its work advances HEAD, so diffing against live HEAD at exit would
   *  report nothing — the frozen pre-job SHA preserves the real delta. */
  headSha: string
}

/** Resolve the current HEAD commit SHA. Best-effort: '' on any git failure
 *  (no repo, unborn HEAD, no git, timeout). */
export function resolveHeadSha(cwd: string): string {
  try {
    const out = execSync('git rev-parse HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: GIT_EXEC_ENV,
    })
    return out.trim()
  } catch {
    return ''
  }
}

/** List untracked, non-ignored paths in the working tree. Best-effort: any git
 *  failure (no git, no repo, timeout) degrades to []. */
export function listUntracked(cwd: string): string[] {
  try {
    const out = execSync('git ls-files --others --exclude-standard -z', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: GIT_EXEC_ENV,
    })
    return out.split('\0').filter((p) => p.length > 0)
  } catch {
    return []
  }
}

export function snapshotWorkingTree(cwd: string): WorkingTreeSnapshot {
  let ref = ''
  try {
    const out = execSync('git stash create --include-untracked', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: GIT_EXEC_ENV,
    })
    ref = out.trim()
  } catch (err) {
    const msg = (err as { message?: string }).message ?? ''
    if (/ENOENT|not found|command not found/i.test(msg)) {
      throw err
    }
    ref = ''
  }
  // Capture the untracked set NOW so the post-job diff can tell rail-created
  // files apart from files that were already untracked before the job ran. Also
  // freeze the HEAD SHA so a job that commits from a clean tree is still diffed
  // against its true starting point (not the post-commit HEAD).
  return { ref, untracked: listUntracked(cwd), headSha: resolveHeadSha(cwd) }
}

export function diffAgainstSnapshot(
  cwd: string,
  snapshotRef: string,
  untrackedBefore?: string[],
  baseSha?: string,
): DiffEntry[] {
  const hasSnap = snapshotRef && snapshotRef.length > 0
  // When there is no stash ref (clean tree at snapshot time), prefer the frozen
  // pre-job HEAD SHA over the literal 'HEAD'. A job that commits its output
  // advances HEAD, so `git diff HEAD` at exit would report nothing — the frozen
  // base recovers the real created/modified/deleted set.
  const ref = hasSnap ? snapshotRef : (baseSha && baseSha.length > 0 ? baseSha : 'HEAD')
  let out = ''
  try {
    // --find-renames so rename detection is deterministic regardless of the
    // user's global `diff.renames` config (matches collectDiffPatches).
    out = execSync(`git diff --name-status --find-renames -z ${ref} --`, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: GIT_EXEC_ENV,
    })
  } catch {
    out = ''
  }

  const entries: DiffEntry[] = []
  const seen = new Set<string>()

  if (out) {
    const tokens = out.split('\0').filter((t) => t.length > 0)
    let i = 0
    while (i < tokens.length) {
      const raw = tokens[i]
      const code = raw[0]
      if (code === 'R' || code === 'C') {
        // Rename/copy: `<status>\0<old>\0<new>\0`.
        const oldPath = tokens[i + 1]
        const newPath = tokens[i + 2]
        if (oldPath !== undefined && newPath !== undefined && !seen.has(newPath)) {
          entries.push(
            code === 'R'
              ? { path: newPath, status: 'R', renamedFrom: oldPath }
              : { path: newPath, status: 'A' },
          )
          seen.add(newPath)
        }
        i += 3
        continue
      }
      if (code === 'A' || code === 'M' || code === 'D') {
        const p = tokens[i + 1]
        if (p !== undefined && !seen.has(p)) {
          entries.push({ path: p, status: code })
          seen.add(p)
        }
        i += 2
        continue
      }
      if (code === 'T') {
        // Typechange (file⇄symlink, regular⇄submodule). Record as modified.
        const p = tokens[i + 1]
        if (p !== undefined && !seen.has(p)) {
          entries.push({ path: p, status: 'M' })
          seen.add(p)
        }
        i += 2
        continue
      }
      // Unknown single-letter status: `<status>\0<path>\0`. Consume the pair so
      // the path token is never re-read as a status (which would corrupt the
      // rest of the stream).
      i += 2
    }
  }

  // `git diff <ref>` only reports TRACKED-file deltas — it never lists untracked
  // files. New files a rail creates are untracked, so without this pass they are
  // silently lost whenever the tree was dirty at snapshot time (the common case).
  // Always surface currently-untracked paths, minus those already untracked at
  // snapshot time (which the rail did not create), as 'A' (created).
  const before = new Set(untrackedBefore ?? [])
  for (const p of listUntracked(cwd)) {
    if (!seen.has(p) && !before.has(p)) {
      entries.push({ path: p, status: 'A' })
      seen.add(p)
    }
  }

  return entries
}

export interface StoredPatch {
  patch: string
  truncated: boolean
}

/** Upper bound on the patch excerpt stored per intervention in
 *  file_story_contributions (the full patch stays in file_provenance_diffs). */
export const STORY_EXCERPT_MAX_BYTES = 4096

/** Count added/removed lines in a unified diff. Skips the `+++`/`---` file
 *  headers and the `\ No newline` marker so stats reflect content lines only. */
export function computeDiffStats(patch: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

/** Cap a patch to STORY_EXCERPT_MAX_BYTES on a line boundary. */
export function excerptPatch(patch: string, capBytes: number = STORY_EXCERPT_MAX_BYTES): string {
  if (Buffer.byteLength(patch, 'utf8') <= capBytes) return patch
  let out = ''
  for (const line of patch.split('\n')) {
    const candidate = out.length > 0 ? `${out}\n${line}` : line
    if (Buffer.byteLength(candidate, 'utf8') > capBytes) break
    out = candidate
  }
  return `${out}\n[specrails-desktop] excerpt truncated\n`
}

function truncatePatch(patch: string): StoredPatch {
  const bytes = Buffer.byteLength(patch, 'utf8')
  if (bytes <= MAX_PATCH_BYTES) return { patch, truncated: false }
  return {
    patch: `${patch.slice(0, MAX_PATCH_BYTES)}\n[specrails-desktop] diff truncated at ${MAX_PATCH_BYTES} bytes\n`,
    truncated: true,
  }
}

function addedFilePatch(cwd: string, relPath: string): string {
  const abs = path.resolve(cwd, relPath)
  const root = cwd.endsWith(path.sep) ? cwd : `${cwd}${path.sep}`
  if (abs !== cwd && !abs.startsWith(root)) return ''
  let content = ''
  try {
    const stat = fs.statSync(abs)
    if (!stat.isFile() || stat.size > MAX_PATCH_BYTES) return ''
    content = fs.readFileSync(abs, 'utf8')
  } catch {
    return ''
  }
  const noTrailingNewline = content.length > 0 && !content.endsWith('\n')
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const body = lines.map((line) => `+${line}`)
  // Mirror git's own unified-diff output for a file with no terminating newline.
  if (noTrailingNewline) body.push('\\ No newline at end of file')
  return [
    `diff --git a/${relPath} b/${relPath}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${relPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...body,
    '',
  ].join('\n')
}

export function collectDiffPatches(cwd: string, snapshotRef: string, diff: DiffEntry[], baseSha?: string): Map<string, StoredPatch> {
  const patches = new Map<string, StoredPatch>()
  if (diff.length === 0) return patches

  // Same frozen-base fallback as diffAgainstSnapshot: a clean-tree snapshot has
  // no stash ref, so use the pre-job HEAD SHA to capture patches for committed
  // work instead of diffing against the (advanced) live HEAD.
  const ref = snapshotRef && snapshotRef.length > 0
    ? snapshotRef
    : (baseSha && baseSha.length > 0 ? baseSha : 'HEAD')
  // Cap the number of per-file git spawns: each runs synchronously on the event
  // loop. Beyond the cap, provenance rows are still recorded (by the caller) but
  // patches are skipped — the UI renders "diff unavailable" for them.
  const capped = diff.slice(0, MAX_PATCH_FILES)
  for (const entry of capped) {
    // For a rename, scope the diff to BOTH paths so git can pair them and emit a
    // proper `rename from`/`rename to` patch instead of a delete + 100%-add.
    const pathspec = entry.status === 'R' && entry.renamedFrom !== undefined
      ? [entry.renamedFrom, entry.path]
      : [entry.path]
    let patch = ''
    try {
      patch = execFileSync('git', ['diff', '--no-ext-diff', '--find-renames', '--unified=80', ref, '--', ...pathspec], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: MAX_PATCH_BYTES + 64 * 1024,
        timeout: GIT_TIMEOUT_MS,
        env: GIT_EXEC_ENV,
      })
    } catch (err) {
      patch = ((err as { stdout?: string }).stdout ?? '').toString()
    }
    if (!patch && entry.status === 'A') patch = addedFilePatch(cwd, entry.path)
    if (patch) patches.set(entry.path, truncatePatch(patch))
  }
  return patches
}

export function recordProvenanceForJob(
  db: DbInstance,
  projectId: string,
  jobId: string,
  ticketId: number | null,
  diff: DiffEntry[],
  atMs: number = Date.now(),
  patches?: Map<string, StoredPatch>,
): ProvenanceRow[] {
  void projectId
  if (diff.length === 0) return []

  type Pending = { file_path: string; kind: ProvenanceKind }
  const pending: Pending[] = []
  for (const entry of diff) {
    if (entry.status === 'A') {
      pending.push({ file_path: entry.path, kind: 'created' })
    } else if (entry.status === 'M') {
      pending.push({ file_path: entry.path, kind: 'modified' })
    } else if (entry.status === 'D') {
      pending.push({ file_path: entry.path, kind: 'deleted' })
    } else if (entry.status === 'R') {
      // rename = two rows because tree row tracking needs both the new path (modified) and old path (deleted)
      pending.push({ file_path: entry.path, kind: 'modified' })
      if (entry.renamedFrom !== undefined) {
        pending.push({ file_path: entry.renamedFrom, kind: 'deleted' })
      }
    }
  }

  const insert = db.prepare(`
    INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at)
    VALUES (?, ?, ?, ?, ?)
  `)
  let insertPatch: any = null
  try {
    insertPatch = db.prepare(`
      INSERT OR REPLACE INTO file_provenance_diffs (provenance_id, patch, truncated)
      VALUES (?, ?, ?)
    `)
  } catch {
    insertPatch = null
  }
  // Construction-story stats (migration 37): one row per provenance row that had
  // a collectable patch — added/removed line counts + a ~4KB excerpt. Written in
  // the SAME transaction so every provenance producer (queue-manager jobs and
  // the loop-run seam in file-story.ts) records stats with no extra call. The
  // prepare is guarded like insertPatch so a pre-migration DB degrades cleanly.
  let insertContribution: any = null
  try {
    insertContribution = db.prepare(`
      INSERT OR REPLACE INTO file_story_contributions
        (provenance_id, job_id, file_path, added_lines, removed_lines, patch_excerpt)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
  } catch {
    insertContribution = null
  }

  const inserted: ProvenanceRow[] = []
  const tx = db.transaction((rows: Pending[]) => {
    for (const r of rows) {
      const result = insert.run(r.file_path, ticketId, jobId, r.kind, atMs)
      inserted.push({
        id: Number(result.lastInsertRowid),
        file_path: r.file_path,
        ticket_id: ticketId,
        job_id: jobId,
        kind: r.kind,
        at: atMs,
      })
      const storedPatch = patches?.get(r.file_path)
      if (insertPatch && storedPatch) {
        insertPatch.run(Number(result.lastInsertRowid), storedPatch.patch, storedPatch.truncated ? 1 : 0)
      }
      if (insertContribution && storedPatch) {
        const stats = computeDiffStats(storedPatch.patch)
        insertContribution.run(
          Number(result.lastInsertRowid),
          jobId,
          r.file_path,
          stats.added,
          stats.removed,
          excerptPatch(storedPatch.patch),
        )
      }
    }
  })
  tx(pending)
  return inserted
}

export function getProvenanceDiff(
  db: DbInstance,
  projectId: string,
  jobId: string,
  filePath: string,
): { patch: string; truncated: boolean } | null {
  void projectId
  try {
    const row = db.prepare(
      `SELECT d.patch, d.truncated
       FROM file_provenance p
       JOIN file_provenance_diffs d ON d.provenance_id = p.id
       WHERE p.job_id = ? AND p.file_path = ?
       ORDER BY p.at DESC, p.id DESC
       LIMIT 1`,
    ).get(jobId, filePath) as { patch: string; truncated: number } | undefined
    return row ? { patch: row.patch, truncated: row.truncated === 1 } : null
  } catch {
    return null
  }
}

export function listProvenanceByTicket(
  db: DbInstance,
  projectId: string,
  ticketId: number,
): ProvenanceRow[] {
  void projectId
  return db.prepare(
    `SELECT id, file_path, ticket_id, job_id, kind, at
     FROM file_provenance WHERE ticket_id = ? ORDER BY at DESC`,
  ).all(ticketId) as ProvenanceRow[]
}

export function listProvenanceByPath(
  db: DbInstance,
  projectId: string,
  filePath: string,
): ProvenanceRow[] {
  void projectId
  return db.prepare(
    `SELECT id, file_path, ticket_id, job_id, kind, at
     FROM file_provenance WHERE file_path = ? ORDER BY at DESC`,
  ).all(filePath) as ProvenanceRow[]
}

export function broadcastProvenanceUpdated(
  broadcast: (msg: WsMessage) => void,
  projectId: string,
  row: ProvenanceRow,
): void {
  const msg: FileProvenanceUpdatedMessage = {
    type: 'file.provenance_updated',
    projectId,
    path: row.file_path,
    kind: row.kind,
    ticketId: row.ticket_id,
    jobId: row.job_id,
    at: row.at,
  }
  broadcast(msg)
}
