import { getLinkByLocalId } from './jira/jira-db'
import {
  getLatestTerminalPrDeliveryTouchingTicketSet,
  listActivePrDeliveries,
  toPrDeliverySnapshot,
  type RailPrDeliveryRow,
} from './rail-pr-store'
import { isValidBranchName } from './integration-branch'
import { getRailWorktree } from './rail-worktrees-store'
import type { DbInstance } from './db'
import type { Exec } from './pr-publisher'
import type { GitRunner } from './worktree-manager'
import { isExactOpenPr, observePrLifecycle } from './pr-lifecycle'
import * as fs from 'fs'

export interface ContinuationTicketSpec {
  title?: string | null
  description?: string | null
  status?: string | null
  labels?: string[] | null
  jira_key?: string | null
}

export interface ActivePrContinuationTarget {
  ticketId: number
  /** Durable predecessor generation when this target came from Specrails
   * history. Persisting this lineage prevents same-timestamp terminal history
   * from winning client root election over the new active generation. */
  deliveryId: string | null
  branch: string
  baseBranch: string
  /** Present when origin/<branch> exists; used to create or safely refresh the PR branch. */
  baseRef?: string
  prUrl: string | null
  prNumber: number | null
  isDraft: boolean | null
  /** Immutable OPEN PR head verified with GitHub immediately before worktree
   * allocation. Ledger continuations additionally require that exact SHA to
   * match the commit previously delivered by Specrails. */
  deliverySha: string | null
  source: 'rail-pr-delivery' | 'github-open-pr'
}

export interface ResolveActivePrContinuationInput {
  db: DbInstance
  git: GitRunner
  exec: Exec
  repoDir: string
  ticketIds: number[]
  integrationBranch: string
  fetchOk: boolean
  getTicketSpec: (ticketId: number) => ContinuationTicketSpec | undefined
}

interface OpenPr {
  number?: number
  title?: string
  body?: string | null
  headRefName?: string
  baseRefName?: string
  url?: string
  isDraft?: boolean
  state?: string
}

type PrMatchKind = 'pr-number' | 'jira-key'
const COMMIT_SHA_RE = /^[0-9a-f]{40,64}$/i
const PR_MATCH_RANK: Record<PrMatchKind, number> = {
  'jira-key': 1,
  'pr-number': 3,
}

function parsePrNumber(prUrl: string | null | undefined): number | null {
  if (!prUrl) return null
  const m = /\/pull\/(\d+)/.exec(prUrl)
  return m ? parseInt(m[1], 10) : null
}

function jiraRefs(db: DbInstance, ticketId: number, spec: ContinuationTicketSpec | undefined): string[] {
  const refs = new Set<string>()
  if (spec?.jira_key?.trim()) refs.add(spec.jira_key.trim())
  try {
    const link = getLinkByLocalId(db, ticketId)
    if (link && !link.tombstoned && link.jiraKey) refs.add(link.jiraKey)
  } catch {
    /* tolerated */
  }
  return [...refs]
}

function mentionedPrNumbers(spec: ContinuationTicketSpec | undefined): Set<number> {
  const text = `${spec?.title ?? ''}\n${spec?.description ?? ''}`
  const out = new Set<number>()
  for (const match of text.matchAll(/\b(?:pr|pull request)\s*#?\s*(\d{1,10})\b/gi)) {
    out.add(parseInt(match[1], 10))
  }
  for (const match of text.matchAll(/\/pull\/(\d{1,10})(?:\b|[/?#])/gi)) {
    out.add(parseInt(match[1], 10))
  }
  return out
}

function hasJiraRef(db: DbInstance, ticketId: number, spec: ContinuationTicketSpec | undefined): boolean {
  if (spec?.jira_key?.trim()) return true
  try {
    const link = getLinkByLocalId(db, ticketId)
    return Boolean(link && !link.tombstoned && link.jiraKey)
  } catch {
    return false
  }
}

function prMatchKind(
  db: DbInstance,
  ticketId: number,
  spec: ContinuationTicketSpec | undefined,
  pr: OpenPr,
): PrMatchKind | null {
  const mentionedPrs = mentionedPrNumbers(spec)
  const prNumber = typeof pr.number === 'number' ? pr.number : parsePrNumber(pr.url)
  if (prNumber !== null && mentionedPrs.has(prNumber)) return 'pr-number'

  const haystack = `${pr.title ?? ''}\n${pr.body ?? ''}\n${pr.headRefName ?? ''}`
  for (const key of jiraRefs(db, ticketId, spec)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack)) return 'jira-key'
  }
  return null
}

function canProbeGithubForContinuation(
  db: DbInstance,
  ticketId: number,
  spec: ContinuationTicketSpec | undefined,
): boolean {
  if (spec?.status === 'on_review') return true
  // Jira review can materialize as in_progress when the project has not mapped
  // its exact Review status to Specrails on_review. In that fallback, require a
  // Jira-linked ticket and later only accept explicit PR references.
  return spec?.status === 'in_progress' && hasJiraRef(db, ticketId, spec)
}

async function localBranchExists(git: GitRunner, repoDir: string, branch: string): Promise<boolean> {
  const r = await git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoDir)
  return r.code === 0
}

async function remoteBranchExists(git: GitRunner, repoDir: string, branch: string): Promise<boolean> {
  const r = await git.run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], repoDir)
  return r.code === 0
}

