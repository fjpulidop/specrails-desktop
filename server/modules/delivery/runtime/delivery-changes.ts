/**
 * In-app review: the Changes tab's read model (feature-gap CD3).
 *
 * Answers "what did this delivery change?" from the repository itself: the
 * delivery's head (the assembled branch, or one unit's branch) against its base,
 * measured from the merge-base so a base that moved on does not leak unrelated
 * changes into the review. Read-only — every git call here is a `diff`,
 * `merge-base` or `rev-parse`, run with the hardened environment of the other
 * cwd-scoped git readers (no hooks, no fsmonitor, no prompts).
 *
 * Two reads, both lazy: the file LIST (paths, status, +/− counts, a content
 * hash that changes whenever the file's diff does) and ONE file's parsed hunks.
 * A huge file diff is capped to a bounded number of lines; the caller opts into
 * the rest with `full`. Annotations (reviewer findings, brief risks, follow-up
 * comments) are returned raw and anchored by the client against the displayed
 * lines, so an annotation that no longer maps still renders (unanchored).
 */
import { execFile } from 'child_process'
import fs from 'fs'
import { gitExecEnv } from '../../code/runtime/file-provenance'
import { readSettleEvidence, type DeliveryFindingLocation } from './delivery-evidence'
import { readFollowUp } from './pr-follow-up'
import type { DeliverBranchRecord, RailPrDeliveryRow } from './rail-pr-store'

export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange'

export interface ChangedFile {
  path: string
  /** Previous path for a rename / copy, else null. */
  oldPath: string | null
  status: ChangedFileStatus
  /** null for a binary file (git reports no line counts). */
  additions: number | null
  deletions: number | null
  binary: boolean
  /** Changes whenever this file's diff does (old + new blob ids); the "viewed" invalidation key. */
  hash: string
}

export interface ChangeSource {
  /** `delivery` (the assembled branch) or `ticket:<id>` (one unit's branch). */
  id: string
  ticketId: number | null
  branch: string
}

export type ChangesUnavailableReason =
  | 'not_a_repository' | 'no_branch' | 'head_missing' | 'base_missing' | 'git_failed'

export interface DeliveryAnnotation {
  id: string
  source: 'reviewer-finding' | 'review-risk' | 'review-untested' | 'follow-up-comment'
  /** Reviewer wording, verbatim and untrusted (rendered as text). */
  text: string
  severity: 'high' | 'medium' | 'low' | null
  author: string | null
  /** null = the source named no place: shown at the top of the tab, never dropped. */
  location: { path: string; line: number | null; endLine: number | null } | null
}

export type DeliveryChanges =
  | { available: false; reason: ChangesUnavailableReason; sources: ChangeSource[]; annotations: DeliveryAnnotation[] }
  | {
    available: true
    source: string
    sources: ChangeSource[]
    base: string
    head: string
    baseSha: string
    headSha: string
    /** Checkout whose files exist on disk for "Open in editor" (the retained worktree, else the repository). */
    root: string
    rootKind: 'worktree' | 'repository'
    files: ChangedFile[]
    truncated: boolean
    totals: { files: number; additions: number; deletions: number }
    annotations: DeliveryAnnotation[]
  }

export type DiffLineType = 'context' | 'add' | 'delete'
export interface DiffLine { type: DiffLineType; oldNo: number | null; newNo: number | null; text: string; noNewline?: boolean }
export interface DiffHunk { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] }
export interface FileDiff {
  path: string
  oldPath: string | null
  status: ChangedFileStatus
  binary: boolean
  hunks: DiffHunk[]
  /** The diff was cut at the line cap; ask again with `full`. */
  truncated: boolean
  totalLines: number
}

export const MAX_LISTED_FILES = 2000
export const DEFAULT_DIFF_LINE_CAP = 4000
export const FULL_DIFF_LINE_CAP = 60_000
const GIT_TIMEOUT_MS = 20_000
const LIST_MAX_BUFFER = 16 * 1024 * 1024
const DIFF_MAX_BUFFER = 32 * 1024 * 1024
const FOLLOW_UP_TEXT_CAP = 1200

