/**
 * Retained run worktrees of ONE project: list them, gather the Git evidence
 * the pure evaluation needs ({@link evaluateRetainedWorktree}) and remove the
 * ones a person confirmed — always through the existing release path
 * (`releaseRailWorktrees`: live re-verification, overlay quarantine and the
 * leftover-process reaper), never a second removal implementation.
 *
 * Project isolation: every function receives one project's own database and
 * checkout; nothing here is cached across projects (the size scanner keys by
 * project id). All Git reads are child processes; the only filesystem reads on
 * the request path are `lstat`/`stat` probes and the bounded async identity
 * check of ignored files.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { DbInstance } from '../../../db'
import { withRepoLock } from '../../../repo-lock'
import type { GitRunner } from '../../../worktree-manager'
import { authenticateWarmNodeModulesLinks } from '../../../worktree-node-modules'
import { matchesOverlayCleanupEvidence } from '../../../worktree-overlay'
import { readDiskUsage, type DiskUsageReader } from '../../terminals/runtime/resource-sampler'
import {
  escapeRefGlob, evaluateRetainedWorktree, idleDays, parsePorcelainZ,
  type RetainedDeliveryFacts, type RetainedGitEvidence, type RetainedWorktreeEvaluation, type RetainedWorktreeKind,
} from '../domain/retained-worktrees'
import { ignoredPathIsSafeCopy } from './ignored-copy-identity'
import { copiedEnvFilePaths } from '../../../worktree-env-files'
import { appendPrDeliverySafetyArchive, toPrDeliverySnapshot, type RailPrDeliveryRow } from './rail-pr-store'
import {
  durableOverlayCleanupEvidence, durableSettlementIgnoredPaths, isRegenerableIgnoredPath, releaseRailWorktrees,
} from './rail-worktree-release'
import { isTerminalMergeState, type RailWorktreeRow } from './rail-worktrees-store'

const COMMIT_SHA_RE = /^[0-9a-f]{40,64}$/i
/** At most this many ignored paths at risk are listed per worktree (the count is exact). */
const AT_RISK_LIST_CAP = 20
/** Git evidence reads in flight per listing (each runs a few short git children). */
const EVIDENCE_CONCURRENCY = 4

/** One project, bound to its own database and checkout. */
export interface RetainedWorktreeProject {
  id: string
  name: string
  /** The main checkout. */
  path: string
  db: DbInstance
  ticketTitle?: (ticketId: number) => string | null
}

export interface RetainedWorktreeCandidate {
  /** `rail_worktrees.id` (rail) or `flow_sessions.id` (intent). */
  id: string
  kind: RetainedWorktreeKind
  worktreePath: string
  branch: string | null
  /** The checkout whose object store and refs the worktree shares. */
  repoDir: string
  railIndex: number | null
  ticketId: number | null
  runId: string | null
  /** The ledger state (rail) or the Intent session state. */
  state: string
  /** Epoch ms of the ledger/session row's last update. */
  rowUpdatedAt: number | null
  delivery: RailPrDeliveryRow | null
}

export interface RetainedWorktreeItem {
  id: string
  kind: RetainedWorktreeKind
  projectId: string
  projectName: string
  railIndex: number | null
  ticketId: number | null
  ticketTitle: string | null
  runId: string | null
  branch: string | null
  worktreePath: string
  state: string
  pr: { url: string | null; number: number | null; decision: string; deliveryState: string } | null
  lastActivityAt: string | null
  idleDays: number | null
  head: string | null
  trackedChanges: number | null
  untrackedFiles: number | null
  ignoredAtRisk: string[]
  ignoredAtRiskCount: number | null
  unpushedCommits: number | null
  evaluation: RetainedWorktreeEvaluation
}