type RefObservation =
  | { state: 'missing' }
  | { state: 'exact'; sha: string }
  | { state: 'invalid' }

async function observeRef(
  git: GitRunner,
  repoDir: string,
  ref: string,
): Promise<RefObservation> {
  try {
    const result = await git.run(['rev-parse', '--verify', '--quiet', ref], repoDir)
    if (result.code === 1) return { state: 'missing' }
    if (result.code !== 0) return { state: 'invalid' }
    const sha = result.stdout.trim().toLowerCase()
    return COMMIT_SHA_RE.test(sha) ? { state: 'exact', sha } : { state: 'invalid' }
  } catch {
    return { state: 'invalid' }
  }
}

async function materializeTarget(
  git: GitRunner,
  repoDir: string,
  fetchOk: boolean,
  ticketId: number,
  branch: string | null | undefined,
  baseBranch: string | null | undefined,
  prUrl: string | null,
  prNumber: number | null,
  isDraft: boolean | null,
  deliverySha: string | null,
  deliveryId: string | null,
  source: ActivePrContinuationTarget['source'],
): Promise<ActivePrContinuationTarget | null> {
  const head = branch?.trim()
  const base = baseBranch?.trim()
  if (!head || !base || head === base) return null
  if (!isValidBranchName(head) || !isValidBranchName(base)) return null

  const remoteRef = fetchOk && await remoteBranchExists(git, repoDir, head) ? `origin/${head}` : undefined
  if (await localBranchExists(git, repoDir, head)) {
    return { ticketId, deliveryId, branch: head, baseBranch: base, baseRef: remoteRef, prUrl, prNumber, isDraft, deliverySha, source }
  }
  if (remoteRef) return { ticketId, deliveryId, branch: head, baseBranch: base, baseRef: remoteRef, prUrl, prNumber, isDraft, deliverySha, source }
  return null
}

function hasRetainedOrUnsettledWorktree(db: DbInstance, worktreeIds: readonly string[]): boolean {
  return worktreeIds.some((id) => {
    const worktree = getRailWorktree(db, id)
    if (!worktree) return false
    return !['released', 'merged', 'failed'].includes(worktree.merge_state) || fs.existsSync(worktree.worktree_path)
  })
}

function internalDeliveryTargets(
  db: DbInstance,
  rows: readonly RailPrDeliveryRow[],
  ticketIds: number[],
): Map<number, ActivePrContinuationTarget> {
  const wanted = new Set(ticketIds)
  const out = new Map<number, ActivePrContinuationTarget>()
  for (const row of rows) {
    const snap = toPrDeliverySnapshot(row)
    if (!snap.prUrl || !snap.branch) continue
    // A still-mounted or unsettled prior worktree can contain bytes not
    // represented by delivery_sha. Never let the next agent iteration absorb
    // them merely because HEAD/ref still happen to match the remote PR.
    if (hasRetainedOrUnsettledWorktree(db, snap.worktreeIds)) continue
    for (const ticketId of snap.ticketIds) {
      if (!wanted.has(ticketId) || out.has(ticketId)) continue
      out.set(ticketId, {
        ticketId,
        deliveryId: row.id,
        branch: snap.branch,
        baseBranch: snap.baseBranch,
        prUrl: snap.prUrl,
        prNumber: snap.prNumber,
        isDraft: snap.decision === 'pr_draft',
        deliverySha: snap.deliverySha,
        source: 'rail-pr-delivery',
      })
    }
  }
  return out
}