export interface GitResult { code: number; stdout: string; stderr: string }
/** Injectable git runner so the pure parts stay testable; the default shells out. */
export type GitRun = (args: string[], cwd: string, maxBuffer?: number) => Promise<GitResult>

export const defaultGitRun: GitRun = (args, cwd, maxBuffer = LIST_MAX_BUFFER) => new Promise((resolve) => {
  execFile('git', ['--literal-pathspecs', '-c', 'core.quotepath=off', ...args], {
    cwd, env: gitExecEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer, windowsHide: true,
  }, (err, stdout, stderr) => {
    const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err ? err.message : '') })
  })
})

// ─── Source resolution ──────────────────────────────────────────────────────

function parseBranches(raw: string): DeliverBranchRecord[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((b): b is DeliverBranchRecord => !!b && typeof b === 'object' && typeof (b as { branch?: unknown }).branch === 'string') : []
  } catch { return [] }
}

/** A ref from the database must never be read as a git option. */
function safeRef(ref: string | null | undefined): string | null {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= 255 && !ref.startsWith('-') && !/[\0\s]/.test(ref) ? ref : null
}

export function listChangeSources(row: Pick<RailPrDeliveryRow, 'branch' | 'branches' | 'delivery_sha'>, repositoryId?: string | null): ChangeSource[] {
  const sources: ChangeSource[] = []
  const assembled = safeRef(row.branch)
  if (assembled) sources.push({ id: 'delivery', ticketId: null, branch: assembled })
  const units = parseBranches(row.branches)
    .filter((unit) => (!repositoryId || !unit.repositoryId || unit.repositoryId === repositoryId) && unit.changed !== false && unit.deliveryOutcome !== 'no_changes')
  // A single-unit delivery without an assembled branch has exactly one source.
  for (const unit of units) {
    const ref = safeRef(unit.finalSha ?? unit.branch)
    if (!ref) continue
    if (assembled && unit.branch === assembled) continue
    sources.push({ id: `ticket:${unit.ticketId}`, ticketId: unit.ticketId, branch: unit.branch })
  }
  return sources
}

interface ResolvedTarget { source: ChangeSource; head: string; base: string; baseSha: string; headSha: string; root: string; rootKind: 'worktree' | 'repository' }

async function revParse(git: GitRun, cwd: string, ref: string): Promise<string | null> {
  const res = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)
  const sha = res.stdout.trim()
  return res.code === 0 && /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null
}

export async function resolveChangeTarget(
  input: { row: RailPrDeliveryRow; repoDir: string; sourceId?: string | null; repositoryId?: string | null },
  git: GitRun = defaultGitRun,
): Promise<{ ok: true; target: ResolvedTarget; sources: ChangeSource[] } | { ok: false; reason: ChangesUnavailableReason; sources: ChangeSource[] }> {
  const { row, repoDir } = input
  const sources = listChangeSources(row, input.repositoryId)
  const inside = await git(['rev-parse', '--is-inside-work-tree'], repoDir)
  if (inside.code !== 0) return { ok: false, reason: 'not_a_repository', sources }
  const source = input.sourceId ? sources.find((s) => s.id === input.sourceId) : sources[0]
  if (!source) return { ok: false, reason: 'no_branch', sources }
  const units = parseBranches(row.branches)
  const unit = source.ticketId === null ? undefined : units.find((u) => u.ticketId === source.ticketId && u.branch === source.branch)
  // The settled object wins over the branch name: the ref may have moved since.
  const headRef = source.ticketId === null ? (safeRef(row.delivery_sha) ?? source.branch) : (safeRef(unit?.finalSha) ?? source.branch)
  const headSha = await revParse(git, repoDir, headRef) ?? (headRef !== source.branch ? await revParse(git, repoDir, source.branch) : null)
  if (!headSha) return { ok: false, reason: 'head_missing', sources }
  const baseName = safeRef(row.base_branch)
  let baseSha: string | null = null
  let baseLabel = baseName ?? ''
  for (const candidate of baseName ? [baseName, `refs/heads/${baseName}`, `origin/${baseName}`] : []) {
    baseSha = await revParse(git, repoDir, candidate)
    if (baseSha) break
  }
  if (!baseSha && unit?.initialSha && safeRef(unit.initialSha)) {
    baseSha = await revParse(git, repoDir, unit.initialSha)
    baseLabel = unit.initialSha.slice(0, 8)
  }
  if (!baseSha) return { ok: false, reason: 'base_missing', sources }
  const mergeBase = await git(['merge-base', baseSha, headSha], repoDir)
  const fork = mergeBase.code === 0 && /^[0-9a-f]{40,64}$/i.test(mergeBase.stdout.trim()) ? mergeBase.stdout.trim() : baseSha
  const worktree = unit?.worktreePath && fs.existsSync(unit.worktreePath) ? unit.worktreePath : null
  return { ok: true, sources, target: { source, head: source.branch, base: baseLabel, baseSha: fork, headSha, root: worktree ?? repoDir, rootKind: worktree ? 'worktree' : 'repository' } }
}

