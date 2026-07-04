import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
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

declare module 'express-serve-static-core' {
  interface Request {
    projectCtx?: import('./project-registry').ProjectContext
  }
}

const MAX_TREE_PAGE = 2000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const BINARY_PROBE_BYTES = 8 * 1024

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
  return rel.split(/[\\/]/).filter(Boolean).some(isDenied)
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
function gitIgnoredSet(projectPath: string, relPaths: string[]): Set<string> {
  if (relPaths.length === 0) return new Set()
  let out = ''
  try {
    out = execFileSync('git', ['check-ignore', '--stdin', '-z'], {
      cwd: projectPath,
      input: relPaths.join('\0') + '\0',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15_000,
    })
  } catch (err) {
    out = ((err as { stdout?: string | Buffer }).stdout ?? '').toString()
  }
  return new Set(out.split('\0').filter((p) => p.length > 0))
}

function isGitIgnored(projectPath: string, relPath: string): boolean {
  return gitIgnoredSet(projectPath, [relPath]).has(relPath)
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

function listAllEntries(projectPath: string): Array<{ rel: string; isDir: boolean; size: number | null; mtime: number | null }> {
  const out: Array<{ rel: string; isDir: boolean; size: number | null; mtime: number | null }> = []
  const stack: string[] = [projectPath]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
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
          const st = fs.statSync(abs)
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
  const ignored = gitIgnoredSet(projectPath, files)
  const filtered = ignored.size > 0 ? out.filter((e) => e.isDir || !ignored.has(e.rel)) : out
  filtered.sort((a, b) => a.rel.localeCompare(b.rel))
  return filtered
}

function listTouchedEntries(
  projectPath: string,
  rowsByPath: Map<string, ProvenanceRow[]>,
): Array<{ rel: string; isDir: boolean; size: number | null; mtime: number | null }> {
  const seen = new Set<string>()
  const out: Array<{ rel: string; isDir: boolean; size: number | null; mtime: number | null }> = []

  // Drop gitignored files too — mirroring listAllEntries — so a gitignored
  // AI-touched file (e.g. config.local.json, a custom build dir) whose name is
  // not deny-listed never surfaces its path / ticket-attribution / mtime. One
  // batched git check-ignore over the not-already-denied touched files.
  const candidateFiles = [...rowsByPath.keys()].filter((p) => !isDeniedRelPath(p))
  const ignored = gitIgnoredSet(projectPath, candidateFiles)

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
}

export function createCodeExplorerRouter(deps: CodeExplorerDeps): Router {
  const router = Router({ mergeParams: true })

  const listByPath = deps.listProvenanceByPath ?? listProvenanceByPath
  const listByTicket = deps.listProvenanceByTicket ?? listProvenanceByTicket
  // Summary OUTPUT root (workspace when relocated). Source reads use projectPath.
  const summaryRoot = (): string => deps.resolveSummaryRoot?.() ?? deps.projectPath

  // Short-TTL per-project cache so paginating a large `all` tree reuses ONE
  // synchronous filesystem walk instead of re-walking (and re-statting) on every
  // page — the cursor only slices an already-materialized array. Also caches the
  // one-readdir summary-hash set. 5s is long enough for a pagination burst and
  // short enough that tree edits surface promptly.
  const WALK_CACHE_TTL_MS = 5000
  let allEntriesCache: { at: number; entries: ReturnType<typeof listAllEntries> } | null = null
  let summaryHashCache: { at: number; set: Set<string> } | null = null
  const nowMs = () => Date.now()
  function getAllEntriesCached(): ReturnType<typeof listAllEntries> {
    if (allEntriesCache && nowMs() - allEntriesCache.at < WALK_CACHE_TTL_MS) return allEntriesCache.entries
    const entries = listAllEntries(deps.projectPath)
    allEntriesCache = { at: nowMs(), entries }
    return entries
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
    // Lazily attach the file-summary watcher on first Code-Explorer use. It is
    // not attached at registry load (that recursive watcher caused the fd leak
    // that broke terminals); attachWatcher is idempotent, so this is cheap on
    // every subsequent request.
    try { deps.fileSummaryManager.attachWatcher(deps.projectId, deps.projectPath, summaryRoot()) } catch { /* non-fatal */ }
    next()
  })

  router.get('/tree', (req: Request, res: Response) => {
    const filter = (req.query.filter as string | undefined) ?? 'touched-by-ai'
    const withProvenance = req.query.withProvenance === '1' || req.query.withProvenance === 'true'
    const { skip } = decodeCursor(req.query.cursor as string | undefined)
    const ticketId = parsePositiveInt(req.query.ticketId)
    const jobId = parseNonEmptyString(req.query.jobId)

    let entries: Array<{ rel: string; isDir: boolean; size: number | null; mtime: number | null }>
    const touchedRowsByPath = new Map<string, ProvenanceRow[]>()
    if (filter === 'touched-by-ai') {
      const rows = listTouchedRows(deps.db, { ticketId, jobId })
      for (const row of rows) {
        const existing = touchedRowsByPath.get(row.file_path)
        if (existing) existing.push(row)
        else touchedRowsByPath.set(row.file_path, [row])
      }
      entries = listTouchedEntries(deps.projectPath, touchedRowsByPath)
    } else {
      entries = getAllEntriesCached()
      // Batch-load ALL provenance once instead of a per-entry SQL query (N+1).
      if (withProvenance) {
        for (const row of listTouchedRows(deps.db, {})) {
          const existing = touchedRowsByPath.get(row.file_path)
          if (existing) existing.push(row)
          else touchedRowsByPath.set(row.file_path, [row])
        }
      }
    }

    const page = entries.slice(skip, skip + MAX_TREE_PAGE)
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
    if (isGitIgnored(deps.projectPath, rel)) {
      res.status(403).json({ error: 'path is gitignored' })
      return
    }
    const abs = guard

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
  router.put('/file', (req: Request, res: Response) => {
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
    if (isGitIgnored(deps.projectPath, rel)) {
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
    if (isGitIgnored(deps.projectPath, rel)) {
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
  router.get('/file/story', (req: Request, res: Response) => {
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
    if (isGitIgnored(deps.projectPath, rel)) {
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
    if (isGitIgnored(deps.projectPath, rel)) {
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
    if (isGitIgnored(deps.projectPath, rel)) {
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

  router.get('/provenance', (req: Request, res: Response) => {
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

  router.get('/diff', (req: Request, res: Response) => {
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
    if (isGitIgnored(deps.projectPath, rel)) {
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
