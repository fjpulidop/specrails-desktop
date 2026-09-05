import fs from 'fs'
import path from 'path'
import { createHash } from 'node:crypto'
import { spawn } from 'child_process'
import { Router, Request, Response } from 'express'
import type { DbInstance } from './db'
import type { WsMessage } from './types'
import { isCodeExplorerEnabled } from './feature-flags'
import { BUILD_DIRS } from './build-dirs'
import {
  listProvenanceByPath,
  listProvenanceByTicket,
  getProvenanceDiff,
  type ProvenanceRow,
} from './file-provenance'
import {
  readSummary,
  computeFileHash,
  pathHash,
  summariesDir,
  type FileSummaryManager,
  type SummaryPayload,
} from './file-summary-manager'
import { getFileStory, type TicketSpecLookup } from './file-story'
import type { FileStoryManager } from './file-story-manager'
import { getAdapter, pureOutputToolPolicy } from './providers'

declare module 'express-serve-static-core' {
  interface Request {
    projectCtx?: import('./project-registry').ProjectContext
  }
}

const MAX_TREE_PAGE = 2000
const DEFAULT_MAX_TREE_ENTRIES = 20_000
const DEFAULT_TREE_SCAN_MS = 5_000
const TREE_YIELD_EVERY = 128
const GIT_IGNORE_CHUNK = 1_000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const BINARY_PROBE_BYTES = 8 * 1024
const MAX_CODE_PAGE_LINES = 500
const MAX_CODE_PAGE_CHARS = 20_000
const MAX_SEARCH_FILES = 1_000
const MAX_SEARCH_BYTES = 8 * 1024 * 1024
const MAX_SEARCH_MS = 2_000

/** Read a regular file through one descriptor with a hard byte ceiling, even
 * if a writer grows it after stat. Never interpret a truncated read as text. */
async function readBoundedSource(abs: string, maxBytes: number): Promise<Buffer | 'too-large' | 'not-file'> {
  const before = await fs.promises.stat(abs)
  if (!before.isFile()) return 'not-file'
  if (before.size > maxBytes) return 'too-large'
  // A FIFO swapped in between stat/open must not hang an agent request. fstat
  // below still validates the descriptor before any bytes are read.
  const flags = fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK)
  const handle = await fs.promises.open(abs, flags)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return 'not-file'
    if (stat.size > maxBytes) return 'too-large'
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1))
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) return buffer.subarray(0, offset)
      offset += bytesRead
    }
    // Filled the extra byte: the file changed while reading. Retry a fresh
    // snapshot instead of serving content whose completeness is unknown.
    return 'too-large'
  } finally { await handle.close() }
}

// Hard-coded app deny-list (mirrors design D8). Dotfiles are excluded by name
// prefix; build/dep dirs come from the shared BUILD_DIRS set (node_modules, dist,
// build, out, coverage, target, vendor) so the on-demand tree walk skips the same
// heavy trees the file-summary watcher prunes; extensions handled below.
const DENY_EXTS = new Set(['.lock', '.log'])
// Secret-bearing extensions/names blocked as defense-in-depth so credentials are
// never served to the (non-developer) reader even if .gitignore is missing or git
// is unavailable. Kept conservative to avoid hiding ordinary source files.
const SECRET_EXTS = new Set(['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks'])
const SECRET_NAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'])
const DENY_NAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])

function isDenied(entryName: string): boolean {
  // Dotfiles (.env, .npmrc, .netrc, .git, …) are denied wholesale by prefix.
  if (entryName.startsWith('.')) return true
  // Case-insensitive for dir/lockfile names: macOS (APFS) and Windows (NTFS) are
  // case-insensitive, so `Node_Modules` / `Package-Lock.json` resolve to the same
  // denied path on disk and must not slip past the policy.
  const lower = entryName.toLowerCase()
  if (BUILD_DIRS.has(lower)) return true
  const ext = path.extname(lower)
  if (DENY_EXTS.has(ext) || SECRET_EXTS.has(ext)) return true
  if (DENY_NAMES.has(lower) || SECRET_NAMES.has(lower)) return true
  return false
}

// Apply the deny-list to ANY segment of a relative path so the policy is the
// single source of truth across every surface (tree walk, touched-by-ai list,
// and the content endpoints) — not just the top-level `all` walk.
function isDeniedRelPath(rel: string): boolean {
  return rel.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.').some(isDenied)
}

// Normalize a client-supplied relative path to POSIX separators so summary
// (sha256 of relPath), provenance (git always emits '/'), and content lookups
// all key off ONE canonical form regardless of the request's separator style.
function normalizeRel(rel: string): string {
  return rel.split(/[\\/]/).filter((seg) => seg.length > 0).join('/')
}

// Return the subset of `relPaths` that git considers ignored (honours nested
// .gitignore, excludes tracked files — exactly the set we must hide). One batched
// `git check-ignore` spawn. Best-effort: any git failure (no repo, no git) → no
// paths reported, so the deny-list remains the only filter. `check-ignore` exits
// 1 ("none ignored") which execFileSync throws on — the matched list still lands
// on stdout, so both branches read stdout.
async function gitIgnoredSet(projectPath: string, relPaths: string[], maxDurationMs = Number.POSITIVE_INFINITY): Promise<Set<string>> {
  if (relPaths.length === 0) return new Set()
  const ignored = new Set<string>()
  const deadline = Date.now() + maxDurationMs
  for (let offset = 0; offset < relPaths.length; offset += GIT_IGNORE_CHUNK) {
    if (Date.now() >= deadline) break
    const chunk = relPaths.slice(offset, offset + GIT_IGNORE_CHUNK)
    let out = ''
    out = await new Promise<string>((resolve) => {
      let stdout = ''
      let settled = false
      const child = spawn('git', ['check-ignore', '--stdin', '-z'], { cwd: projectPath, stdio: ['pipe', 'pipe', 'ignore'] })
      const finish = () => { if (!settled) { settled = true; resolve(stdout) } }
      const timer = setTimeout(() => { try { child.kill('SIGTERM') } catch { /* gone */ }; finish() }, Math.min(5_000, Math.max(1, deadline - Date.now())))
      timer.unref?.()
      child.stdout?.on('data', (data: Buffer) => {
        if (stdout.length < 4 * 1024 * 1024) stdout += data.toString('utf8')
      })
      child.once('error', () => { clearTimeout(timer); finish() })
      child.once('close', () => { clearTimeout(timer); finish() })
      child.stdin?.on('error', () => { /* git may exit before reading stdin */ })
      child.stdin?.end(chunk.join('\0') + '\0')
    })
    for (const rel of out.split('\0')) if (rel) ignored.add(rel)
  }
  return ignored
}

async function isGitIgnored(projectPath: string, relPath: string): Promise<boolean> {
  return (await gitIgnoredSet(projectPath, [relPath])).has(relPath)
}