// ─── Listing ────────────────────────────────────────────────────────────────

const STATUS_BY_LETTER: Record<string, ChangedFileStatus> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' }
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '-M']

/** Parses `git diff --raw -z --no-abbrev` into entries. Exported for tests. */
export function parseRawDiff(out: string): Array<{ status: ChangedFileStatus; path: string; oldPath: string | null; oldSha: string; newSha: string }> {
  const tokens = out.split('\0')
  const files: Array<{ status: ChangedFileStatus; path: string; oldPath: string | null; oldSha: string; newSha: string }> = []
  for (let i = 0; i < tokens.length; i++) {
    const meta = tokens[i]
    if (!meta.startsWith(':')) continue
    const fields = meta.slice(1).split(' ')
    const letter = (fields[4] ?? '')[0] ?? ''
    const status = STATUS_BY_LETTER[letter]
    if (!status) continue
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[++i]
      const path = tokens[++i]
      if (oldPath && path) files.push({ status, path, oldPath, oldSha: fields[2] ?? '', newSha: fields[3] ?? '' })
    } else {
      const path = tokens[++i]
      if (path) files.push({ status, path, oldPath: null, oldSha: fields[2] ?? '', newSha: fields[3] ?? '' })
    }
  }
  return files
}

/** Parses `git diff --numstat -z`; binary files report `-`. Exported for tests. */
export function parseNumstat(out: string): Map<string, { additions: number | null; deletions: number | null }> {
  const tokens = out.split('\0')
  const counts = new Map<string, { additions: number | null; deletions: number | null }>()
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i])
    if (!match) continue
    const additions = match[1] === '-' ? null : Number(match[1])
    const deletions = match[2] === '-' ? null : Number(match[2])
    // A rename/copy has an empty path here and the old/new paths follow as separate tokens.
    const path = match[3] === '' ? (i += 2, tokens[i]) : match[3]
    if (path) counts.set(path, { additions, deletions })
  }
  return counts
}

export async function listChangedFiles(
  target: Pick<ResolvedTarget, 'baseSha' | 'headSha'>, repoDir: string, git: GitRun = defaultGitRun,
): Promise<{ files: ChangedFile[]; truncated: boolean } | null> {
  const range = [target.baseSha, target.headSha]
  const [raw, numstat] = await Promise.all([
    git(['diff', '--raw', '-z', '--no-abbrev', ...DIFF_FLAGS, ...range], repoDir),
    git(['diff', '--numstat', '-z', ...DIFF_FLAGS, ...range], repoDir),
  ])
  if (raw.code !== 0 || numstat.code !== 0) return null
  const counts = parseNumstat(numstat.stdout)
  const entries = parseRawDiff(raw.stdout)
  const files = entries.slice(0, MAX_LISTED_FILES).map((entry): ChangedFile => {
    const count = counts.get(entry.path)
    const binary = count ? count.additions === null && count.deletions === null : false
    return {
      path: entry.path, oldPath: entry.oldPath, status: entry.status,
      additions: count?.additions ?? null, deletions: count?.deletions ?? null, binary,
      hash: `${entry.oldSha.slice(0, 16)}..${entry.newSha.slice(0, 16)}`,
    }
  })
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), truncated: entries.length > MAX_LISTED_FILES }
}