export function sqliteUtcMs(value: string | null | undefined): number | null {
  if (!value) return null
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function exists(target: string): boolean {
  try { fs.lstatSync(target); return true } catch { return false }
}

function deliveryForWorktree(db: DbInstance, worktreeIds: readonly string[]): RailPrDeliveryRow | null {
  const statement = db.prepare(`SELECT d.* FROM rail_pr_deliveries d
    WHERE EXISTS (SELECT 1 FROM json_each(d.worktree_ids) j WHERE j.value = ?)
    ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`)
  for (const id of worktreeIds) {
    try {
      const row = statement.get(id) as RailPrDeliveryRow | undefined
      if (row) return row
    } catch { return null }
  }
  return null
}

/**
 * Worktrees Specrails keeps on disk with nobody running in them: rail ledger
 * rows that settled as `needs-review`, or any terminal row whose mount is still
 * there (a removal that failed), plus Intent sessions parked in `needs-review`.
 * Rows sharing a mount (a revision borrowed it) collapse to the newest one; a
 * mount any row is still building in is not retained and is left out.
 */
export function listRetainedWorktreeCandidates(project: RetainedWorktreeProject): RetainedWorktreeCandidate[] {
  let rows: RailWorktreeRow[] = []
  try {
    rows = project.db.prepare('SELECT * FROM rail_worktrees ORDER BY created_at DESC, rowid DESC').all() as RailWorktreeRow[]
  } catch { rows = [] }
  const byPath = new Map<string, RailWorktreeRow[]>()
  for (const row of rows) {
    const group = byPath.get(row.worktree_path) ?? []
    group.push(row)
    byPath.set(row.worktree_path, group)
  }
  const out: RetainedWorktreeCandidate[] = []
  for (const [worktreePath, group] of byPath) {
    if (group.some((row) => !isTerminalMergeState(row.merge_state))) continue
    if (!exists(worktreePath)) continue
    const newest = group[0]
    if (newest.merge_state !== 'needs-review' && !exists(path.join(worktreePath, '.git'))) continue
    out.push({
      id: newest.id,
      kind: 'rail',
      worktreePath,
      branch: newest.branch,
      repoDir: newest.repository_path ?? project.path,
      railIndex: newest.rail_index,
      ticketId: newest.ticket_id,
      runId: newest.run_id,
      state: newest.merge_state,
      rowUpdatedAt: sqliteUtcMs(newest.updated_at),
      delivery: deliveryForWorktree(project.db, group.map((row) => row.id)),
    })
  }
  try {
    const sessions = project.db.prepare(`SELECT id, ticket_id, branch, worktree_path, state, updated_at FROM flow_sessions
      WHERE state = 'needs-review' AND worktree_path IS NOT NULL ORDER BY updated_at DESC`).all() as Array<{
      id: string; ticket_id: number | null; branch: string | null; worktree_path: string; state: string; updated_at: string
    }>
    for (const session of sessions) {
      if (byPath.has(session.worktree_path) || !exists(session.worktree_path)) continue
      out.push({
        id: session.id,
        kind: 'intent',
        worktreePath: session.worktree_path,
        branch: session.branch,
        repoDir: project.path,
        railIndex: null,
        ticketId: session.ticket_id,
        runId: null,
        state: session.state,
        rowUpdatedAt: sqliteUtcMs(session.updated_at),
        delivery: null,
      })
    }
  } catch { /* a project without Intent sessions */ }
  return out
}

/** The gitdir of a linked worktree (`.git` is a `gitdir:` file), or null. */
function linkedGitDir(worktreePath: string): string | null {
  try {
    const dotGit = path.join(worktreePath, '.git')
    const stat = fs.statSync(dotGit)
    if (stat.isDirectory()) return dotGit
    const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))
    return match ? path.resolve(worktreePath, match[1].trim()) : null
  } catch {
    return null
  }
}

function lastActivity(candidate: RetainedWorktreeCandidate): number | null {
  const times: number[] = []
  if (candidate.rowUpdatedAt !== null) times.push(candidate.rowUpdatedAt)
  const gitDir = linkedGitDir(candidate.worktreePath)
  for (const file of gitDir ? ['index', 'HEAD', path.join('logs', 'HEAD')] : []) {
    try { times.push(fs.statSync(path.join(gitDir!, file)).mtimeMs) } catch { /* absent */ }
  }
  return times.length > 0 ? Math.max(...times) : null
}

/** Overlay paths Specrails itself put in the worktree (persisted fingerprints + live warm links + env-file copies). */
function overlayExcludes(candidate: RetainedWorktreeCandidate): string[] {
  const persisted = candidate.delivery && candidate.branch
    ? (durableOverlayCleanupEvidence(toPrDeliverySnapshot(candidate.delivery).branches).get(candidate.branch) ?? [])
        .filter((entry) => matchesOverlayCleanupEvidence(candidate.worktreePath, entry))
        .map((entry) => entry.path)
    : []
  let warm: string[] = []
  try { warm = authenticateWarmNodeModulesLinks(candidate.repoDir, candidate.worktreePath).map((entry) => entry.path) } catch { warm = [] }
  let envFiles: string[] = []
  try { envFiles = copiedEnvFilePaths(candidate.worktreePath) } catch { envFiles = [] }
  return [...new Set([...persisted, ...warm, ...envFiles])]
}

