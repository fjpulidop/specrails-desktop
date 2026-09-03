import { createHash, randomUUID, randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import chokidar from 'chokidar'
import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import { isInBuildDir } from './build-dirs'
import type { DbInstance } from './db'
import type {
  WsMessage,
  FileSummaryUpdatedMessage,
  FileSummaryFailedMessage,
  FileSummarySkippedMessage,
} from './types'
import { recordInvocation, type Surface } from './ai-invocations'
import fileSummarySchema from './schemas/file-summary.v1.json'

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
  /** Null when the provider reports neither authoritative cost nor priceable usage. */
  costUsd: number | null
  /** True when costUsd came from the pricing-table fallback (non-native-cost provider). */
  costEstimated?: boolean
  /** Null when the provider does not report usage. */
  tokensIn: number | null
  tokensOut: number | null
  tokensCacheRead?: number
  tokensCacheCreate?: number
  durationMs: number
}

export interface FileSummaryDeps {
  /** Test seam: override the platform-derived source-watch engine
   *  (see resolveWatchEngine). */
  watchEngine?: WatchEngine
  /** Test seam: the `fs.watch` the 'native' engine calls. */
  fsWatch?: typeof fs.watch
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
// Optimistic spend (USD) reserved per in-flight summary generation before its
// real cost is known. A single Haiku file-summary turn costs well under a cent;
// this conservative reservation only has to bound the concurrent-overshoot
// window (≤ desktopConcurrency generations) — the real cost reconciles via the
// recorded ai_invocations row the moment the generation completes.
const PROJECTED_SUMMARY_COST_USD = 0.01
const TRUNCATE_HEAD_CHARS = 16000
const TRUNCATE_TAIL_CHARS = 8000
const TRUNCATE_MARKER = '\n// … truncated … //\n'

// Upper bound on the LLM-produced `summary` string. A plain-language file
// summary is a short paragraph; anything beyond this is a tampered/runaway
// payload we refuse so it can't bloat WS frames or the on-disk JSON. The schema
// JSON is desktop-owned but shared, so the bound is injected here at compile
// time rather than mutating the published file.
export const SUMMARY_MAX_LENGTH = 8000

// Compile the published file-summary schema ONCE with the existing ajv instance
// (mirrors profile-manager). `strict:false` makes the schema's `format`
// keywords no-ops (no ajv-formats dependency), matching profile validation. We
// clone the schema and add the `maxLength` bound to `summary` so the on-disk and
// just-generated payloads are both length-capped.
let cachedSummaryValidator: ValidateFunction<SummaryPayload> | null = null
function getSummaryValidator(): ValidateFunction<SummaryPayload> {
  if (cachedSummaryValidator) return cachedSummaryValidator
  const schema = JSON.parse(JSON.stringify(fileSummarySchema)) as {
    properties: { summary: { maxLength?: number } }
  }
  schema.properties.summary.maxLength = SUMMARY_MAX_LENGTH
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  cachedSummaryValidator = ajv.compile<SummaryPayload>(schema)
  return cachedSummaryValidator
}

/** True when `payload` conforms to file-summary.v1.json (with the maxLength
 *  bound on `summary`). Exported so callers/tests can pre-validate. */
export function isValidSummaryPayload(payload: unknown): payload is SummaryPayload {
  return getSummaryValidator()(payload) === true
}

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
    const parsed = JSON.parse(raw) as unknown
    // Validate against file-summary.v1.json. A corrupt / hand-edited /
    // cross-version / oversized summary is treated as ABSENT (null) instead of
    // being trusted and surfaced verbatim — so the next request regenerates it.
    if (!isValidSummaryPayload(parsed)) return null
    return parsed
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
  // Reject a non-conformant payload before it ever lands on disk so the
  // documented "schema validated" invariant is real, not aspirational.
  if (!isValidSummaryPayload(payload)) {
    throw new Error('writeSummary: payload failed file-summary.v1 schema validation')
  }
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

/** Which engine backs a project's source watcher. */
export type WatchEngine = 'native' | 'chokidar'
/** `degraded` = the watcher could not start or died (fd / inotify exhaustion,
 *  unsupported platform). The manager keeps working — edits just stop marking
 *  summaries stale until the next explicit read/regenerate hash check. */
export type WatcherStatus = WatchEngine | 'degraded'

interface WatcherState {
  projectPath: string
  status: WatcherStatus
  close: () => void
  /** Per-relpath trailing debounce so one logical edit (editors write in
   *  several chunks / temp-file renames) marks stale ONCE — the successor of
   *  chokidar's awaitWriteFinish. */
  timers: Map<string, ReturnType<typeof setTimeout>>
}

/** Trailing debounce applied to source-change events before the stale check. */
export const WATCH_DEBOUNCE_MS = 200

/** Errno codes meaning the watcher is consuming a process-wide resource it can
 *  no longer get (kqueue file descriptors on macOS, inotify watches on Linux).
 *  Keeping such a watcher alive keeps the leak — and, before this guard, an
 *  unhandled `error` event on the recursive watcher took the whole server down
 *  (`Error: EMFILE: too many open files, watch`). Close + degrade instead. */
const WATCHER_EXHAUSTION_CODES: ReadonlySet<string> = new Set(['EMFILE', 'ENFILE', 'ENOSPC'])

/**
 * Pick the source-watch engine for a platform.
 *
 * macOS and Windows get the kernel's own recursive watch —
 * `fs.watch(dir, { recursive: true })` = FSEvents / ReadDirectoryChangesW —
 * which costs ONE handle for the whole tree. chokidar ≥ 4 dropped fsevents and
 * watches every file with its own `fs.watch`; on macOS that is one kqueue fd
 * PER FILE, so any repo past the ~10k-fd limit blew the process up with
 * `EMFILE: too many open files, watch`. Linux keeps chokidar: inotify watches
 * are not fds, and chokidar's `ignored` pruning keeps `node_modules` / build
 * trees out of the watch set (Node's own recursive implementation on Linux
 * walks and watches everything, `node_modules` included).
 */
export function resolveWatchEngine(platform: NodeJS.Platform = process.platform): WatchEngine {
  return platform === 'darwin' || platform === 'win32' ? 'native' : 'chokidar'
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
  // Per-project OPTIMISTICALLY-RESERVED spend (USD) for generations that have
  // STARTED but whose ai_invocations cost row hasn't landed yet. Added on top of
  // the recorded monthToDateSpend in every budget check so up to
  // desktopConcurrency in-flight generations can no longer collectively blow
  // past the monthly cap (BUG-CODE-05). Reserved at start in pump(), released in
  // runOne's finally once the real cost has been recorded to the DB.
  private readonly pendingSpend = new Map<string, number>()
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
  // path absent from the set provably has no summary — letting the watcher's
  // change funnel skip the disk hits for the common no-summary file. A stale
  // entry (after sweep) just costs one harmless failed read.
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
      const spend = this.effectiveSpend(req.projectId)
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

  // Recorded month-to-date spend PLUS the optimistically-reserved spend of
  // generations already in flight for this project. Both budget gates read this
  // so in-flight generations count against the cap before their cost row lands.
  private effectiveSpend(projectId: string): number {
    return this.deps.monthToDateSpend(projectId) + (this.pendingSpend.get(projectId) ?? 0)
  }

  private reserveSpend(projectId: string): void {
    this.pendingSpend.set(projectId, (this.pendingSpend.get(projectId) ?? 0) + PROJECTED_SUMMARY_COST_USD)
  }

  private releaseSpend(projectId: string): void {
    const next = (this.pendingSpend.get(projectId) ?? 0) - PROJECTED_SUMMARY_COST_USD
    if (next > 0) this.pendingSpend.set(projectId, next)
    else this.pendingSpend.delete(projectId)
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
      // waiting in the queue is skipped instead of spending. effectiveSpend
      // includes the optimistic reservation of generations already in flight, so
      // the Nth concurrent start sees the (N-1) prior reservations and stops at
      // the cap — closing the concurrent-overshoot window (BUG-CODE-05).
      if (!entry.req.overrideBudget) {
        const spend = this.effectiveSpend(entry.req.projectId)
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
      // Reserve projected spend the instant this generation STARTS — before the
      // (awaited) provider call — so concurrent starts each see prior reservations
      // in their budget gate. Released in the finally once the real cost row has
      // landed in the DB (or the generation failed/was skipped).
      if (!entry.req.overrideBudget) this.reserveSpend(projectId)
      const reservedSpend = !entry.req.overrideBudget
      const p = this.runOne(entry)
        .catch((err) => entry.reject(err))
        .finally(() => {
          if (reservedSpend) this.releaseSpend(projectId)
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
      // Cap a runaway LLM summary at the schema bound so writeSummary's
      // validation never rejects a real generation (it would otherwise throw and
      // mis-record the row as failed). Truncation is the safe, lossy fallback.
      const boundedSummary =
        out.summary.length > SUMMARY_MAX_LENGTH ? out.summary.slice(0, SUMMARY_MAX_LENGTH) : out.summary
      const payload: SummaryPayload = {
        schemaVersion: 1,
        path: req.relPath,
        fileHash,
        summary: boundedSummary,
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
          total_cost_usd: out.costUsd ?? undefined,
          tokens_in: out.tokensIn ?? undefined,
          tokens_out: out.tokensOut ?? undefined,
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
          total_cost_usd: partial?.costUsd ?? undefined,
          tokens_in: partial?.tokensIn ?? undefined,
          tokens_out: partial?.tokensOut ?? undefined,
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
   *
   * Never throws and never lets the watcher take the process down: a watcher
   * that cannot start (or later dies of fd/inotify exhaustion) leaves the
   * project attached in `degraded` status, so later Code-Explorer requests do
   * not retry a doomed recursive watch on every hit.
   */
  attachWatcher(projectId: string, projectPath: string, summaryRoot?: string): void {
    if (this.watchers.has(projectId)) return
    const sumRoot = summaryRoot ?? projectPath
    this.knownSummaries.set(projectId, this.scanKnownSummaries(sumRoot))
    // Reclaim summary JSON files whose source file was renamed/deleted since the
    // last session. Runs once per project per session (attachWatcher is
    // idempotent) and is capped at 200/pass inside sweepOrphans. The watcher
    // only marks stale, never deletes, so this is the only reaper.
    // sweepOrphans resolves source files against the repo, so it must know both:
    // summaries under sumRoot, source under projectPath.
    try { sweepOrphans(sumRoot, undefined, projectPath) } catch { /* best effort */ }
    // Registered BEFORE the watch is created so a failed start still counts as
    // attached (degraded) — idempotency is what stops a retry storm.
    const state: WatcherState = { projectPath, status: 'degraded', close: () => {}, timers: new Map() }
    this.watchers.set(projectId, state)
    const engine = this.deps.watchEngine ?? resolveWatchEngine()
    const onChange = (raw: string | Buffer | null): void => this.onSourceChanged(projectId, state, raw, sumRoot)
    const onError = (err: unknown): void => this.onWatcherError(projectId, state, err)
    try {
      state.close = engine === 'native'
        ? this.startNativeWatcher(projectPath, onChange, onError)
        : this.startChokidarWatcher(projectPath, onChange, onError)
      state.status = engine
    } catch (err) {
      this.degradeWatcher(projectId, state, err, 'start')
    }
  }

  /** Current watcher status for a project, or null when never attached. */
  watcherStatus(projectId: string): WatcherStatus | null {
    return this.watchers.get(projectId)?.status ?? null
  }

  /** One kernel-level recursive watch for the whole tree (FSEvents on macOS,
   *  ReadDirectoryChangesW on Windows). `filename` arrives relative to the
   *  watched root. `persistent: false` — the HTTP server keeps the process
   *  alive; a watcher never should. */
  private startNativeWatcher(
    projectPath: string,
    onChange: (raw: string | Buffer | null) => void,
    onError: (err: unknown) => void,
  ): () => void {
    const watch = this.deps.fsWatch ?? fs.watch
    const watcher = watch(projectPath, { recursive: true, persistent: false }, (_event, filename) => onChange(filename))
    watcher.on('error', onError)
    return () => { try { watcher.close() } catch { /* best effort */ } }
  }

  /** chokidar (Linux): one inotify watch per file/dir, so the build/dep trees
   *  MUST be pruned — a Rust `target/` or `node_modules` alone is tens of
   *  thousands of watches. The predicate is tested against each path relative
   *  to the project root so a dot-segment in the absolute prefix (the user's
   *  home dir) can't false-positive. */
  private startChokidarWatcher(
    projectPath: string,
    onChange: (raw: string | Buffer | null) => void,
    onError: (err: unknown) => void,
  ): () => void {
    const watcher = chokidar.watch(projectPath, {
      followSymlinks: false,
      ignored: (p: string) => {
        const rel = path.relative(projectPath, p)
        if (!rel || rel.startsWith('..')) return false // the root itself — never ignore
        return isInBuildDir(rel)
      },
      ignoreInitial: true,
      // A dir we cannot read is not a reason to lose the whole watcher.
      ignorePermissionErrors: true,
      persistent: false,
    })
    watcher.on('change', (changed: string) => onChange(changed))
    watcher.on('unlink', (removed: string) => onChange(removed))
    watcher.on('error', onError)
    return () => { void watcher.close().catch(() => { /* best effort */ }) }
  }

  /** Shared change funnel for both engines: normalise to a POSIX relpath, drop
   *  build/dep/dot trees and files that provably have no summary, then debounce
   *  per path before the (hash-checked) stale mark. */
  private onSourceChanged(projectId: string, state: WatcherState, raw: string | Buffer | null, sumRoot: string): void {
    if (raw == null || this._disposed || state.status === 'degraded') return
    const name = typeof raw === 'string' ? raw : raw.toString()
    // Native engines report paths relative to the watched root (Windows with
    // backslashes); chokidar reports absolute paths. Meet in the middle.
    const relRaw = path.isAbsolute(name) ? path.relative(state.projectPath, name) : name
    // The summary store keys off POSIX forward-slash relpaths everywhere (the
    // REST normalizeRel, pathHash, knownSummaries seeding) — normalise before
    // lookup/markStale, otherwise `known.has(rel)` always misses on Windows.
    const rel = relRaw.split(path.sep).join('/')
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return
    if (isInBuildDir(rel)) return
    // Skip the disk hits when this file provably has no summary.
    const known = this.knownSummaries.get(projectId)
    if (known && !known.has(rel)) return
    const pending = state.timers.get(rel)
    if (pending) clearTimeout(pending)
    const timer = setTimeout(() => {
      state.timers.delete(rel)
      void this.markStaleIfChanged(state.projectPath, projectId, rel, sumRoot)
    }, WATCH_DEBOUNCE_MS)
    timer.unref?.()
    state.timers.set(rel, timer)
  }

  /** Watcher-side markStale: broadcast ONLY when the source really differs from
   *  what the summary was generated against. A save that leaves the bytes
   *  unchanged, an editor's temp-file dance, or a replayed/coalesced kernel
   *  event must not flag a still-valid summary. A source that vanished IS
   *  stale — the summary describes a file that is gone. */
  private async markStaleIfChanged(projectPath: string, projectId: string, rel: string, sumRoot: string): Promise<void> {
    const existing = readSummary(sumRoot, rel)
    if (!existing) return
    let hash: string | null = null
    try { hash = await computeFileHash(path.join(projectPath, rel)) } catch { hash = null }
    if (hash !== null && hash === existing.fileHash) return
    if (this._disposed) return
    this.deps.broadcast(buildSummaryUpdated(projectId, existing, true))
  }

  private onWatcherError(projectId: string, state: WatcherState, err: unknown): void {
    const code = errnoCode(err)
    if (code && !WATCHER_EXHAUSTION_CODES.has(code) && state.status !== 'degraded') {
      // Transient and local (a dir vanished mid-scan, a permission hiccup on
      // one subtree): keep watching, just log.
      console.warn('[file-summary] watcher error', JSON.stringify({ projectId, code, error: errMessage(err) }))
      return
    }
    this.degradeWatcher(projectId, state, err, 'runtime')
  }

  /** Release the watcher (and, with it, every fd/watch it holds) and park the
   *  project in degraded mode. Logged once — never thrown, never re-armed. */
  private degradeWatcher(projectId: string, state: WatcherState, err: unknown, phase: 'start' | 'runtime'): void {
    const alreadyDegraded = state.status === 'degraded' && phase === 'runtime'
    state.status = 'degraded'
    this.closeWatcherState(state)
    if (alreadyDegraded) return
    console.warn(
      '[file-summary] watcher degraded — edits will not mark summaries stale until the next explicit read/regenerate',
      JSON.stringify({ projectId, projectPath: state.projectPath, phase, code: errnoCode(err) ?? null, error: errMessage(err) }),
    )
  }

  private closeWatcherState(state: WatcherState): void {
    const close = state.close
    state.close = () => {}
    try { close() } catch { /* best effort */ }
    for (const timer of state.timers.values()) clearTimeout(timer)
    state.timers.clear()
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
    this.closeWatcherState(state)
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
    this.pendingSpend.clear()
    for (const [, state] of this.watchers) this.closeWatcherState(state)
    this.watchers.clear()
    this.knownSummaries.clear()
  }

  /** Close every watcher. Called on graceful server shutdown so the
   *  underlying FSEvents/ReadDirectoryChangesW/inotify handles are released,
   *  never leaked. */
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