// ─── One file ───────────────────────────────────────────────────────────────

/** Parses a unified diff body (git's `--- / +++` header is skipped). Exported for tests. */
export function parseUnifiedDiff(text: string, lineCap: number): { hunks: DiffHunk[]; truncated: boolean; totalLines: number } {
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let kept = 0
  let total = 0
  let truncated = false
  for (const line of text.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)
    if (header) {
      current = {
        header: line, oldStart: Number(header[1]), oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]), newLines: header[4] === undefined ? 1 : Number(header[4]), lines: [],
      }
      hunks.push(current)
      oldNo = current.oldStart
      newNo = current.newStart
      continue
    }
    if (!current) continue
    const marker = line[0]
    if (marker === '\\') {
      const previous = current.lines[current.lines.length - 1]
      if (previous) previous.noNewline = true
      continue
    }
    if (marker !== ' ' && marker !== '+' && marker !== '-') continue
    total++
    if (kept >= lineCap) { truncated = true; continue }
    kept++
    const textBody = line.slice(1)
    if (marker === '+') current.lines.push({ type: 'add', oldNo: null, newNo: newNo++, text: textBody })
    else if (marker === '-') current.lines.push({ type: 'delete', oldNo: oldNo++, newNo: null, text: textBody })
    else current.lines.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, text: textBody })
  }
  return { hunks: hunks.filter((h) => h.lines.length > 0), truncated, totalLines: total }
}

export async function readFileDiff(
  input: { target: Pick<ResolvedTarget, 'baseSha' | 'headSha'>; repoDir: string; file: ChangedFile; full?: boolean },
  git: GitRun = defaultGitRun,
): Promise<FileDiff | null> {
  const { file } = input
  const base = { path: file.path, oldPath: file.oldPath, status: file.status }
  if (file.binary) return { ...base, binary: true, hunks: [], truncated: false, totalLines: 0 }
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path]
  const res = await git(['diff', '-U3', ...DIFF_FLAGS, input.target.baseSha, input.target.headSha, '--', ...paths], input.repoDir, DIFF_MAX_BUFFER)
  if (res.code !== 0) return null
  // git marks a binary diff that numstat could not (e.g. attributes) with this line.
  if (/^Binary files .* differ$/m.test(res.stdout) && !/^@@ /m.test(res.stdout)) return { ...base, binary: true, hunks: [], truncated: false, totalLines: 0 }
  const parsed = parseUnifiedDiff(res.stdout, input.full ? FULL_DIFF_LINE_CAP : DEFAULT_DIFF_LINE_CAP)
  return { ...base, binary: false, ...parsed }
}

// ─── Annotations ────────────────────────────────────────────────────────────