function languageForExt(ext: string): string {
  const e = ext.toLowerCase()
  switch (e) {
    case '.ts':
    case '.tsx':
    case '.cts':
    case '.mts': return 'typescript'
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs': return 'javascript'
    case '.json': return 'json'
    case '.md': return 'markdown'
    case '.py': return 'python'
    case '.rs': return 'rust'
    case '.go': return 'go'
    case '.css': return 'css'
    case '.html': return 'html'
    case '.yml':
    case '.yaml': return 'yaml'
    case '.sh': return 'shell'
    case '.sql': return 'sql'
    case '.toml': return 'toml'
    default: return 'plaintext'
  }
}

function decodeCursor(raw: string | undefined): { skip: number } {
  if (!raw) return { skip: 0 }
  try {
    const json = Buffer.from(raw, 'base64').toString('utf8')
    const parsed = JSON.parse(json) as { skip?: number }
    if (typeof parsed.skip === 'number' && parsed.skip >= 0) return { skip: parsed.skip }
  } catch {
    // fall through to default
  }
  return { skip: 0 }
}

function encodeCursor(skip: number): string {
  return Buffer.from(JSON.stringify({ skip }), 'utf8').toString('base64')
}

interface TreeEntryProvenance {
  createdByTicketId: number | null
  modifiedByTicketIds: number[]
  latest: ProvenanceRow | null
  touchedFileCount: number
  rows: ProvenanceRow[]
}

interface TreeEntry {
  path: string
  kind: 'file' | 'dir'
  sizeBytes: number | null
  hasSummary: boolean
  provenance: TreeEntryProvenance
  lastModifiedAt: number | null
}

function rollupProvenance(rows: ProvenanceRow[]): TreeEntryProvenance {
  let createdByTicketId: number | null = null
  const modifiedSet = new Set<number>()
  // `rows` arrives ordered by `at DESC`. Walk oldest → newest so the earliest
  // 'created' wins for createdByTicketId.
  for (const r of [...rows].reverse()) {
    if (r.ticket_id == null) continue
    if (r.kind === 'created' && createdByTicketId == null) {
      createdByTicketId = r.ticket_id
    } else if (r.kind === 'modified') {
      modifiedSet.add(r.ticket_id)
    }
  }
  // Don't double-count the creating ticket in the modified chips list.
  if (createdByTicketId != null) modifiedSet.delete(createdByTicketId)
  return {
    createdByTicketId,
    modifiedByTicketIds: [...modifiedSet],
    latest: rows[0] ?? null,
    touchedFileCount: 0,
    rows,
  }
}

function rollupDirectoryProvenance(rowsByPath: Map<string, ProvenanceRow[]>, dirPath: string): TreeEntryProvenance {
  const prefix = `${dirPath}/`
  const childRows: ProvenanceRow[] = []
  let touchedFileCount = 0
  for (const [filePath, rows] of rowsByPath) {
    if (!filePath.startsWith(prefix)) continue
    touchedFileCount += 1
    childRows.push(...rows)
  }
  childRows.sort((a, b) => b.at - a.at)
  return {
    ...rollupProvenance(childRows),
    touchedFileCount,
  }
}

function provenanceToJson(row: ProvenanceRow | null): unknown {
  if (!row) return null
  return {
    path: row.file_path,
    ticketId: row.ticket_id,
    jobId: row.job_id,
    kind: row.kind,
    at: row.at,
  }
}

function provenanceRowsToJson(rows: ProvenanceRow[]): unknown[] {
  return rows.map((row) => ({
    path: row.file_path,
    ticketId: row.ticket_id,
    jobId: row.job_id,
    kind: row.kind,
    at: row.at,
  }))
}

function treeProvenanceToJson(provenance: TreeEntryProvenance): unknown {
  return {
    createdByTicketId: provenance.createdByTicketId,
    modifiedByTicketIds: provenance.modifiedByTicketIds,
    latest: provenanceToJson(provenance.latest),
    touchedFileCount: provenance.touchedFileCount,
    rows: provenanceRowsToJson(provenance.rows),
  }
}

function parsePositiveInt(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

function parseNonEmptyString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
}

function listTouchedRows(
  db: DbInstance,
  filters: { ticketId?: number | null; jobId?: string | null; path?: string | null },
): ProvenanceRow[] {
  const where: string[] = []
  const args: Array<string | number> = []
  if (filters.ticketId != null) {
    where.push('ticket_id = ?')
    args.push(filters.ticketId)
  }
  if (filters.jobId) {
    where.push('job_id = ?')
    args.push(filters.jobId)
  }
  if (filters.path) {
    where.push('file_path = ?')
    args.push(filters.path)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  return db.prepare(
    `SELECT id, file_path, ticket_id, job_id, kind, at
     FROM file_provenance ${whereSql}
     ORDER BY file_path ASC, at DESC`,
  ).all(...args) as ProvenanceRow[]
}

interface TreeScanResult {
  entries: Array<{ rel: string; isDir: boolean; size: number | null; mtime: number | null }>
  truncated: boolean
  reason: 'entry-limit' | 'time-limit' | 'read-errors' | null
  visited: number
  durationMs: number
  maxEntries: number
  maxDurationMs: number
}

const DEFAULT_FIND_LIMIT = 20
const MAX_FIND_LIMIT = 50
const MAX_FIND_QUERY_LENGTH = 256

export type FindMatchKind = 'exact' | 'suffix' | 'basename' | 'substring'

export interface FindMatch {
  rel: string
  size: number | null
  match: FindMatchKind
}

/**
 * Rank the files of a scan against a name / path-suffix / fragment query.
 * Case-insensitive, POSIX-normalised. Order: `exact` (whole relpath), `suffix`
 * (the query is the tail of the relpath — the "path copied from a stack trace
 * or import that is relative to some subdirectory" case), `basename` (same
 * file name under another directory), `substring`; ties break on the shorter
 * path. Directories never match — the caller wants something to read.
 */
export function rankFindMatches(
  entries: ReadonlyArray<{ rel: string; isDir: boolean; size: number | null }>,
  query: string,
): FindMatch[] {
  const needle = query.trim().replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').toLowerCase()
  if (!needle) return []
  const needleBase = needle.slice(needle.lastIndexOf('/') + 1)
  const order: Record<FindMatchKind, number> = { exact: 0, suffix: 1, basename: 2, substring: 3 }
  const out: FindMatch[] = []
  for (const e of entries) {
    if (e.isDir) continue
    const rel = e.rel.toLowerCase()
    const base = rel.slice(rel.lastIndexOf('/') + 1)
    let match: FindMatchKind | null = null
    if (rel === needle) match = 'exact'
    else if (rel.endsWith(`/${needle}`)) match = 'suffix'
    else if (needleBase && base === needleBase) match = 'basename'
    else if (rel.includes(needle)) match = 'substring'
    if (match) out.push({ rel: e.rel, size: e.size, match })
  }
  out.sort((a, b) =>
    order[a.match] - order[b.match] || a.rel.length - b.rel.length || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0),
  )
  return out
}

function positiveEnvInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