function ticketTargetKey(ticketIds: readonly unknown[]): string | null {
  if (ticketIds.length === 0) return null
  const seen = new Set<number>()
  for (const value of ticketIds) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) seen.add(value)
  }
  return seen.size > 0 ? [...seen].sort((a, b) => a - b).join(',') : null
}

function exactTicketTargetKey(ticketIds: readonly unknown[]): string | null {
  const key = ticketTargetKey(ticketIds)
  if (!key || key.split(',').length !== ticketIds.length) return null
  return key
}

interface HistoricalContinuationCandidate {
  deliveryId: string
  branch: string
  baseBranch: string
  prUrl: string
  prNumber: number
  deliverySha: string
}

interface HistoricalContinuationLookup {
  /** An exact terminal continuation owns discovery even when its evidence is
   * malformed or stale. Never downgrade it into a fuzzy GitHub/Jira match. */
  ownsTarget: boolean
  candidate: HistoricalContinuationCandidate | null
}

/** Recover only the newest terminal generation for the exact launch target.
 * A newer fresh/other generation intentionally prevents an older continuation
 * from lending its PR. Of terminal continuations, only an explicitly discarded
 * one can be resumed: merged/completed/superseded history remains history. */
function latestHistoricalContinuation(
  db: DbInstance,
  ticketIds: number[],
): HistoricalContinuationLookup {
  const targetKey = exactTicketTargetKey(ticketIds)
  if (!targetKey) return { ownsTarget: false, candidate: null }
  const latest = getLatestTerminalPrDeliveryTouchingTicketSet(db, ticketIds)
  if (!latest) return { ownsTarget: false, candidate: null }
  // The newest exact-target generation is authoritative even when it is a
  // fresh lineage. It must shadow every older continuation and also prevent a
  // fuzzy GitHub/Jira fallback from rediscovering that stale PR.
  if (latest.is_continuation !== 1) return { ownsTarget: true, candidate: null }
  if (latest.decision !== 'discarded') return { ownsTarget: true, candidate: null }

  const snap = toPrDeliverySnapshot(latest)
  if (exactTicketTargetKey(snap.ticketIds) !== targetKey || latest.operation_token !== null) {
    return { ownsTarget: true, candidate: null }
  }
  if (hasRetainedOrUnsettledWorktree(db, snap.worktreeIds)) {
    return { ownsTarget: true, candidate: null }
  }
  const branch = snap.branch
  const baseBranch = snap.baseBranch
  const prUrl = snap.prUrl
  const deliverySha = snap.deliverySha?.toLowerCase() ?? null
  if (
    !branch || branch.trim() !== branch || !isValidBranchName(branch) ||
    !baseBranch || baseBranch.trim() !== baseBranch || !isValidBranchName(baseBranch) ||
    branch === baseBranch ||
    !prUrl || prUrl.trim() !== prUrl ||
    snap.prNumber === null || parsePrNumber(prUrl) !== snap.prNumber ||
    !deliverySha || !COMMIT_SHA_RE.test(deliverySha)
  ) return { ownsTarget: true, candidate: null }

  return {
    ownsTarget: true,
    candidate: { deliveryId: latest.id, branch, baseBranch, prUrl, prNumber: snap.prNumber, deliverySha },
  }
}

/** Historical recovery is stricter than ordinary active continuation
 * materialization. Every available fetched/local ref must still name the exact
 * immutable GitHub head; a stale, ahead, diverged, or unreadable ref fails
 * closed rather than allowing worktree allocation to infer or rewrite it. */
async function materializeHistoricalContinuation(
  input: ResolveActivePrContinuationInput,
  candidate: HistoricalContinuationCandidate,
  isDraft: boolean,
): Promise<Map<number, ActivePrContinuationTarget> | null> {
  const local = await observeRef(input.git, input.repoDir, `refs/heads/${candidate.branch}`)
  if (local.state === 'invalid' || (local.state === 'exact' && local.sha !== candidate.deliverySha)) return null

  const remote = input.fetchOk
    ? await observeRef(input.git, input.repoDir, `refs/remotes/origin/${candidate.branch}`)
    : { state: 'missing' as const }
  if (remote.state === 'invalid' || (remote.state === 'exact' && remote.sha !== candidate.deliverySha)) return null
  if (local.state !== 'exact' && remote.state !== 'exact') return null

  return new Map(input.ticketIds.map((ticketId) => [ticketId, {
    ticketId,
    deliveryId: candidate.deliveryId,
    branch: candidate.branch,
    baseBranch: candidate.baseBranch,
    ...(remote.state === 'exact' ? { baseRef: `origin/${candidate.branch}` } : {}),
    prUrl: candidate.prUrl,
    prNumber: candidate.prNumber,
    isDraft,
    deliverySha: candidate.deliverySha,
    source: 'rail-pr-delivery' as const,
  }]))
}

