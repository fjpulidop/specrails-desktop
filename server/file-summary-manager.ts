import { createHash, randomUUID, randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import { isInBuildDir } from './build-dirs'
import type { DbInstance } from './db'
import type {
  WsMessage,
  FileSummaryUpdatedMessage,
  FileSummaryFailedMessage,
  FileSummarySkippedMessage,
} from './types'
import { recordInvocation, type Surface } from './ai-invocations'

export type SummaryLanguage = 'en' | 'es'

export interface SummaryPayload {
  schemaVersion: 1
  path: string
  fileHash: string
  summary: string
  language: SummaryLanguage
  generatedAt: string
  generatedBy: { model: string; promptVersion: number; truncated?: boolean }
  triggeredBy: { kind: 'job' | 'user'; id: string; ticketId: number | null }
}

export interface EnqueueRequest {
  /** The user's repo. Source files are ALWAYS read from here (never the
   *  workspace) — Code Explorer reads the real code. */
  projectPath: string
  /** Relocate-artifacts: where summary JSON OUTPUTS are written/read. Workspace
   *  when relocated, else === projectPath (legacy, byte-identical). Defaults to
   *  `projectPath` when omitted. The `.gitignore` append is a no-op when this
   *  differs from `projectPath` (the workspace `.gitignore` is app-owned). */
  summaryRoot?: string
  projectId: string
  projectSlug: string
  relPath: string
  triggeredBy: SummaryPayload['triggeredBy']
  jobId?: string
  overrideBudget?: boolean
  /** Bypass the content-hash gate. Set on explicit user "Regenerate" so an
   *  unchanged file is re-summarised anyway (e.g. after a language switch). */
  force?: boolean
}

export interface GenerateInput {
  relPath: string
  contents: string
  truncated: boolean
  language: SummaryLanguage
}

export interface GenerateOutput {
  summary: string
  model: string
  /** Provider id ('claude' | 'codex' | ...). Stamped onto the ai_invocations row. */
  provider: string
  costUsd: number
  /** True when costUsd came from the pricing-table fallback (non-native-cost provider). */
  costEstimated?: boolean
  tokensIn: number
  tokensOut: number
  tokensCacheRead?: number
  tokensCacheCreate?: number
  durationMs: number
}

export interface FileSummaryDeps {
  db: DbInstance
  broadcast: (msg: WsMessage) => void
  /** Generate a summary. The optional AbortSignal lets the manager tear down an
   *  in-flight provider child when the project is removed / the app shuts down. */
  generate: (input: GenerateInput, signal?: AbortSignal) => Promise<GenerateOutput>
  monthToDateSpend: (projectId: string) => number
  monthlyBudgetUsd: () => number
  /** App-wide summary language. Defaults to 'en' when omitted. */
  language?: () => SummaryLanguage
  /** Provider id for the project ('claude' | 'codex' | …). Used to attribute the
   *  failure-path ai_invocations row correctly. Defaults to 'claude'. */
  providerId?: () => string
  now?: () => number
}

export interface FileSummaryOpts {
  perProjectConcurrency?: number
  desktopConcurrency?: number
  perJobCap?: number
  queueTtlMs?: number
  /** Upper bound on distinct jobId counters retained (defensive anti-leak). */
  maxJobCounters?: number
}

type EnqueueResult =
  | 'enqueued'
  | 'failed'
  | 'skipped:hash'
  | 'skipped:budget'
  | 'skipped:per-job-cap'
  | 'skipped:ttl'
  | 'skipped:not-found'

const SUMMARIES_REL = path.join('.specrails', 'file-summaries')
// Current summary prompt version. Bump when buildSystemPrompt changes materially
// so existing summaries are treated as stale and regenerated on next request.
const CURRENT_PROMPT_VERSION = 1
// Defensive bound on the per-job counter map so it cannot grow without limit
// across a long-lived app session (the per-job cap is best-effort).
const MAX_JOB_COUNTERS = 2000
const TOKEN_CHARS_PER_TOKEN = 4
const TOKEN_LIMIT = 8000
const TRUNCATE_HEAD_CHARS = 16000
const TRUNCATE_TAIL_CHARS = 8000
const TRUNCATE_MARKER = '\n// … truncated … //\n'

export function summariesDir(projectPath: string): string {
  return path.join(projectPath, SUMMARIES_REL)
}

export function pathHash(relPath: string): string {
  return createHash('sha256').update(Buffer.from(relPath, 'utf8')).digest('hex')
}

export function summaryFilePath(projectPath: string, relPath: string): string {
  return path.join(summariesDir(projectPath), `${pathHash(relPath)}.json`)
}

export async function computeFileHash(absolutePath: string): Promise<string> {
  // Use streaming hash so very large files do not balloon memory.
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(absolutePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export function readSummary(projectPath: string, relPath: string): SummaryPayload | null {
  const file = summaryFilePath(projectPath, relPath)
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return JSON.parse(raw) as SummaryPayload
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null
  }
}

export function writeSummary(
  summaryRoot: string,
  relPath: string,
  payload: SummaryPayload,
  /** When false (relocated: summaryRoot is the app-owned workspace), skip the
   *  `.gitignore` append — the workspace `.gitignore` is not the user's repo. */
  appendGitignore = true,
): void {
  const dir = summariesDir(summaryRoot)
  const firstWrite = !fs.existsSync(dir)
  fs.mkdirSync(dir, { recursive: true })
  const final = summaryFilePath(summaryRoot, relPath)
  // Atomic write: temp file in the same directory, then rename.
  const tmp = `${final}.tmp.${randomBytes(6).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, final)
  if (firstWrite && appendGitignore) {
    // The app appends `.specrails/file-summaries/` to the project `.gitignore`
    // on first write. Idempotent: only appends when the line is absent.
    try { ensureGitignoreLine(summaryRoot, '.specrails/file-summaries/') } catch { /* non-fatal */ }
  }
}

export function ensureGitignoreLine(projectPath: string, line: string): boolean {
  const gi = path.join(projectPath, '.gitignore')
  let existing = ''
  try { existing = fs.readFileSync(gi, 'utf8') } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const hasLine = existing.split(/\r?\n/).some((l) => l.trim() === line.trim())
  if (hasLine) return false
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  fs.writeFileSync(gi, `${existing}${sep}${line}\n`, 'utf8')
  return true
}

export function sweepOrphans(
  summaryRoot: string,
  cap = 200,
  /** Where to resolve source files (the repo). Relocate-artifacts: summaries
   *  live under `summaryRoot` (workspace) but source is under `sourceRoot`
   *  (repo). Defaults to `summaryRoot` (legacy, byte-identical). */
  sourceRoot?: string,
): { deleted: number; remaining: number } {
  const dir = summariesDir(summaryRoot)
  const srcRoot = sourceRoot ?? summaryRoot
  let deleted = 0
  let remaining = 0
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { deleted: 0, remaining: 0 }
    throw err
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const full = path.join(dir, entry)
    let payload: SummaryPayload
    try {
      payload = JSON.parse(fs.readFileSync(full, 'utf8')) as SummaryPayload
    } catch {
      continue
    }
    const sourceAbs = path.join(srcRoot, payload.path)
    if (fs.existsSync(sourceAbs)) continue
    if (deleted >= cap) {
      remaining += 1
      continue
    }
    try {
      fs.unlinkSync(full)
      deleted += 1
    } catch {
      // best-effort sweep
    }
  }
  return { deleted, remaining }
}

interface QueueEntry {
  req: EnqueueRequest
  enqueuedAt: number
  /** Content hash computed at enqueue time, carried on the entry so the worker
   *  never has to recompute it — and never picks up another entry's hash. */
  newHash: string
  resolve: (r: EnqueueResult) => void
  reject: (err: Error) => void
}

interface WatcherState {
  projectPath: string
  watcher: FSWatcher
}

// App-wide concurrency is shared across EVERY FileSummaryManager instance.
// Production constructs one manager per project (each with its own db/broadcast/
// generate), so a per-instance counter would only ever cap per-project. This
// module-level state makes the documented "app-wide 8" ceiling real: all live
// managers share one in-flight count, and freeing a slot re-pumps every live
// manager so a blocked project's queue advances.
const DESKTOP = {
  inFlight: 0,
  managers: new Set<FileSummaryManager>(),
}

/** Test-only: reset the shared app-wide counter/registry between unit tests so
 *  module-level state never leaks across cases. */
export function __resetDesktopSummaryStateForTests(): void {
  DESKTOP.inFlight = 0
  DESKTOP.managers.clear()
}

export class FileSummaryManager {
  private readonly deps: FileSummaryDeps
  private readonly perProjectConcurrency: number
  private readonly desktopConcurrency: number
  private readonly perJobCap: number
  private readonly queueTtlMs: number
  private readonly maxJobCounters: number

  // Per-project queue, per-project in-flight count. App-wide in-flight lives in
  // the module-level DESKTOP so it is shared across all per-project instances.
  private readonly queues = new Map<string, QueueEntry[]>()
  private readonly inFlightPerProject = new Map<string, number>()
  private readonly jobCounter = new Map<string, number>()
  private readonly watchers = new Map<string, WatcherState>()
  // Dedupe key (`projectId:relPath`) → in-flight enqueue promise. A second
  // enqueue for the same file rides the first instead of double-spawning the
  // provider and double-billing ai_invocations.
  private readonly inFlightByKey = new Map<string, Promise<EnqueueResult>>()
  // AbortControllers for in-flight generations so dispose() can tear down the
  // provider child instead of orphaning it past project removal.
  private readonly activeControllers = new Set<AbortController>()
  private _disposed = false
  // Per-project SUPERSET of relPaths that have a summary on disk. Seeded from
  // the summaries dir at attachWatcher and only ever added to (on write), so a
  // path absent from the set provably has no summary — letting the chokidar
  // 'change' handler skip the readSummary disk hit for the common no-summary
  // file. A stale entry (after sweep) just costs one harmless failed read.
  private readonly knownSummaries = new Map<string, Set<string>>()
  // Tracks pending generation promises so flush() can await them in tests.
  private readonly pending = new Set<Promise<unknown>>()

  constructor(deps: FileSummaryDeps, opts: FileSummaryOpts = {}) {
    this.deps = deps
    this.perProjectConcurrency = opts.perProjectConcurrency ?? 2
    this.desktopConcurrency = opts.desktopConcurrency ?? 8
    this.perJobCap = opts.perJobCap ?? 50
    this.queueTtlMs = opts.queueTtlMs ?? 5 * 60 * 1000
    this.maxJobCounters = opts.maxJobCounters ?? MAX_JOB_COUNTERS
    DESKTOP.managers.add(this)
  }

  // NOT async: returning the in-flight promise verbatim is what makes the dedupe
  // a true coalesce (the second caller gets the SAME promise, not a wrapper).
  enqueue(req: EnqueueRequest): Promise<EnqueueResult> {
    // Per-(project,relPath) in-flight dedupe: a second enqueue for the same file
    // while one is still running coalesces onto the first promise, so the
    // provider is spawned once and ai_invocations is billed once (fixes
    // concurrent-regenerate double-billing across tabs/clients).
    const dedupeKey = `${req.projectId}:${req.relPath}`
    const existing = this.inFlightByKey.get(dedupeKey)
    if (existing) return existing
    const p = this._enqueueInner(req)
    this.inFlightByKey.set(dedupeKey, p)
    void p.catch(() => undefined).finally(() => {
      if (this.inFlightByKey.get(dedupeKey) === p) this.inFlightByKey.delete(dedupeKey)
    })
    return p
  }

  private async _enqueueInner(req: EnqueueRequest): Promise<EnqueueResult> {
    const absolutePath = path.join(req.projectPath, req.relPath)

    // Step 1: file readability check.
    let newHash: string
    try {
      const stat = fs.statSync(absolutePath)
      if (!stat.isFile()) {
        this.emitSkipped(req, 'not-found')
        return 'skipped:not-found'
      }
      newHash = await computeFileHash(absolutePath)
    } catch {
      this.emitSkipped(req, 'not-found')
      return 'skipped:not-found'
    }

    // Step 2: hash gate. Skip regeneration only when content, language AND prompt
    // version all match — and never when the caller forced it. Without the
    // language check an app language switch (en↔es) would never refresh existing
    // summaries; without `force` an explicit "Regenerate" of an unchanged file
    // would be a silent no-op.
    const currentLang: SummaryLanguage = this.deps.language?.() ?? 'en'
    const summaryRoot = req.summaryRoot ?? req.projectPath
    const existing = readSummary(summaryRoot, req.relPath)
    if (
      !req.force &&
      existing &&
      existing.fileHash === newHash &&
      existing.language === currentLang &&
      existing.generatedBy?.promptVersion === CURRENT_PROMPT_VERSION
    ) {
      this.deps.broadcast(buildSummaryUpdated(req.projectId, existing, false))
      return 'skipped:hash'
    }

    // Step 3: per-job cap — PRE-CHECK ONLY. The counter is incremented in pump()
    // when a generation actually STARTS, so budget-skipped / TTL-dropped / failed
    // requests never consume a per-job slot (the cap counts generations, not
    // attempts). pump() re-checks the cap at start to catch the case where
    // several requests passed this pre-check before any started.
    if (req.jobId) {
      const count = this.jobCounter.get(req.jobId) ?? 0
      if (count >= this.perJobCap) {
        this.emitSkipped(req, 'per-job-cap')
        return 'skipped:per-job-cap'
      }
    }

    // Step 4: budget cap. Applies to job- AND user-triggered requests; the only
    // bypass is an explicit overrideBudget (the "Override the budget cap?"
    // confirmation in the UI). Previously only job-triggered requests were
    // gated, which left the manual-regenerate budget prompt unreachable.
    if (!req.overrideBudget) {
      const spend = this.deps.monthToDateSpend(req.projectId)
      const budget = this.deps.monthlyBudgetUsd()
      if (spend >= budget) {
        this.emitSkipped(req, 'budget')
        return 'skipped:budget'
      }
    }

    // Step 5: enqueue or run.
    const result = await new Promise<EnqueueResult>((resolve, reject) => {
      const entry: QueueEntry = {
        req: { ...req },
        enqueuedAt: (this.deps.now ?? Date.now)(),
        newHash,
        resolve,
        reject,
      }
      const queue = this.queues.get(req.projectId) ?? []
      queue.push(entry)
      this.queues.set(req.projectId, queue)
      this.pump(req.projectId)
    })
    return result
  }

  private pump(projectId: string): void {
    if (this._disposed) return
    const queue = this.queues.get(projectId) ?? []
    while (queue.length > 0) {
      if (DESKTOP.inFlight >= this.desktopConcurrency) break
      const perProject = this.inFlightPerProject.get(projectId) ?? 0
      if (perProject >= this.perProjectConcurrency) break
      const entry = queue.shift()!
      const now = (this.deps.now ?? Date.now)()
      // TTL drop before starting. Distinct 'skipped:ttl' (not 'skipped:hash') so
      // the regenerate route can tell the user it was dropped, not silently 202.
      if (now - entry.enqueuedAt > this.queueTtlMs) {
        this.emitSkipped(entry.req, 'ttl')
        entry.resolve('skipped:ttl')
        continue
      }
      // Budget re-check at dequeue: an entry that crossed the monthly cap while
      // waiting in the queue is skipped instead of spending, bounding the
      // concurrent-overshoot window to the in-flight set.
      if (!entry.req.overrideBudget) {
        const spend = this.deps.monthToDateSpend(entry.req.projectId)
        const budget = this.deps.monthlyBudgetUsd()
        if (spend >= budget) {
          this.emitSkipped(entry.req, 'budget')
          entry.resolve('skipped:budget')
          continue
        }
      }
      // Per-job cap re-check + increment at START, so the counter measures
      // generations actually run (not enqueue attempts) and several requests that
      // passed the enqueue pre-check can't collectively exceed the cap.
      if (entry.req.jobId) {
        const count = this.jobCounter.get(entry.req.jobId) ?? 0
        if (count >= this.perJobCap) {
          this.emitSkipped(entry.req, 'per-job-cap')
          entry.resolve('skipped:per-job-cap')
          continue
        }
        if (!this.jobCounter.has(entry.req.jobId) && this.jobCounter.size >= this.maxJobCounters) {
          const oldest = this.jobCounter.keys().next().value
          if (oldest !== undefined) this.jobCounter.delete(oldest)
        }
        this.jobCounter.set(entry.req.jobId, count + 1)
      }
      this.inFlightPerProject.set(projectId, perProject + 1)
      DESKTOP.inFlight += 1
      const p = this.runOne(entry)
        .catch((err) => entry.reject(err))
        .finally(() => {
          this.inFlightPerProject.set(
            projectId,
            (this.inFlightPerProject.get(projectId) ?? 1) - 1,
          )
          DESKTOP.inFlight -= 1
          this.pending.delete(p)
          this.pump(projectId)
          // A freed app-wide slot may unblock OTHER projects' managers.
          for (const m of DESKTOP.managers) if (m !== this) m._drainAll()
        })
      this.pending.add(p)
    }
    if (queue.length === 0) this.queues.delete(projectId)
    else this.queues.set(projectId, queue)
  }

  /** Pump every project queue this manager owns (used when an app-wide slot frees
   *  up in a different manager). */
  private _drainAll(): void {
    for (const pid of [...this.queues.keys()]) this.pump(pid)
  }

  private async runOne(entry: QueueEntry): Promise<void> {
    const { req } = entry
    const absolutePath = path.join(req.projectPath, req.relPath)
    const startedIso = new Date((this.deps.now ?? Date.now)()).toISOString()

    let contents: string
    let fileHash: string
    try {
      contents = fs.readFileSync(absolutePath, 'utf8')
      // Use the hash captured for THIS entry at enqueue time (never another
      // entry's). Fall back to a recompute only if it was somehow not set.
      fileHash = entry.newHash || (await computeFileHash(absolutePath))
    } catch {
      this.emitSkipped(req, 'not-found')
      entry.resolve('skipped:not-found')
      return
    }

    const tokens = Math.ceil(contents.length / TOKEN_CHARS_PER_TOKEN)
    let truncated = false
    let promptContents = contents
    if (tokens > TOKEN_LIMIT) {
      truncated = true
      const head = contents.slice(0, TRUNCATE_HEAD_CHARS)
      const tail = contents.slice(contents.length - TRUNCATE_TAIL_CHARS)
      promptContents = head + TRUNCATE_MARKER + tail
    }

    const lang: SummaryLanguage = (this.deps.language?.() ?? 'en')
    const controller = new AbortController()
    this.activeControllers.add(controller)
    try {
      const out = await this.deps.generate({
        relPath: req.relPath,
        contents: promptContents,
        truncated,
        language: lang,
      }, controller.signal)
      // The project may have been removed (and its DB closed) while the provider
      // ran. Skip all DB/disk/broadcast work so we never touch a closed handle.
      if (this._disposed) {
        entry.resolve('failed')
        return
      }
      const payload: SummaryPayload = {
        schemaVersion: 1,
        path: req.relPath,
        fileHash,
        summary: out.summary,
        language: lang,
        generatedAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
        generatedBy: { model: out.model, promptVersion: CURRENT_PROMPT_VERSION, truncated },
        triggeredBy: req.triggeredBy,
      }
      // Relocate-artifacts: summaries OUTPUT to the workspace when relocated
      // (summaryRoot ≠ projectPath ⇒ skip the repo .gitignore append); source
      // was read above from req.projectPath (the repo). Legacy ⇒ both equal.
      const summaryRoot = req.summaryRoot ?? req.projectPath
      writeSummary(summaryRoot, req.relPath, payload, summaryRoot === req.projectPath)
      // Keep the watcher's negative-cache a correct superset.
      this.knownSummaries.get(req.projectId)?.add(req.relPath)

      try {
        recordInvocation(this.deps.db, {
          id: randomUUID(),
          project_id: req.projectId,
          provider: out.provider,
          surface: 'file-summary' as Surface,
          surface_ref_id: req.jobId ?? null,
          ticket_id: req.triggeredBy.ticketId,
          status: 'success',
          started_at: startedIso,
          finished_at: new Date((this.deps.now ?? Date.now)()).toISOString(),
          model: out.model,
          total_cost_usd: out.costUsd,
          tokens_in: out.tokensIn,
          tokens_out: out.tokensOut,
          tokens_cache_read: out.tokensCacheRead,
          tokens_cache_create: out.tokensCacheCreate,
          duration_ms: out.durationMs,
          num_turns: 1,
          total_cost_usd_estimated: !!out.costEstimated,
        })
      } catch (err) {
        // An ai_invocations write failure must never crash the summary queue,
        // but it should not be silent either — a swallowed failure here means
        // spending under-counts with no trace.
        console.error('[file-summary] recordInvocation (success) failed:', err)
      }
      this.deps.broadcast(buildSummaryUpdated(req.projectId, payload, false))
      this.deps.broadcast({ type: 'spending.invalidated', projectId: req.projectId })
      entry.resolve('enqueued')
    } catch (err) {
      // Disposed mid-flight (project removed) — DB is closed; skip all writes.
      if (this._disposed) {
        entry.resolve('failed')
        return
      }
      const reason = err instanceof Error ? err.message : String(err)
      // A timeout/abort kills the child AFTER the provider may have billed tokens.
      // The generator attaches whatever usage it captured so the failed row (and
      // therefore the monthly-budget reader) accounts for that real spend instead
      // of recording a misleading $0.
      const partial = (err as { partial?: Partial<GenerateOutput> }).partial
      try {
        recordInvocation(this.deps.db, {
          id: randomUUID(),
          project_id: req.projectId,
          provider: partial?.provider ?? this.deps.providerId?.() ?? 'claude',
          surface: 'file-summary' as Surface,
          surface_ref_id: req.jobId ?? null,
          ticket_id: req.triggeredBy.ticketId,
          status: 'failed',
          started_at: startedIso,
          finished_at: new Date((this.deps.now ?? Date.now)()).toISOString(),
          model: partial?.model,
          total_cost_usd: partial?.costUsd ?? 0,
          tokens_in: partial?.tokensIn ?? 0,
          tokens_out: partial?.tokensOut ?? 0,
          tokens_cache_read: partial?.tokensCacheRead,
          tokens_cache_create: partial?.tokensCacheCreate,
          duration_ms: partial?.durationMs ?? 0,
          num_turns: 1,
          total_cost_usd_estimated: !!partial?.costEstimated,
        })
      } catch (recErr) {
        // ai_invocations write failures must not crash the manager, but log so
        // a persistent DB problem is visible.
        console.error('[file-summary] recordInvocation (failure) failed:', recErr)
      }
      const failedMsg: FileSummaryFailedMessage = {
        type: 'file.summary_failed',
        projectId: req.projectId,
        path: req.relPath,
        reason,
      }
      this.deps.broadcast(failedMsg)
      // Resolve with 'failed' (not 'enqueued') so a caller awaiting enqueue()
      // can distinguish a failed generation from a successful one.
      entry.resolve('failed')
    } finally {
      this.activeControllers.delete(controller)
    }
  }

  /** `summaryRoot` (relocate-artifacts) is where the summary JSON lives — the
   *  workspace when relocated, else === projectPath. */
  markStale(projectPath: string, projectId: string, relPath: string, summaryRoot?: string): void {
    const existing = readSummary(summaryRoot ?? projectPath, relPath)
    if (!existing) return
    this.deps.broadcast(buildSummaryUpdated(projectId, existing, true))
  }

  /**
   * Watch the repo SOURCE tree (`projectPath`) for edits and mark the
   * corresponding summary stale. Relocate-artifacts: `summaryRoot` is where the
   * summary JSON lives (workspace when relocated) — source is watched at
   * `projectPath`, summaries are scanned/swept/marked at `summaryRoot`. When
   * omitted `summaryRoot` defaults to `projectPath` (legacy, byte-identical).
   */
  attachWatcher(projectId: string, projectPath: string, summaryRoot?: string): void {
    if (this.watchers.has(projectId)) return
    const sumRoot = summaryRoot ?? projectPath
    this.knownSummaries.set(projectId, this.scanKnownSummaries(sumRoot))
    // Reclaim summary JSON files whose source file was renamed/deleted since the
    // last session. Runs once per project per session (attachWatcher is
    // idempotent) and is capped at 200/pass inside sweepOrphans. The chokidar
    // watcher only sees 'change', never 'unlink', so this is the only reaper.
    // sweepOrphans resolves source files against the repo, so it must know both:
    // summaries under sumRoot, source under projectPath.
    try { sweepOrphans(sumRoot, undefined, projectPath) } catch { /* best effort */ }
    // CRITICAL: prune build/dep trees (node_modules, dist, target, src-tauri/target,
    // dot-dirs, …) from the recursive watch. Watching a Rust/Tauri `target/` tree
    // opened ~10k file descriptors and broke terminal spawning under fd pressure.
    // The predicate is tested against each path relative to the project root so a
    // dot-segment in the absolute prefix (the user's home dir) can't false-positive.
    const watcher = chokidar.watch(projectPath, {
      ignored: (p: string) => {
        const rel = path.relative(projectPath, p)
        if (!rel || rel.startsWith('..')) return false // the root itself — never ignore
        return isInBuildDir(rel)
      },
      ignoreInitial: true,
      persistent: true,
      // Coalesce partial-write churn so one logical edit fires one event.
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    })
    watcher.on('change', (changed: string) => {
      // The summary store keys off POSIX forward-slash relpaths everywhere
      // (the REST normalizeRel, pathHash, knownSummaries seeding). On Windows
      // path.relative yields backslashes, so normalize before lookup/markStale —
      // otherwise `known.has(rel)` always misses and edits never mark stale.
      const rel = path.relative(projectPath, changed).split(path.sep).join('/')
      if (!rel || rel.startsWith('..')) return
      // Skip the readSummary disk hit when this file provably has no summary.
      const known = this.knownSummaries.get(projectId)
      if (known && !known.has(rel)) return
      this.markStale(projectPath, projectId, rel, sumRoot)
    })
    this.watchers.set(projectId, { projectPath, watcher })
  }

  /** Read the relPaths of every summary on disk into a set (one-time at attach). */
  private scanKnownSummaries(projectPath: string): Set<string> {
    const set = new Set<string>()
    const dir = summariesDir(projectPath)
    let files: string[] = []
    try { files = fs.readdirSync(dir) } catch { return set }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const payload = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SummaryPayload
        if (payload?.path) set.add(payload.path)
      } catch { /* skip unreadable/partial files */ }
    }
    return set
  }

  detachWatcher(projectId: string): void {
    const state = this.watchers.get(projectId)
    if (!state) return
    void state.watcher.close()
    this.watchers.delete(projectId)
    this.knownSummaries.delete(projectId)
  }

  /** Full teardown for a single manager: stop accepting work, abort any in-flight
   *  provider child (so it is not orphaned past project removal), reject queued
   *  entries, close watchers, and leave the shared app-wide registry. Call from
   *  ProjectRegistry.removeProject (before db.close) and from shutdown(). After
   *  this, runOne's `_disposed` guard skips all DB/disk writes. Idempotent. */
  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    DESKTOP.managers.delete(this)
    // Abort in-flight generations → generator treeKills the provider child.
    for (const c of this.activeControllers) {
      try { c.abort() } catch { /* best effort */ }
    }
    this.activeControllers.clear()
    // Reject still-queued entries so awaiting callers settle (skipped, not hung).
    for (const [, queue] of this.queues) {
      for (const entry of queue) {
        try { this.emitSkipped(entry.req, 'not-found'); entry.resolve('skipped:not-found') } catch { /* best effort */ }
      }
    }
    this.queues.clear()
    this.inFlightByKey.clear()
    for (const [, state] of this.watchers) {
      try { void state.watcher.close() } catch { /* best effort */ }
    }
    this.watchers.clear()
    this.knownSummaries.clear()
  }

  /** Close every watcher. Called on graceful server shutdown so chokidar's
   *  underlying fsevents/inotify handles are released, never leaked. */
  disposeAll(): void {
    this.dispose()
  }

  async flush(): Promise<void> {
    // Drain until no pending work remains.
    while (this.pending.size > 0 || this.hasQueued()) {
      await Promise.allSettled(Array.from(this.pending))
    }
  }

  private hasQueued(): boolean {
    for (const q of this.queues.values()) if (q.length > 0) return true
    return false
  }

  private emitSkipped(req: EnqueueRequest, reason: FileSummarySkippedMessage['reason']): void {
    const msg: FileSummarySkippedMessage = {
      type: 'file.summary_skipped',
      projectId: req.projectId,
      path: req.relPath,
      reason,
    }
    this.deps.broadcast(msg)
  }
}

function buildSummaryUpdated(
  projectId: string,
  payload: SummaryPayload,
  stale: boolean,
): WsMessage {
  const msg: FileSummaryUpdatedMessage = {
    type: 'file.summary_updated',
    projectId,
    path: payload.path,
    summaryAvailable: true,
    stale,
    generatedAt: payload.generatedAt,
  }
  return msg
}