async function listAllEntries(projectPath: string): Promise<TreeScanResult> {
  const started = Date.now()
  const maxEntries = positiveEnvInt('SPECRAILS_CODE_TREE_MAX_ENTRIES', DEFAULT_MAX_TREE_ENTRIES)
  const maxMs = positiveEnvInt('SPECRAILS_CODE_TREE_MAX_MS', DEFAULT_TREE_SCAN_MS)
  const out: Array<{ rel: string; isDir: boolean; size: number | null; mtime: number | null }> = []
  const stack: string[] = [projectPath]
  let visited = 0
  let reason: TreeScanResult['reason'] = null
  while (stack.length > 0) {
    if (visited >= maxEntries) { reason = 'entry-limit'; break }
    if (Date.now() - started >= maxMs) { reason = 'time-limit'; break }
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      reason ??= 'read-errors'
      continue
    }
    for (const entry of entries) {
      visited += 1
      if (visited % TREE_YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      if (visited >= maxEntries) { reason = 'entry-limit'; break }
      if (Date.now() - started >= maxMs) { reason = 'time-limit'; break }
      if (isDenied(entry.name)) continue
      const abs = path.join(dir, entry.name)
      // Normalize to POSIX so provenance/summary lookups (which are '/'-keyed)
      // match on Windows, where path.relative emits backslashes.
      const rel = normalizeRel(path.relative(projectPath, abs))
      if (entry.isDirectory()) {
        out.push({ rel, isDir: true, size: null, mtime: null })
        stack.push(abs)
      } else if (entry.isFile()) {
        let size: number | null = null
        let mtime: number | null = null
        try {
          const st = await fs.promises.stat(abs)
          size = st.size
          mtime = st.mtimeMs
        } catch {
          // ignore
        }
        out.push({ rel, isDir: false, size, mtime })
      }
    }
  }
  // Drop gitignored files (honours the documented .gitignore-respect contract).
  // Directories are kept — git can't report an ignored dir without its files, and
  // an empty dir node is harmless; its ignored children are already filtered.
  const files = out.filter((e) => !e.isDir).map((e) => e.rel)
  const ignored = await gitIgnoredSet(projectPath, files)
  const filtered = ignored.size > 0 ? out.filter((e) => e.isDir || !ignored.has(e.rel)) : out
  filtered.sort((a, b) => a.rel.localeCompare(b.rel))
  return {
    entries: filtered,
    truncated: reason !== null,
    reason,
    visited,
    durationMs: Date.now() - started,
    maxEntries,
    maxDurationMs: maxMs,
  }
}

async function listTouchedEntries(
  projectPath: string,
  rowsByPath: Map<string, ProvenanceRow[]>,
): Promise<Array<{ rel: string; isDir: boolean; size: number | null; mtime: number | null }>> {
  const seen = new Set<string>()
  const out: Array<{ rel: string; isDir: boolean; size: number | null; mtime: number | null }> = []

  // Drop gitignored files too — mirroring listAllEntries — so a gitignored
  // AI-touched file (e.g. config.local.json, a custom build dir) whose name is
  // not deny-listed never surfaces its path / ticket-attribution / mtime. One
  // batched git check-ignore over the not-already-denied touched files.
  const candidateFiles = [...rowsByPath.keys()].filter((p) => !isDeniedRelPath(p))
  const ignored = await gitIgnoredSet(projectPath, candidateFiles)

  for (const filePath of rowsByPath.keys()) {
    // Keep touched-by-ai consistent with the `all` tree (and never surface
    // secrets like .env that an AI job happened to touch).
    if (isDeniedRelPath(filePath)) continue
    if (ignored.has(filePath)) continue
    const parts = filePath.split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i += 1) {
      const dirRel = parts.slice(0, i).join('/')
      if (!seen.has(dirRel)) {
        seen.add(dirRel)
        out.push({ rel: dirRel, isDir: true, size: null, mtime: null })
      }
    }

    if (seen.has(filePath)) continue
    seen.add(filePath)
    const abs = path.join(projectPath, filePath)
    let size: number | null = null
    let mtime: number | null = null
    try {
      const st = fs.statSync(abs)
      size = st.size
      mtime = st.mtimeMs
    } catch {
      // file may have been deleted after provenance was recorded
    }
    out.push({ rel: filePath, isDir: false, size, mtime })
  }

  out.sort((a, b) => {
    const byPath = a.rel.localeCompare(b.rel)
    if (byPath !== 0) return byPath
    return Number(b.isDir) - Number(a.isDir)
  })
  return out
}

// Set of summary file basenames (without `.json`), i.e. the path-hash of every
// file that currently has a summary on disk. One readdir replaces a per-entry
// readSummary disk hit during the tree walk.
function readSummaryHashSet(projectPath: string): Set<string> {
  const set = new Set<string>()
  let files: string[]
  try {
    files = fs.readdirSync(summariesDir(projectPath))
  } catch {
    return set
  }
  for (const f of files) {
    if (f.endsWith('.json')) set.add(f.slice(0, -'.json'.length))
  }
  return set
}

export interface CodeExplorerDeps {
  db: DbInstance
  /** The user's repo. Source files + the file tree are ALWAYS read from here. */
  projectPath: string
  projectId: string
  broadcast: (msg: WsMessage) => void
  fileSummaryManager: Pick<FileSummaryManager, 'enqueue' | 'attachWatcher'>
  listProvenanceByPath?: (db: DbInstance, projectId: string, filePath: string) => ProvenanceRow[]
  listProvenanceByTicket?: (db: DbInstance, projectId: string, ticketId: number) => ProvenanceRow[]
  /** Relocate-artifacts: where summary JSON lives (workspace when relocated,
   *  else === projectPath). Resolved per-call so a workspace that becomes
   *  populated mid-session is picked up. Defaults to `projectPath`. */
  resolveSummaryRoot?: () => string
  /** Construction story: live ticket title/status lookup (ProjectContext.
   *  getTicketSpec). Optional — story cards degrade to `#id` without it. */
  getTicketSpec?: TicketSpecLookup
  /** Construction story: the budget-gated per-intervention AI contribution
   *  generator. Optional — POST /file/story/explain 404s without it. */
  fileStoryManager?: Pick<FileStoryManager, 'explain'>
  /** Primary provider used by both Code Explorer AI transforms. The server
   *  adapter is authoritative; client-side visibility is only a convenience. */
  aiTransformProvider: string
}