const PR_JSON_FIELDS = 'number,title,body,headRefName,baseRefName,url,isDraft,state'

async function listOpenPrs(exec: Exec, repoDir: string): Promise<OpenPr[]> {
  const r = await exec.run('gh', ['pr', 'list', '--state', 'open', '--limit', '200', '--json', PR_JSON_FIELDS], repoDir)
  if (r.code !== 0) return []
  try {
    const parsed = JSON.parse(r.stdout) as unknown
    return Array.isArray(parsed) ? parsed as OpenPr[] : []
  } catch {
    return []
  }
}

async function viewOpenPr(exec: Exec, repoDir: string, prNumber: number): Promise<OpenPr | null> {
  const r = await exec.run('gh', ['pr', 'view', String(prNumber), '--json', PR_JSON_FIELDS], repoDir)
  if (r.code !== 0) return null
  try {
    const parsed = JSON.parse(r.stdout) as OpenPr
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (typeof parsed.state === 'string' && parsed.state.toUpperCase() !== 'OPEN') return null
    return parsed
  } catch {
    return null
  }
}

async function mentionedOpenPrs(exec: Exec, repoDir: string, prNumbers: Set<number>): Promise<OpenPr[]> {
  const out: OpenPr[] = []
  for (const prNumber of prNumbers) {
    const pr = await viewOpenPr(exec, repoDir, prNumber)
    if (pr) out.push(pr)
  }
  return out
}

function mergeOpenPrs(prs: OpenPr[]): OpenPr[] {
  const out: OpenPr[] = []
  const seen = new Set<string>()
  for (const pr of prs) {
    const key = typeof pr.number === 'number' ? `n:${pr.number}` : pr.url ? `u:${pr.url}` : null
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    out.push(pr)
  }
  return out
}

/**
 * Detects tickets whose next implementation pass should continue an already
 * open PR branch instead of creating fresh work from the integration branch.
 * External discovery is fail-open when no durable Specrails lineage exists.
 * Once an active or newest overlapping historical generation owns the target,
 * however, missing/ambiguous GitHub or ref evidence is authoritative negative
 * evidence and blocks fuzzy fallback to a different PR.
 */