function settlementIgnored(candidate: RetainedWorktreeCandidate): readonly string[] {
  if (!candidate.delivery || !candidate.branch) return []
  return durableSettlementIgnoredPaths(toPrDeliverySnapshot(candidate.delivery).branches).get(candidate.branch) ?? []
}

function coveredBy(livePath: string, snapshot: readonly string[]): boolean {
  const live = livePath.replace(/\/$/, '')
  return snapshot.some((entry) => live === entry || live.startsWith(`${entry}/`))
}

async function safeRun(git: GitRunner, args: string[], cwd: string): Promise<{ code: number; stdout: string } | null> {
  try { return await git.run(args, cwd) } catch { return null }
}

export interface RetainedEvidence {
  git: RetainedGitEvidence & { branchTip: string | null }
  lastActivityAt: number | null
}

/** Read everything the evaluation needs. A failed read leaves its field null (unknown, never clean). */
export async function gatherRetainedEvidence(git: GitRunner, candidate: RetainedWorktreeCandidate): Promise<RetainedEvidence> {
  // Read activity first: nothing below may count as activity (reads run
  // without optional locks, so `status` does not rewrite the index).
  const activity = lastActivity(candidate)
  const excludes = overlayExcludes(candidate)
  const [head, status] = await Promise.all([
    safeRun(git, ['rev-parse', '--verify', 'HEAD'], candidate.worktreePath),
    safeRun(git, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--', '.',
      ...excludes.map((entry) => `:(top,exclude,literal)${entry}`),
    ], candidate.worktreePath),
  ])
  const headSha = head?.code === 0 && COMMIT_SHA_RE.test(head.stdout.trim()) ? head.stdout.trim().toLowerCase() : null
  const counts = status?.code === 0 ? parsePorcelainZ(status.stdout) : null

  let ignoredAtRisk: string[] | null = null
  if (counts) {
    const snapshot = settlementIgnored(candidate)
    const candidates = counts.ignored.filter((entry) => !isRegenerableIgnoredPath(entry) && !coveredBy(entry, snapshot))
    const safe = await Promise.all(candidates.map((entry) => ignoredPathIsSafeCopy(candidate.worktreePath, candidate.repoDir, entry)))
    ignoredAtRisk = candidates.filter((_entry, index) => !safe[index]).map((entry) => entry.replace(/\/$/, ''))
  }

  let branchExists: boolean | null = null
  let branchTip: string | null = null
  let unpushedCommits: number | null = null
  if (candidate.branch) {
    const ref = await safeRun(git, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate.branch}`], candidate.repoDir)
    if (ref?.code === 0 && COMMIT_SHA_RE.test(ref.stdout.trim())) {
      branchExists = true
      branchTip = ref.stdout.trim().toLowerCase()
      // Commits only this branch holds: not on any remote, any other local
      // branch, or the main checkout's HEAD.
      const unique = await safeRun(git, [
        'rev-list', '--count', branchTip, '--not', '--remotes',
        `--exclude=${escapeRefGlob(candidate.branch)}`, '--branches', 'HEAD',
      ], candidate.repoDir)
      const count = unique?.code === 0 ? Number(unique.stdout.trim()) : NaN
      unpushedCommits = Number.isInteger(count) && count >= 0 ? count : null
    } else if (ref && ref.code === 1 && ref.stdout.trim() === '') {
      branchExists = false
    }
  } else {
    branchExists = false
  }

  return {
    git: {
      head: headSha,
      trackedChanges: counts?.tracked ?? null,
      untrackedFiles: counts?.untracked ?? null,
      ignoredAtRisk,
      branchExists,
      unpushedCommits,
      branchTip,
    },
    lastActivityAt: activity,
  }
}

function deliveryFacts(delivery: RailPrDeliveryRow | null): RetainedDeliveryFacts | null {
  return delivery ? { decision: delivery.decision, operationActive: Boolean(delivery.operation) } : null
}

export async function evaluateCandidate(
  git: GitRunner,
  candidate: RetainedWorktreeCandidate,
  now: number,
): Promise<{ evidence: RetainedEvidence; evaluation: RetainedWorktreeEvaluation }> {
  const evidence = await gatherRetainedEvidence(git, candidate)
  const evaluation = evaluateRetainedWorktree({
    kind: candidate.kind,
    runActive: false,
    delivery: deliveryFacts(candidate.delivery),
    lastActivityAt: evidence.lastActivityAt,
    git: evidence.git,
  }, now)
  return { evidence, evaluation }
}

async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Evaluate every retained worktree of one project (Git reads bounded in flight). */
export async function listRetainedWorktrees(
  project: RetainedWorktreeProject,
  git: GitRunner,
  now: number = Date.now(),
): Promise<RetainedWorktreeItem[]> {
  const candidates = listRetainedWorktreeCandidates(project)
  return mapBounded(candidates, EVIDENCE_CONCURRENCY, async (candidate) => {
    const { evidence, evaluation } = await evaluateCandidate(git, candidate, now)
    let ticketTitle: string | null = null
    if (candidate.ticketId !== null) { try { ticketTitle = project.ticketTitle?.(candidate.ticketId) ?? null } catch { ticketTitle = null } }
    const delivery = candidate.delivery
    return {
      id: candidate.id,
      kind: candidate.kind,
      projectId: project.id,
      projectName: project.name,
      railIndex: candidate.railIndex,
      ticketId: candidate.ticketId,
      ticketTitle,
      runId: candidate.runId,
      branch: candidate.branch,
      worktreePath: candidate.worktreePath,
      state: candidate.state,
      pr: delivery ? { url: delivery.pr_url, number: delivery.pr_number, decision: delivery.decision, deliveryState: delivery.pr_state } : null,
      lastActivityAt: evidence.lastActivityAt === null ? null : new Date(evidence.lastActivityAt).toISOString(),
      idleDays: idleDays(evidence.lastActivityAt, now),
      head: evidence.git.head,
      trackedChanges: evidence.git.trackedChanges,
      untrackedFiles: evidence.git.untrackedFiles,
      ignoredAtRisk: (evidence.git.ignoredAtRisk ?? []).slice(0, AT_RISK_LIST_CAP),
      ignoredAtRiskCount: evidence.git.ignoredAtRisk?.length ?? null,
      unpushedCommits: evidence.git.unpushedCommits,
      evaluation,
    }
  })
}

export interface RetainedRemovalRequest {
  id: string
  /** The worktree HEAD the person saw when confirming (compare-and-swap). */
  head: string
  deleteBranch: boolean
}

export type RetainedRemovalStatus = 'removed' | 'kept' | 'not-found'

export interface RetainedRemovalResult {
  id: string
  status: RetainedRemovalStatus
  /** Why it was kept: a {@link RetainedWorktreeReason}, `changed` (HEAD moved since confirmation) or `release`. */
  reason: string | null
  branchDeleted: boolean
  warnings: string[]
}

async function branchCheckedOutElsewhere(git: GitRunner, repoDir: string, branch: string): Promise<boolean | null> {
  const list = await safeRun(git, ['worktree', 'list', '--porcelain'], repoDir)
  if (!list || list.code !== 0) return null
  return list.stdout.split('\n').some((line) => line.trim() === `branch refs/heads/${branch}`)
}

/**
 * Remove one confirmed retained worktree under its repository lock. The
 * evidence is gathered again and must still allow removal, and the HEAD must
 * still be the one the person confirmed; the release path then re-proves
 * cleanliness and HEAD/ref identity itself before Git's non-force removal.
 * The branch goes only when asked, only when it holds nothing unique, and only
 * with `update-ref -d <ref> <recorded sha>` (Git refuses if it moved).
 */
export async function removeRetainedWorktree(
  project: RetainedWorktreeProject,
  git: GitRunner,
  request: RetainedRemovalRequest,
  now: () => number = Date.now,
): Promise<RetainedRemovalResult> {
  const result = (status: RetainedRemovalStatus, reason: string | null, extra: Partial<RetainedRemovalResult> = {}): RetainedRemovalResult => ({
    id: request.id, status, reason, branchDeleted: false, warnings: [], ...extra,
  })
  const initial = listRetainedWorktreeCandidates(project).find((entry) => entry.id === request.id)
  if (!initial || initial.kind !== 'rail' || !initial.branch) return result(initial ? 'kept' : 'not-found', initial ? 'intent-owned' : null)
  return withRepoLock(initial.repoDir, async () => {
    // Re-read under the lock: a decision may have moved it meanwhile.
    const candidate = listRetainedWorktreeCandidates(project).find((entry) => entry.id === request.id)
    if (!candidate || candidate.kind !== 'rail' || !candidate.branch) return result('not-found', null)
    const { evidence, evaluation } = await evaluateCandidate(git, candidate, now())
    if (!evaluation.removable) return result('kept', evaluation.removeBlocker)
    if (!evidence.git.head || evidence.git.head !== request.head.trim().toLowerCase()) return result('kept', 'changed')

    const snapshot = candidate.delivery ? toPrDeliverySnapshot(candidate.delivery) : null
    const archives: string[] = []
    const warnings = await releaseRailWorktrees({
      db: project.db,
      git,
      repoDir: candidate.repoDir,
      worktreeIds: [candidate.id],
      state: 'released',
      expectedHeadByBranch: new Map([[candidate.branch, evidence.git.head]]),
      overlayEvidenceByBranch: snapshot ? durableOverlayCleanupEvidence(snapshot.branches) : new Map(),
      settlementIgnoredByBranch: snapshot ? durableSettlementIgnoredPaths(snapshot.branches) : new Map(),
      onSafetyArchive: (archive) => {
        archives.push(archive)
        if (candidate.delivery) appendPrDeliverySafetyArchive(project.db, candidate.delivery.id, archive)
      },
      acceptIgnoredBaseCopies: true,
      reclaimTerminalMounts: true,
    })
    const notes = [...warnings, ...archives.map((archive) => `kept a safety copy of Specrails' own files at ${archive}`)]
    if (exists(candidate.worktreePath)) return result('kept', 'release', { warnings: notes })

    let branchDeleted = false
    const tip = evidence.git.branchTip
    if (request.deleteBranch && evaluation.branchDeletable && tip && tip === evidence.git.head) {
      const elsewhere = await branchCheckedOutElsewhere(git, candidate.repoDir, candidate.branch)
      if (elsewhere === false) {
        const deleted = await safeRun(git, ['update-ref', '-d', `refs/heads/${candidate.branch}`, tip], candidate.repoDir)
        branchDeleted = deleted?.code === 0
        if (!branchDeleted) notes.push(`branch ${candidate.branch}: kept because it moved since it was checked`)
      } else {
        notes.push(`branch ${candidate.branch}: kept because ${elsewhere ? 'another checkout uses it' : 'Git could not list checkouts'}`)
      }
    } else if (request.deleteBranch) {
      notes.push(`branch ${candidate.branch}: kept because it holds work that exists nowhere else or still waits for a decision`)
    }
    return result('removed', null, { branchDeleted, warnings: notes })
  })
}