export function createCodeExplorerRouter(deps: CodeExplorerDeps): Router {
  const router = Router({ mergeParams: true })

  const listByPath = deps.listProvenanceByPath ?? listProvenanceByPath
  const listByTicket = deps.listProvenanceByTicket ?? listProvenanceByTicket
  // Summary OUTPUT root (workspace when relocated). Source reads use projectPath.
  const summaryRoot = (): string => deps.resolveSummaryRoot?.() ?? deps.projectPath
  const aiTransformProvider = deps.aiTransformProvider
  const aiTransformsAvailable = pureOutputToolPolicy(
    getAdapter(aiTransformProvider),
  ) !== null

  function requireAiTransforms(res: Response): boolean {
    if (aiTransformsAvailable) return true
    res.status(409).json({
      error: 'provider_tool_policy_unsupported',
      provider: aiTransformProvider,
      requiredPolicy: 'pure-output',
    })
    return false
  }

  // Short-TTL per-project cache so paginating a large `all` tree reuses ONE
  // synchronous filesystem walk instead of re-walking (and re-statting) on every
  // page — the cursor only slices an already-materialized array. Also caches the
  // one-readdir summary-hash set. 5s is long enough for a pagination burst and
  // short enough that tree edits surface promptly.
  const WALK_CACHE_TTL_MS = 5000
  const allEntriesCache = new Map<string, { at: number; scan: TreeScanResult }>()
  const allEntriesInFlight = new Map<string, Promise<TreeScanResult>>()
  let watcherScheduled = false
  let summaryHashCache: { at: number; set: Set<string> } | null = null
  const nowMs = () => Date.now()
  async function getAllEntriesCached(relativeRoot = ''): Promise<{ scan: TreeScanResult; cache: 'hit' | 'shared' | 'miss' }> {
    const cached = allEntriesCache.get(relativeRoot)
    if (cached && nowMs() - cached.at < WALK_CACHE_TTL_MS) {
      return { scan: cached.scan, cache: 'hit' }
    }
    const existing = allEntriesInFlight.get(relativeRoot)
    if (existing) return { scan: await existing, cache: 'shared' }
    const pending = listAllEntries(relativeRoot ? path.join(deps.projectPath, relativeRoot) : deps.projectPath).then((scan) => relativeRoot
      ? { ...scan, entries: scan.entries.map((entry) => ({ ...entry, rel: `${relativeRoot}/${entry.rel}` })) }
      : scan)
    allEntriesInFlight.set(relativeRoot, pending)
    try {
      const scan = await pending
      // Bound retained trees when an agent searches many different subfolders.
      if (allEntriesCache.size >= 4 && !allEntriesCache.has(relativeRoot)) allEntriesCache.delete(allEntriesCache.keys().next().value!)
      allEntriesCache.set(relativeRoot, { at: nowMs(), scan })
      console.info('[code-explorer] tree scan', JSON.stringify({
        projectId: deps.projectId,
        durationMs: scan.durationMs,
        visited: scan.visited,
        returned: scan.entries.length,
        truncated: scan.truncated,
        reason: scan.reason,
      }))
      return { scan, cache: 'miss' }
    } finally {
      allEntriesInFlight.delete(relativeRoot)
    }
  }
  function getSummaryHashesCached(): Set<string> {
    if (summaryHashCache && nowMs() - summaryHashCache.at < WALK_CACHE_TTL_MS) return summaryHashCache.set
    const set = readSummaryHashSet(summaryRoot())
    summaryHashCache = { at: nowMs(), set }
    return set
  }

  // Feature-flag gate — entire prefix returns 404 when disabled.
  router.use((_req, res, next) => {
    if (!isCodeExplorerEnabled()) {
      res.status(404).end()
      return
    }
    // Lazily attach the file-summary watcher on first Code-Explorer use. A
    // provider without a native pure-output boundary must not attach it:
    // implicit file-change work and explicit POSTs both fail closed before a
    // manager or provider process can run.
    if (aiTransformsAvailable && !watcherScheduled) {
      watcherScheduled = true
      setImmediate(() => {
        try {
          deps.fileSummaryManager.attachWatcher(deps.projectId, deps.projectPath, summaryRoot())
        } catch (err) {
          console.warn('[code-explorer] watcher startup failed', JSON.stringify({
            projectId: deps.projectId,
            error: err instanceof Error ? err.message : String(err),
          }))
        }
      })
    }
    next()
  })

  router.get('/tree', async (req: Request, res: Response) => {
    const filter = (req.query.filter as string | undefined) ?? 'touched-by-ai'
    const withProvenance = req.query.withProvenance === '1' || req.query.withProvenance === 'true'
    const { skip } = decodeCursor(req.query.cursor as string | undefined)
    const requestedLimit = parsePositiveInt(req.query.limit)
    const pageLimit = Math.min(requestedLimit ?? MAX_TREE_PAGE, MAX_TREE_PAGE)
    const ticketId = parsePositiveInt(req.query.ticketId)
    const jobId = parseNonEmptyString(req.query.jobId)

    let entries: Array<{ rel: string; isDir: boolean; size: number | null; mtime: number | null }>
    let scanMeta: Omit<TreeScanResult, 'entries'> | null = null
    let cache: 'hit' | 'shared' | 'miss' | null = null
    const touchedRowsByPath = new Map<string, ProvenanceRow[]>()
    if (filter === 'touched-by-ai') {
      const rows = listTouchedRows(deps.db, { ticketId, jobId })
      for (const row of rows) {
        const existing = touchedRowsByPath.get(row.file_path)
        if (existing) existing.push(row)
        else touchedRowsByPath.set(row.file_path, [row])
      }
      entries = await listTouchedEntries(deps.projectPath, touchedRowsByPath)
    } else {
      const result = await getAllEntriesCached()
      entries = result.scan.entries
      cache = result.cache
      scanMeta = result.scan
      // Batch-load ALL provenance once instead of a per-entry SQL query (N+1).
      if (withProvenance) {
        for (const row of listTouchedRows(deps.db, {})) {
          const existing = touchedRowsByPath.get(row.file_path)
          if (existing) existing.push(row)
          else touchedRowsByPath.set(row.file_path, [row])
        }
      }
    }

    const page = entries.slice(skip, skip + pageLimit)
    const nextCursor = skip + page.length < entries.length ? encodeCursor(skip + page.length) : null

    // Read the summaries dir ONCE into a Set of path-hashes instead of opening +
    // parsing a JSON file per entry just to test existence (cached per project).
    const summaryHashes = getSummaryHashesCached()

    const out: TreeEntry[] = page.map((e) => {
      const isTouchedDir = filter === 'touched-by-ai' && e.isDir
      const rawRows = withProvenance && !isTouchedDir ? (touchedRowsByPath.get(e.rel) ?? []) : []
      const provenance = withProvenance && isTouchedDir
        ? rollupDirectoryProvenance(touchedRowsByPath, e.rel)
        : rollupProvenance(rawRows)
      return {
        path: e.rel,
        kind: e.isDir ? 'dir' : 'file',
        sizeBytes: e.size,
        hasSummary: !e.isDir && summaryHashes.has(pathHash(e.rel)),
        provenance,
        lastModifiedAt: e.mtime,
      }
    })

    res.json({
      entries: out.map((entry) => ({
        ...entry,
        provenance: treeProvenanceToJson(entry.provenance),
      })),
      nextCursor,
      ...(scanMeta ? {
        truncated: scanMeta.truncated,
        truncationReason: scanMeta.reason,
        scan: {
          visited: scanMeta.visited,
          durationMs: scanMeta.durationMs,
          maxEntries: scanMeta.maxEntries,
          maxDurationMs: scanMeta.maxDurationMs,
          retryable: scanMeta.truncated,
          cache,
        },
      } : {}),
    })
  })

  /**
   * Locate files by name / path-suffix / fragment across the whole scanned tree
   * (same deny-list + .gitignore rules as `/tree?filter=all`, same cached scan).
   * The escape hatch for a caller holding a path that is relative to some
   * subdirectory (a stack trace, an import): `/file` 404s, `/find` says where
   * the file actually lives.
   */
  router.get('/find', async (req: Request, res: Response) => {
    const q = parseNonEmptyString(req.query.q)
    if (!q) {
      res.status(400).json({ error: 'q is required' })
      return
    }
    if (q.length > MAX_FIND_QUERY_LENGTH) {
      res.status(400).json({ error: `q must be at most ${MAX_FIND_QUERY_LENGTH} characters` })
      return
    }
    const limit = Math.min(parsePositiveInt(req.query.limit) ?? DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT)
    const { scan } = await getAllEntriesCached()
    const ranked = rankFindMatches(scan.entries, q)
    res.json({
      query: q,
      matches: ranked.slice(0, limit).map((m) => ({ path: m.rel, sizeBytes: m.size, match: m.match })),
      total: ranked.length,
      truncated: scan.truncated || ranked.length > limit,
      truncationReason: scan.reason ?? (ranked.length > limit ? 'match-limit' : null),
    })
  })

  router.get('/search', async (req: Request, res: Response) => {
    const query = typeof req.query.q === 'string' ? req.query.q : ''
    if (!query.trim() || query.length > 256 || /[\r\n]/.test(query)) {
      res.status(400).json({ error: 'q must be a non-empty literal single-line query of at most 256 characters' })
      return
    }
    const selectedPath = parseNonEmptyString(req.query.path)
    const rawPath = selectedPath === '.' || selectedPath === './' ? null : selectedPath
    if (rawPath && !resolveSafePath(deps.projectPath, rawPath)) {
      res.status(400).json({ error: 'path traversal not allowed' })
      return
    }
    if (rawPath && isDeniedRelPath(rawPath)) {
      res.status(403).json({ error: 'path is excluded by the code-explorer deny-list' })
      return
    }
    const prefix = rawPath ? normalizeRel(rawPath).replace(/^\.\//, '') : ''
    const caseSensitive = req.query.caseSensitive === 'true' || req.query.caseSensitive === '1'
    const needle = caseSensitive ? query : query.toLowerCase()
    const limit = Math.min(parsePositiveInt(req.query.limit) ?? 30, 100)
    let scan: TreeScanResult
    if (prefix) {
      // Narrowing must narrow the walk itself. Filtering an already truncated
      // full-tree cache would make later subfolders impossible to discover.
      try {
        const stat = await fs.promises.stat(path.join(deps.projectPath, prefix))
        if (stat.isDirectory()) scan = (await getAllEntriesCached(prefix)).scan
        else if (stat.isFile()) scan = { entries: [{ rel: prefix, isDir: false, size: stat.size, mtime: stat.mtimeMs }], truncated: false, reason: null, visited: 1, durationMs: 0, maxEntries: 1, maxDurationMs: DEFAULT_TREE_SCAN_MS }
        else { res.status(400).json({ error: 'search path is not a regular file or directory' }); return }
      } catch (err) {
        res.status((err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500).json({ error: 'search path is unavailable' })
        return
      }
    } else scan = (await getAllEntriesCached()).scan
    const candidates = scan.entries.filter((entry) => !entry.isDir && (!prefix || entry.rel === prefix || entry.rel.startsWith(`${prefix}/`)))
    const maxFiles = Math.min(positiveEnvInt('SPECRAILS_CODE_SEARCH_MAX_FILES', MAX_SEARCH_FILES), MAX_SEARCH_FILES)
    const maxBytes = Math.min(positiveEnvInt('SPECRAILS_CODE_SEARCH_MAX_BYTES', MAX_SEARCH_BYTES), MAX_SEARCH_BYTES)
    const maxMs = Math.min(positiveEnvInt('SPECRAILS_CODE_SEARCH_MAX_MS', MAX_SEARCH_MS), MAX_SEARCH_MS)
    const started = Date.now()
    const matches: Array<{ path: string; lineNumber: number; column: number; snippet: string; snippetTruncated: boolean; fileHash: string }> = []
    const reasons = new Set<string>(scan.reason ? [`tree-${scan.reason}`] : [])
    const skipped = { binary: 0, tooLarge: 0, unreadable: 0, excluded: 0 }
    let scannedFiles = 0
    let bytesRead = 0
    // The tree is cached. Revalidate ignore rules for this request so adding a
    // .gitignore cannot leak newly excluded content during the cache TTL.
    const ignored = await gitIgnoredSet(deps.projectPath, candidates.slice(0, maxFiles).map((entry) => entry.rel), maxMs)
    search: for (const entry of candidates) {
      if (Date.now() - started >= maxMs) { reasons.add('time-limit'); break }
      if (scannedFiles >= maxFiles) { reasons.add('file-limit'); break }
      if (bytesRead >= maxBytes) { reasons.add('byte-limit'); break }
      scannedFiles++
      const abs = resolveSafePath(deps.projectPath, entry.rel)
      if (!abs || isDeniedRelPath(entry.rel) || ignored.has(entry.rel)) { skipped.excluded++; continue }
      try {
        const data = await readBoundedSource(abs, Math.min(MAX_FILE_BYTES, maxBytes - bytesRead))
        if (data === 'too-large') { skipped.tooLarge++; reasons.add('oversized-or-changing-files'); continue }
        if (data === 'not-file') { skipped.unreadable++; reasons.add('unreadable-files'); continue }
        bytesRead += data.length
        if (data.includes(0)) { skipped.binary++; continue }
        const lines = data.toString('utf8').split('\n')
        let hash: string | null = null
        for (let index = 0; index < lines.length; index++) {
          if (index % 128 === 0 && Date.now() - started >= maxMs) { reasons.add('time-limit'); break search }
          const line = lines[index].replace(/\r$/, '')
          const position = (caseSensitive ? line : line.toLowerCase()).indexOf(needle)
          if (position < 0) continue
          if (matches.length >= limit) { reasons.add('match-limit'); break search }
          const from = Math.max(0, position - 80)
          const to = Math.min(line.length, from + 320)
          hash ??= createHash('sha256').update(data).digest('hex')
          matches.push({ path: entry.rel, lineNumber: index + 1, column: position + 1, snippet: line.slice(from, to), snippetTruncated: from > 0 || to < line.length, fileHash: hash })
        }
      } catch { skipped.unreadable++; reasons.add('unreadable-files') }
    }
    const truncated = reasons.size > 0
    res.json({
      query, path: prefix || null, caseSensitive, matches, truncated,
      truncationReasons: [...reasons],
      scan: { candidateFiles: candidates.length, scannedFiles, bytesRead, durationMs: Date.now() - started, maxFiles, maxBytes, maxDurationMs: maxMs, skipped, treeTruncated: scan.truncated },
      hint: truncated
        ? 'Partial search: absence of a match is not proof of absence. Narrow path/query and retry; use read_file at a returned line with its fileHash as expectedHash.'
        : 'Search complete for eligible text files; binary, denied and gitignored paths are excluded. Use read_file at a matching line.',
    })
  })

  router.get('/file', async (req: Request, res: Response) => {
    const relRaw = req.query.path as string | undefined
    if (!relRaw || typeof relRaw !== 'string') {
      res.status(400).json({ error: 'path query parameter is required' })
      return
    }

    const guard = resolveSafePath(deps.projectPath, relRaw)
    if (!guard) {
      res.status(400).json({ error: 'path traversal not allowed' })
      return
    }
    if (isDeniedRelPath(relRaw)) {
      res.status(403).json({ error: 'path is excluded by the code-explorer deny-list' })
      return
    }
    // Canonical POSIX form for all summary/provenance/hash lookups.
    const rel = normalizeRel(relRaw)
    if (await isGitIgnored(deps.projectPath, rel)) {
      res.status(403).json({ error: 'path is gitignored' })
      return
    }
    const abs = guard

    // The editor keeps its existing full-preview contract. MCP callers always
    // supply a range, which avoids spending a model context on a 2 MB response.
    const ranged = req.query.startLine !== undefined || req.query.endLine !== undefined || req.query.startColumn !== undefined
    if (ranged) {
      const startLine = req.query.startLine === undefined ? 1 : parsePositiveInt(req.query.startLine)
      const endLine = req.query.endLine === undefined && startLine !== null ? startLine + 199 : parsePositiveInt(req.query.endLine)
      const startColumn = req.query.startColumn === undefined ? 1 : parsePositiveInt(req.query.startColumn)
      if (startLine === null || endLine === null || startColumn === null || endLine < startLine) {
        res.status(400).json({ error: 'invalid line range; startLine/endLine/startColumn must be positive integers' })
        return
      }
      const expectedHash = parseNonEmptyString(req.query.expectedHash)
      if (expectedHash && !/^[a-f0-9]{64}$/i.test(expectedHash)) {
        res.status(400).json({ error: 'expectedHash must be a SHA-256 file hash' })
        return
      }
      let bytes: Buffer | 'too-large' | 'not-file'
      try { bytes = await readBoundedSource(abs, MAX_FILE_BYTES) } catch (err) {
        res.status((err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500).json({ error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : 'failed to read file' })
        return
      }
      if (bytes === 'too-large') { res.status(413).json({ error: 'file exceeds the 2 MB read limit or changed while reading; use a narrower code search' }); return }
      if (bytes === 'not-file') { res.status(400).json({ error: 'path is not a regular file' }); return }
      if (bytes.includes(0)) { res.status(415).json({ error: 'binary file is not readable as source text' }); return }
      const fileHash = createHash('sha256').update(bytes).digest('hex')
      if (expectedHash && expectedHash.toLowerCase() !== fileHash) {
        res.status(409).json({ error: 'file_changed', fileHash, detail: 'The file changed since the previous page/search. Restart the read using the current hash.' })
        return
      }
      const lines = bytes.toString('utf8').split('\n')
      if (startLine > lines.length || startColumn > lines[startLine - 1].length + 1) {
        res.status(416).json({ error: 'range_out_of_bounds', totalLines: lines.length, fileHash })
        return
      }
      const lastLine = Math.min(endLine, startLine + MAX_CODE_PAGE_LINES - 1, lines.length)
      let content = ''
      let actualEndLine = startLine
      let nextLine: number | null = lastLine < lines.length ? lastLine + 1 : null
      let nextColumn: number | null = nextLine === null ? null : 1
      let reason: string | null = nextLine === null ? null : 'line-limit'
      for (let lineNumber = startLine; lineNumber <= lastLine; lineNumber++) {
        const column = lineNumber === startLine ? startColumn : 1
        const line = lines[lineNumber - 1].slice(column - 1)
        const remaining = MAX_CODE_PAGE_CHARS - content.length
        actualEndLine = lineNumber
        if (line.length > remaining) {
          content += line.slice(0, remaining)
          nextLine = lineNumber
          nextColumn = column + remaining
          reason = 'character-limit'
          break
        }
        content += line
        if (content.length >= MAX_CODE_PAGE_CHARS && lineNumber < lastLine) {
          nextLine = lineNumber + 1
          nextColumn = 1
          reason = 'character-limit'
          break
        }
        if (lineNumber < lastLine) content += '\n'
      }
      res.json({ path: rel, content, encoding: 'utf-8', language: languageForExt(path.extname(rel)), fileHash, sizeBytes: bytes.length, startLine, startColumn, endLine: actualEndLine, totalLines: lines.length, nextLine, nextColumn, truncated: nextLine !== null, truncationReason: reason })
      return
    }

    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      // Honour the staleness scenario: even if content is unavailable, return
      // the existing summary so the client can render a "not found" banner.
      const summary = readSummary(summaryRoot(), rel)
      const provenance = listByPath(deps.db, deps.projectId, rel)
      if (summary || provenance.length > 0) {
        res.json({
          content: null,
          reason: 'not-found',
          summary,
          summaryStale: true,
          provenance: provenanceRowsToJson(provenance),
        })
        return
      }
      res.status(404).json({ error: 'file not found' })
      return
    }
    if (!stat.isFile()) {
      res.status(400).json({ error: 'path is not a regular file' })
      return
    }

    if (stat.size > MAX_FILE_BYTES) {
      res.json({
        tooLarge: true,
        sizeBytes: stat.size,
        provenance: provenanceRowsToJson(listByPath(deps.db, deps.projectId, rel)),
        summary: readSummary(summaryRoot(), rel),
        absolutePath: abs,
      })
      return
    }

    // Binary detection: read first 8 KB, scan for NUL.
    let head: Buffer
    try {
      const fd = fs.openSync(abs, 'r')
      try {
        head = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, stat.size))
        fs.readSync(fd, head, 0, head.length, 0)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      res.status(500).json({ error: 'failed to read file' })
      return
    }
    if (head.includes(0)) {
      res.json({
        binary: true,
        sizeBytes: stat.size,
        mime: 'application/octet-stream',
        provenance: provenanceRowsToJson(listByPath(deps.db, deps.projectId, rel)),
        summary: readSummary(summaryRoot(), rel),
        absolutePath: abs,
      })
      return
    }

    let content: string
    try {
      content = fs.readFileSync(abs, 'utf8')
    } catch {
      res.status(500).json({ error: 'failed to read file' })
      return
    }

    const summary = readSummary(summaryRoot(), rel)
    const summaryStale = await computeStaleness(abs, summary)
    res.json({
      content,
      encoding: 'utf-8',
      language: languageForExt(path.extname(rel)),
      provenance: provenanceRowsToJson(listByPath(deps.db, deps.projectId, rel)),
      summary,
      summaryStale,
      absolutePath: abs,
    })
  })

  // In-app editing (v1): overwrite an existing text file with new content.
  // Same guards as the read path — traversal, deny-list, gitignore, size, and
  // binary refusal — so the editor can never write outside the tree, clobber a
  // secret/lockfile, or corrupt a binary. Creating new files / renames is out of
  // scope here. After a write the existing hash-gated `summaryStale` flag makes
  // the next GET /file surface the summary as stale (regenerate via the existing
  // POST /file/regenerate-summary).
  router.put('/file', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { path?: unknown; content?: unknown }
    const relRaw = typeof body.path === 'string' ? body.path : undefined
    const content = typeof body.content === 'string' ? body.content : undefined
    if (!relRaw || content === undefined) {
      res.status(400).json({ error: 'path and content are required' })
      return
    }
    const guard = resolveSafePath(deps.projectPath, relRaw)
    if (!guard) {
      res.status(400).json({ error: 'path traversal not allowed' })
      return
    }
    if (isDeniedRelPath(relRaw)) {
      res.status(403).json({ error: 'path is excluded by the code-explorer deny-list' })
      return
    }
    const rel = normalizeRel(relRaw)
    if (await isGitIgnored(deps.projectPath, rel)) {
      res.status(403).json({ error: 'path is gitignored' })
      return
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      res.status(413).json({ error: 'file too large' })
      return
    }
    if (/[\x00-\x08\x0e-\x1f]/.test(content)) {
      res.status(415).json({ error: 'binary content not allowed' })
      return
    }
    const abs = guard
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      res.status(404).json({ error: 'file not found (in-app editing only overwrites existing files)' })
      return
    }
    if (!stat.isFile()) {
      res.status(400).json({ error: 'path is not a regular file' })
      return
    }
    // Refuse to overwrite a binary file as text (would corrupt it).
    try {
      const fd = fs.openSync(abs, 'r')
      try {
        const head = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, stat.size))
        fs.readSync(fd, head, 0, head.length, 0)
        if (head.includes(0)) {
          res.status(415).json({ error: 'cannot edit a binary file' })
          return
        }
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      res.status(500).json({ error: 'failed to read file' })
      return
    }
    try {
      fs.writeFileSync(abs, content, 'utf8')
    } catch {
      res.status(500).json({ error: 'failed to write file' })
      return
    }
    res.json({ ok: true, bytes: Buffer.byteLength(content, 'utf8'), path: rel })
  })

  router.get('/summary', async (req: Request, res: Response) => {
    const relRaw = req.query.path as string | undefined
    if (!relRaw || typeof relRaw !== 'string') {
      res.status(400).json({ error: 'path query parameter is required' })
      return
    }
    const guard = resolveSafePath(deps.projectPath, relRaw)
    if (!guard) {
      res.status(400).json({ error: 'path traversal not allowed' })
      return
    }
    if (isDeniedRelPath(relRaw)) {
      res.status(403).json({ error: 'path is excluded by the code-explorer deny-list' })
      return
    }
    const rel = normalizeRel(relRaw)
    if (await isGitIgnored(deps.projectPath, rel)) {
      res.status(403).json({ error: 'path is gitignored' })
      return
    }
    const summary = readSummary(summaryRoot(), rel)
    if (!summary) {
      res.json({ summary: null })
      return
    }
    let summaryStale = false
    try {
      summaryStale = await computeStaleness(guard, summary)
    } catch {
      summaryStale = true
    }
    res.json({ summary, summaryStale })
  })

  // Construction story: the chronological list of interventions (specs/jobs)
  // that built this file — provenance rows enriched with diff stats, the AI
  // contribution paragraph when generated, and the spec's live title/status.
  // Same guards as every sibling content endpoint. Works for deleted files too
  // (their story is still worth telling), so no stat/existence requirement.
  router.get('/file/story', async (req: Request, res: Response) => {
    const relRaw = req.query.path as string | undefined
    if (!relRaw || typeof relRaw !== 'string') {
      res.status(400).json({ error: 'path query parameter is required' })
      return
    }
    const guard = resolveSafePath(deps.projectPath, relRaw)
    if (!guard) {
      res.status(400).json({ error: 'path traversal not allowed' })
      return
    }
    if (isDeniedRelPath(relRaw)) {
      res.status(403).json({ error: 'path is excluded by the code-explorer deny-list' })
      return
    }
    const rel = normalizeRel(relRaw)
    if (await isGitIgnored(deps.projectPath, rel)) {
      res.status(403).json({ error: 'path is gitignored' })
      return
    }
    res.json({ path: rel, story: getFileStory(deps.db, rel, deps.getTicketSpec) })
  })

  // Construction story: generate (budget-gated) the plain-language "what this
  // spec contributed" paragraph for ONE intervention. Awaits the single model
  // turn; the file.story_updated WS event fires too so other open viewers of
  // the same file refresh.
  router.post('/file/story/explain', async (req: Request, res: Response) => {
    if (!requireAiTransforms(res)) return
    const relRaw = req.query.path as string | undefined
    if (!relRaw || typeof relRaw !== 'string') {
      res.status(400).json({ error: 'path query parameter is required' })
      return
    }
    const guard = resolveSafePath(deps.projectPath, relRaw)
    if (!guard) {
      res.status(400).json({ error: 'path traversal not allowed' })
      return
    }
    if (isDeniedRelPath(relRaw)) {
      res.status(403).json({ error: 'path is excluded by the code-explorer deny-list' })
      return
    }
    const rel = normalizeRel(relRaw)
    if (await isGitIgnored(deps.projectPath, rel)) {
      res.status(403).json({ error: 'path is gitignored' })
      return
    }
    if (!deps.fileStoryManager) {
      res.status(404).json({ error: 'story generation not available' })
      return
    }
    const body = (req.body ?? {}) as { provenanceId?: unknown; overrideBudget?: unknown }
    const provenanceId = typeof body.provenanceId === 'number' && Number.isInteger(body.provenanceId) && body.provenanceId > 0
      ? body.provenanceId
      : null
    if (provenanceId == null) {
      res.status(400).json({ error: 'provenanceId (positive integer) is required' })
      return
    }
    try {
      const result = await deps.fileStoryManager.explain({
        projectId: deps.projectId,
        relPath: rel,
        provenanceId,
        overrideBudget: body.overrideBudget === true,
      })
      if (result === 'generated') {
        res.json({ ok: true })
        return
      }
      if (result === 'skipped:budget') {
        // 200 (not 4xx) so the client's budget-override prompt is reachable
        // (mirrors /file/regenerate-summary).
        res.status(200).json({ skipped: 'budget' })
        return
      }
      if (result === 'skipped:not-found') {
        res.status(404).json({ error: 'intervention not found for this file' })
        return
      }
      res.status(500).json({ error: 'story generation failed' })
    } catch (err) {
      console.error('[code-explorer-router] story explain failed:', err)
      res.status(500).json({ error: 'story generation failed', message: (err as Error).message })
    }
  })

  router.post('/file/regenerate-summary', async (req: Request, res: Response) => {
    if (!requireAiTransforms(res)) return
    const relRaw = req.query.path as string | undefined
    if (!relRaw || typeof relRaw !== 'string') {
      res.status(400).json({ error: 'path query parameter is required' })
      return
    }
    const guard = resolveSafePath(deps.projectPath, relRaw)
    if (!guard) {
      res.status(400).json({ error: 'path traversal not allowed' })
      return
    }
    if (isDeniedRelPath(relRaw)) {
      res.status(403).json({ error: 'path is excluded by the code-explorer deny-list' })
      return
    }
    const rel = normalizeRel(relRaw)
    if (await isGitIgnored(deps.projectPath, rel)) {
      res.status(403).json({ error: 'path is gitignored' })
      return
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(guard)
    } catch {
      res.status(404).json({ skipped: 'not-found' })
      return
    }
    if (!stat.isFile()) {
      res.status(400).json({ skipped: 'not-file' })
      return
    }
    if (stat.size > MAX_FILE_BYTES) {
      res.status(413).json({ skipped: 'too-large' })
      return
    }
    try {
      const fd = fs.openSync(guard, 'r')
      try {
        const head = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, stat.size))
        fs.readSync(fd, head, 0, head.length, 0)
        if (head.includes(0)) {
          res.status(415).json({ skipped: 'binary' })
          return
        }
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      res.status(500).json({ error: 'failed to inspect file' })
      return
    }
    const body = (req.body ?? {}) as { overrideBudget?: boolean }
    try {
      // force: true — an explicit "Regenerate" click should re-summarise even if
      // the content hash is unchanged (e.g. after an app language switch).
      const result = await deps.fileSummaryManager.enqueue({
        projectPath: deps.projectPath,
        summaryRoot: summaryRoot(),
        projectId: deps.projectId,
        projectSlug: deps.projectId,
        relPath: rel,
        triggeredBy: { kind: 'user', id: 'manual', ticketId: null },
        overrideBudget: body.overrideBudget === true,
        force: true,
      })
      // Surface the enqueue outcome so the client's budget-override prompt is
      // reachable. 200 (not 4xx) keeps res.ok true so the client reads `skipped`.
      if (result === 'skipped:budget') {
        res.status(200).json({ skipped: 'budget' })
        return
      }
      if (result === 'skipped:per-job-cap') {
        res.status(200).json({ skipped: 'per-job-cap' })
        return
      }
      // TTL-dropped (queue saturated >5min) and not-found (file vanished between
      // the stat above and the worker) must NOT masquerade as a 202 success —
      // surface them so the client toasts "try again" instead of silently
      // clearing the spinner with no summary.
      if (result === 'skipped:ttl') {
        res.status(200).json({ skipped: 'ttl' })
        return
      }
      if (result === 'skipped:not-found') {
        res.status(200).json({ skipped: 'not-found' })
        return
      }
      if (result === 'failed') {
        res.status(500).json({ error: 'summary generation failed' })
        return
      }
      res.status(202).json({ enqueued: true })
    } catch (err) {
      console.error('[code-explorer-router] enqueue failed:', err)
      res.status(500).json({ error: 'enqueue failed', message: (err as Error).message })
    }
  })

  router.get('/provenance', async (req: Request, res: Response) => {
    const ticketId = parsePositiveInt(req.query.ticketId)
    const jobId = parseNonEmptyString(req.query.jobId)
    const relPath = parseNonEmptyString(req.query.path)
    if (relPath) {
      const guard = resolveSafePath(deps.projectPath, relPath)
      if (!guard) {
        res.status(400).json({ error: 'path traversal not allowed' })
        return
      }
      // Mirror the content endpoints: never leak even the metadata (which ticket/
      // job touched it, when) of a denied/secret file.
      if (isDeniedRelPath(relPath)) {
        res.status(403).json({ error: 'path is excluded by the code-explorer deny-list' })
        return
      }
    }
    if (ticketId == null && !jobId && !relPath) {
      res.status(400).json({ error: 'ticketId, jobId, or path query parameter is required' })
      return
    }
    if (req.query.ticketId != null && ticketId == null) {
      res.status(400).json({ error: 'ticketId must be a positive integer' })
      return
    }
    const rows = ticketId != null && !jobId && !relPath
      ? listByTicket(deps.db, deps.projectId, ticketId)
      : listTouchedRows(deps.db, { ticketId, jobId, path: relPath ? normalizeRel(relPath) : relPath })
    res.json(
      provenanceRowsToJson(rows),
    )
  })

  router.get('/diff', async (req: Request, res: Response) => {
    const jobId = parseNonEmptyString(req.query.jobId)
    const relPath = parseNonEmptyString(req.query.path)
    if (!jobId || !relPath) {
      res.status(400).json({ error: 'jobId and path query parameters are required' })
      return
    }
    const guard = resolveSafePath(deps.projectPath, relPath)
    if (!guard) {
      res.status(400).json({ error: 'path traversal not allowed' })
      return
    }
    // Mirror every sibling content endpoint (/file, /summary, /provenance):
    // a stored patch for an added file contains the FULL file contents, so a
    // denied/gitignored secret (.env, *.pem, id_rsa, gitignored creds) that an
    // AI job happened to touch must never be served verbatim through /diff.
    if (isDeniedRelPath(relPath)) {
      res.status(403).json({ error: 'path is excluded by the code-explorer deny-list' })
      return
    }
    const rel = normalizeRel(relPath)
    if (await isGitIgnored(deps.projectPath, rel)) {
      res.status(403).json({ error: 'path is gitignored' })
      return
    }
    const diff = getProvenanceDiff(deps.db, deps.projectId, jobId, rel)
    if (!diff) {
      res.status(404).json({ error: 'diff not available' })
      return
    }
    res.json(diff)
  })

  return router
}