export async function resolveActivePrContinuationTargets(
  input: ResolveActivePrContinuationInput,
): Promise<Map<number, ActivePrContinuationTarget>> {
  const out = new Map<number, ActivePrContinuationTarget>()
  const activeRows = listActivePrDeliveries(input.db)
  const internal = internalDeliveryTargets(input.db, activeRows, input.ticketIds)
  const lifecycleByUrl = new Map<string, ReturnType<typeof observePrLifecycle>>()
  for (const [ticketId, target] of internal) {
    if (!target.prUrl) continue
    let lifecycle = lifecycleByUrl.get(target.prUrl)
    if (!lifecycle) {
      lifecycle = observePrLifecycle(input.exec, input.repoDir, target.prUrl, target.deliverySha)
      lifecycleByUrl.set(target.prUrl, lifecycle)
    }
    const observed = await lifecycle
    // A ledger row is only a hint. GitHub remains lifecycle authority: a stale
    // draft/ready row for a CLOSED/MERGED or different head/base PR must not be
    // superseded and must not lend its branch to another implementation run.
    if (
      !target.deliverySha || !observed.ok ||
      !isExactOpenPr(observed, target.branch, target.baseBranch) ||
      observed.includesExpectedSha !== true ||
      observed.headRefOid?.toLowerCase() !== target.deliverySha.toLowerCase()
    ) continue
    const materialized = await materializeTarget(
      input.git,
      input.repoDir,
      input.fetchOk,
      ticketId,
      target.branch,
      target.baseBranch,
      target.prUrl,
      target.prNumber,
      observed.isDraft,
      target.deliverySha,
      target.deliveryId,
      'rail-pr-delivery',
    )
    if (materialized) out.set(ticketId, materialized)
  }

  // Dismiss/Discard closes the continuation generation but deliberately keeps
  // its borrowed PR alive. Recover that exact target only when no active row
  // owns any requested ticket and the latest terminal generation for the whole
  // target is the discarded continuation. Failed historical verification is
  // still authoritative negative evidence: do not fall through to fuzzy PR
  // discovery and accidentally borrow a same-Jira foreign PR.
  const wanted = new Set(input.ticketIds)
  const activeTouchesTarget = activeRows.some((row) => (
    toPrDeliverySnapshot(row).ticketIds.some((ticketId) => wanted.has(ticketId))
  ))
  const historicalOwned = new Set<number>()
  const activeOwned = new Set<number>()
  if (activeTouchesTarget) input.ticketIds.forEach((ticketId) => activeOwned.add(ticketId))
  if (!activeTouchesTarget && out.size === 0) {
    const historical = latestHistoricalContinuation(input.db, input.ticketIds)
    if (historical.ownsTarget) input.ticketIds.forEach((ticketId) => historicalOwned.add(ticketId))
    if (historical.candidate) {
      const candidate = historical.candidate
      let lifecycle = lifecycleByUrl.get(candidate.prUrl)
      if (!lifecycle) {
        lifecycle = observePrLifecycle(input.exec, input.repoDir, candidate.prUrl, candidate.deliverySha)
        lifecycleByUrl.set(candidate.prUrl, lifecycle)
      }
      const observed = await lifecycle
      if (
        observed.ok &&
        isExactOpenPr(observed, candidate.branch, candidate.baseBranch) &&
        observed.headRefOid?.toLowerCase() === candidate.deliverySha &&
        observed.includesExpectedSha === true
      ) {
        const materialized = await materializeHistoricalContinuation(input, candidate, observed.isDraft)
        if (materialized) {
          for (const [ticketId, target] of materialized) out.set(ticketId, target)
        }
      }
    }
  }

  // A durable Specrails delivery that fails exact verification must never be
  // downgraded into an inferred "external" match for the same ticket/PR. The
  // visible delivery card owns reconciliation of that stale immutable SHA.
  const remaining = input.ticketIds.filter((id) => (
    !out.has(id) && !internal.has(id) && !historicalOwned.has(id) && !activeOwned.has(id)
  ))
  const candidateIds = remaining.filter((id) => canProbeGithubForContinuation(input.db, id, input.getTicketSpec(id)))
  if (candidateIds.length === 0) return out

  const mentionedPrs = new Set<number>()
  for (const ticketId of candidateIds) {
    for (const prNumber of mentionedPrNumbers(input.getTicketSpec(ticketId))) mentionedPrs.add(prNumber)
  }
  const openPrs = mergeOpenPrs([
    ...await listOpenPrs(input.exec, input.repoDir),
    ...await mentionedOpenPrs(input.exec, input.repoDir, mentionedPrs),
  ])
  for (const ticketId of candidateIds) {
    const spec = input.getTicketSpec(ticketId)
    const matches = openPrs.flatMap((pr) => {
      const kind = prMatchKind(input.db, ticketId, spec, pr)
      return kind ? [{ pr, kind }] : []
    })
    if (matches.length === 0) continue
    const bestRank = Math.max(...matches.map((m) => PR_MATCH_RANK[m.kind]))
    const best = matches.filter((m) => PR_MATCH_RANK[m.kind] === bestRank)
    if (best.length !== 1) continue
    const pr = best[0].pr
    const prUrl = pr.url?.trim()
    const branch = pr.headRefName?.trim()
    const baseBranch = pr.baseRefName?.trim() || input.integrationBranch
    if (!prUrl || !branch || !baseBranch) continue
    let lifecycle = lifecycleByUrl.get(prUrl)
    if (!lifecycle) {
      lifecycle = observePrLifecycle(input.exec, input.repoDir, prUrl)
      lifecycleByUrl.set(prUrl, lifecycle)
    }
    const observed = await lifecycle
    // `gh pr list` is discovery evidence only. Freeze the exact live remote
    // head through an authoritative view before borrowing any local branch;
    // otherwise an unrelated local-ahead commit could be carried into the PR.
    if (!observed.ok || !observed.headRefOid || !isExactOpenPr(observed, branch, baseBranch)) continue
    const materialized = await materializeTarget(
      input.git,
      input.repoDir,
      input.fetchOk,
      ticketId,
      branch,
      baseBranch,
      prUrl,
      typeof pr.number === 'number' ? pr.number : parsePrNumber(prUrl),
      observed.isDraft,
      observed.headRefOid,
      null,
      'github-open-pr',
    )
    if (materialized) out.set(ticketId, materialized)
  }
  return out
}