export type RetainedSizeState =
  | { status: 'scanning' }
  | { status: 'done'; bytes: number; scannedAt: number }
  | { status: 'failed'; scannedAt: number }

/**
 * Lazy, bounded disk-usage scans (`du -sk`, an async walk on Windows): at most
 * {@link concurrency} in flight, results reused for {@link ttlMs}. Keys carry
 * the project id, so no project ever reads another's entry.
 */
export function createRetainedSizeScanner(options: { read?: DiskUsageReader; concurrency?: number; ttlMs?: number; now?: () => number } = {}) {
  const read = options.read ?? readDiskUsage
  const limit = options.concurrency ?? 2
  const ttl = options.ttlMs ?? 10 * 60 * 1000
  const now = options.now ?? Date.now
  const states = new Map<string, RetainedSizeState>()
  const queue: Array<{ key: string; dir: string }> = []
  let running = 0
  const pump = (): void => {
    while (running < limit && queue.length > 0) {
      const job = queue.shift()!
      running++
      void read(job.dir).then(
        (bytes) => { states.set(job.key, { status: 'done', bytes, scannedAt: now() }) },
        () => { states.set(job.key, { status: 'failed', scannedAt: now() }) },
      ).finally(() => { running--; pump() })
    }
  }
  return {
    /** Current state; starts (queues) a scan when none is fresh. */
    request(projectId: string, id: string, dir: string): RetainedSizeState {
      const key = `${projectId}\0${id}`
      const current = states.get(key)
      if (current && (current.status === 'scanning' || now() - current.scannedAt < ttl)) return current
      const scanning: RetainedSizeState = { status: 'scanning' }
      states.set(key, scanning)
      queue.push({ key, dir })
      pump()
      return scanning
    },
    forget(projectId: string, id: string): void {
      states.delete(`${projectId}\0${id}`)
    },
  }
}