const REF_RE = /^([^\s:*?"<>|]+?)(?::(\d+)(?:[-–](\d+))?)?$/

/** `path[:line[-end]]` from a risk's free-text `ref`; null when it is not a bare location. */
export function parseLocationRef(ref: string | null | undefined): { path: string; line: number | null; endLine: number | null } | null {
  const match = ref ? REF_RE.exec(ref.trim()) : null
  if (!match || !/[./]/.test(match[1])) return null
  const path = match[1].replace(/\\/g, '/').replace(/^\.\//, '')
  if (path.startsWith('/') || path.split('/').includes('..')) return null
  const line = match[2] ? Number(match[2]) : null
  const endLine = match[3] ? Number(match[3]) : null
  return { path, line: line && line > 0 ? line : null, endLine: line && endLine && endLine > line ? endLine : null }
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Everything the delivery already knows about places in the change: the
 * reviewer's findings (anchored when Core 5.9 named a location), the review
 * brief's risks and untested files, and the comments a follow-up was launched
 * to resolve. Pure over durable rows; unanchored items keep `location: null`.
 */
export function collectAnnotations(row: Pick<RailPrDeliveryRow, 'settle_evidence' | 'follow_up'>): DeliveryAnnotation[] {
  const out: DeliveryAnnotation[] = []
  const evidence = readSettleEvidence(row.settle_evidence)
  for (const unit of evidence?.units ?? []) {
    const runtime = unit.runtime
    const locations = new Map<number, DeliveryFindingLocation>((runtime?.findingLocations ?? []).map((l) => [l.finding, l]))
    ;(runtime?.findings ?? []).forEach((text, index) => {
      const at = locations.get(index)
      out.push({
        id: `finding:${unit.ticketId}:${index}`, source: 'reviewer-finding', text: cap(text, 1200), severity: null, author: null,
        location: at ? { path: at.path, line: at.line ?? null, endLine: at.endLine ?? null } : null,
      })
    })
    const brief = unit.reviewBrief?.brief
    brief?.risks.forEach((risk, index) => {
      const at = parseLocationRef(risk.ref)
      out.push({
        id: `risk:${unit.ticketId}:${index}`, source: 'review-risk', text: cap(risk.whatToLookAt, 1200), severity: risk.severity, author: null,
        location: at,
      })
    })
    brief?.untested.forEach((item, index) => {
      const at = parseLocationRef(item.path)
      if (!at) return
      out.push({
        id: `untested:${unit.ticketId}:${index}`, source: 'review-untested', text: item.why ? cap(item.why, 600) : '', severity: null, author: null,
        location: { path: at.path, line: null, endLine: null },
      })
    })
  }
  const followUp = readFollowUp(row.follow_up)
  followUp?.comments.forEach((comment) => {
    const at = comment.path ? parseLocationRef(comment.path) : null
    out.push({
      id: `comment:${comment.id}`, source: 'follow-up-comment', text: cap(comment.body, FOLLOW_UP_TEXT_CAP), severity: null, author: comment.author,
      location: at && comment.path ? { path: at.path, line: comment.line, endLine: null } : null,
    })
  })
  return out
}

// ─── Composition ────────────────────────────────────────────────────────────

export async function composeDeliveryChanges(
  input: { row: RailPrDeliveryRow; repoDir: string; sourceId?: string | null; repositoryId?: string | null },
  git: GitRun = defaultGitRun,
): Promise<DeliveryChanges> {
  const annotations = collectAnnotations(input.row)
  const resolved = await resolveChangeTarget(input, git)
  if (!resolved.ok) return { available: false, reason: resolved.reason, sources: resolved.sources, annotations }
  const listing = await listChangedFiles(resolved.target, input.repoDir, git)
  if (!listing) return { available: false, reason: 'git_failed', sources: resolved.sources, annotations }
  const totals = listing.files.reduce((sum, file) => ({
    files: sum.files + 1, additions: sum.additions + (file.additions ?? 0), deletions: sum.deletions + (file.deletions ?? 0),
  }), { files: 0, additions: 0, deletions: 0 })
  const { target } = resolved
  return {
    available: true, source: target.source.id, sources: resolved.sources, base: target.base, head: target.head,
    baseSha: target.baseSha, headSha: target.headSha, root: target.root, rootKind: target.rootKind, files: listing.files, truncated: listing.truncated, totals, annotations,
  }
}

export type FileDiffResult =
  | { ok: true; diff: FileDiff }
  | { ok: false; status: 404 | 409 | 500; error: string }

export async function composeFileDiff(
  input: { row: RailPrDeliveryRow; repoDir: string; sourceId?: string | null; repositoryId?: string | null; path: string; full?: boolean },
  git: GitRun = defaultGitRun,
): Promise<FileDiffResult> {
  const resolved = await resolveChangeTarget(input, git)
  if (!resolved.ok) return { ok: false, status: 409, error: resolved.reason }
  const listing = await listChangedFiles(resolved.target, input.repoDir, git)
  if (!listing) return { ok: false, status: 500, error: 'git_failed' }
  // Only a path the diff lists is ever handed to git: the query is a lookup key, not a pathspec.
  const file = listing.files.find((candidate) => candidate.path === input.path)
  if (!file) return { ok: false, status: 404, error: 'file_not_in_changes' }
  const diff = await readFileDiff({ target: resolved.target, repoDir: input.repoDir, file, ...(input.full ? { full: true } : {}) }, git)
  return diff ? { ok: true, diff } : { ok: false, status: 500, error: 'git_failed' }
}