function resolveSafePath(projectPath: string, relPath: string): string | null {
  // Reject absolute paths and any path with explicit traversal segments before
  // we ever hit the filesystem. resolve() can collapse `..` legally so we still
  // verify the prefix below.
  if (path.isAbsolute(relPath)) return null
  const resolved = path.resolve(projectPath, relPath)
  const root = projectPath.endsWith(path.sep) ? projectPath : projectPath + path.sep
  if (resolved !== projectPath && !resolved.startsWith(root)) return null

  // Symlink hardening: the lexical check above is defeated by an in-tree symlink
  // whose target escapes the project (e.g. `link -> /etc/passwd`). Verify the
  // REAL path stays under the REAL project root. Walk up to the nearest existing
  // ancestor (so not-yet-created paths — used by the not-found banner and the
  // regenerate endpoint — still validate), realpath it, then re-append the
  // missing suffix.
  let realRoot: string
  try {
    realRoot = fs.realpathSync.native(projectPath)
  } catch {
    // Project root itself is uncanonicalisable — fail CLOSED. Returning the
    // lexical path here would silently drop the symlink-escape hardening (the
    // lexical check alone is defeatable by an in-tree symlink pointing outside
    // the project). Reading any file is pointless if the root can't resolve.
    return null
  }
  const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
  let probe = resolved
  const suffix: string[] = []
  for (;;) {
    try {
      const realProbe = fs.realpathSync.native(probe)
      const realFull = suffix.length > 0
        ? path.join(realProbe, ...suffix.slice().reverse())
        : realProbe
      if (realFull !== realRoot && !realFull.startsWith(realRootWithSep)) return null
      return resolved
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null
      const parent = path.dirname(probe)
      if (parent === probe) return null // hit filesystem root without resolving
      suffix.push(path.basename(probe))
      probe = parent
    }
  }
}

async function computeStaleness(abs: string, summary: SummaryPayload | null): Promise<boolean> {
  if (!summary) return false
  try {
    const currentHash = await computeFileHash(abs)
    return currentHash !== summary.fileHash
  } catch {
    return true
  }
}
