/**
 * Execute a user's ask-first PR decision (safe-pr-review-flow) against its
 * authoritative `rail_pr_deliveries` row: the FOUR actions both decision
 * surfaces (the dashboard rail row and the launching agent-chat card) POST to
 * `/rails/pr-decision`.
 *
 *   create-pr  → deferred deliverRailAsPr, reconstructed from the row's durable
 *                columns (nothing survives in memory after build-settle). The
 *                PR title/body are composed HERE (canonical OSS style — see
 *                pr-naming/pr-body) from the ticket store + jira_links + the
 *                branch diffs, all failure-tolerant.
 *   publish    → `gh pr ready` opens the draft for team review.
 *   discard    → close the PR, sweep the launch's worktrees + branches, revert
 *                the on_review tickets to todo.
 *   poll-merge → `gh pr view` — MERGED promotes the tickets to done.
 *   merge-local→ the REMOTE-LESS acceptance path: merge the delivered branches
 *                into the integration branch directly in the user's checkout
 *                (guarded: correct branch checked out + clean tree, abort on
 *                conflict). Without it, a repo with no GitHub remote wedges
 *                forever in retry(local-only)/discard — no way to ACCEPT work.
 *
 * Every mutation rides the compare-and-set `transitionDecision` (a raced
 * concurrent decision loses with a 409) and re-broadcasts the durable
 * `rail.pr_state` snapshot so both surfaces converge; agent-chat-originated
 * rows also update their inline decision card in place. Deps are injected
 * (db/git/exec/broadcast/jira/agent-chat) so the whole matrix is unit-testable
 * without git/gh/net — the route in rails-router validates and delegates here.
 */
import * as path from 'path'
import { resolveHome } from './artifact-registry'
import type { DbInstance } from './db'
import { removeWorktree, type GitRunner } from './worktree-manager'
import { pushBranch, type Exec, type ExecResult } from './pr-publisher'
import { deliverRailAsPr } from './rail-pr-delivery'
import { releaseRailWorktrees } from './rail-worktree-release'
import { batchBranchNameFor, buildPrTitle, type TicketNamingInput } from './pr-naming'
import { buildCanonicalPrBody, collectBranchChanges, type BranchChanges } from './pr-body'
import { getLinkByLocalId } from './jira/jira-db'
import {
  getPrDelivery, transitionDecision, toPrDeliverySnapshot, toRailPrStateMessage, toPrDecisionCardEnvelope,
  type DeliverBranchRecord, type PrDecision, type PrDeliveryPatch, type PrDeliverySnapshot, type RailPrDeliveryRow,
} from './rail-pr-store'
import { getRailWorktree, updateRailWorktreeState, isTerminalMergeState, listRailWorktreesForTicket } from './rail-worktrees-store'
import { mutateStore, readStore, resolveTicketStoragePath } from './ticket-store'
import { resolveProjectExecution } from './workspace-resolution'
import { getAgentChatManager } from './agent-chat-registry'
import type { WsMessage, TicketUpdatedMessage, PrDecisionCardEnvelope } from './types'

export const PR_DECISION_ACTIONS = ['create-pr', 'publish', 'discard', 'poll-merge', 'merge-local'] as const
export type PrDecisionAction = (typeof PR_DECISION_ACTIONS)[number]

export function isPrDecisionAction(v: unknown): v is PrDecisionAction {
  return typeof v === 'string' && (PR_DECISION_ACTIONS as readonly string[]).includes(v)
}

export interface PrDecisionDeps {
  db: DbInstance
  project: { id: string; slug: string; path: string }
  git: GitRunner
  exec: Exec
  broadcast: (msg: WsMessage) => void
  /** Optional (tests / partial contexts); calls are best-effort and never fatal. */
  jiraSyncManager?: {
    onRailMerged(ticketIds: number[], refId: string, prUrl: string | null): void
    onRailDiscard(ticketIds: number[], refId: string): void
  }
  /** Agent-chat accessor (default: the process-wide registry). Null-safe. */
  agentChat?: () => { updatePrDecisionCard(conversationId: string, envelope: PrDecisionCardEnvelope): void } | null
  /** Ticket-store file override (tests) — default resolves via workspace-resolution. */
  ticketFile?: string
}

export interface PrDecisionInput {
  prDeliveryId: string
  action: PrDecisionAction
  expectedDecision: string
}

/** HTTP-shaped outcome the route relays verbatim. */
export interface PrDecisionResult {
  status: number
  body: Record<string, unknown>
}

function staleDecision(current: string): PrDecisionResult {
  return { status: 409, body: { error: 'stale_decision', current } }
}

function illegalAction(current: string): PrDecisionResult {
  return { status: 409, body: { error: 'stale_decision', current, reason: 'illegal_action' } }
}

function ghFailed(r: ExecResult): PrDecisionResult {
  const detail = (r.stderr.trim() || r.stdout.trim()).split('\n')[0] || `exit ${r.code}`
  return { status: 502, body: { error: 'gh_failed', detail } }
}

/**
 * The D3 state machine's action legality. `create-pr` is also the RETRY path:
 * from a retryable pr_failed, or from a pr_draft whose delivery degraded before
 * a PR existed (pushed/local-only → pr_url null). Publish/poll require a real
 * PR URL — a degraded draft only offers retry or discard.
 */
function actionAllowed(action: PrDecisionAction, row: RailPrDeliveryRow): boolean {
  switch (action) {
    case 'create-pr':
      return row.decision === 'on_review' || row.decision === 'pr_failed' ||
        (row.decision === 'pr_draft' && row.pr_url === null)
    case 'publish':
      return row.decision === 'pr_draft' && row.pr_url !== null
    case 'discard':
      return row.decision === 'on_review' || row.decision === 'pr_draft' ||
        row.decision === 'pr_ready' || row.decision === 'implementation_failed' ||
        row.decision === 'pr_failed'
    case 'poll-merge':
      return (row.decision === 'pr_draft' || row.decision === 'pr_ready') && row.pr_url !== null
    case 'merge-local':
      // Remote-less acceptance ONLY: once a real PR exists (pr_url), GitHub is
      // the merge authority — merging under an open PR would leave it dangling.
      return row.pr_url === null &&
        (row.decision === 'on_review' || row.decision === 'pr_failed' || row.decision === 'pr_draft')
  }
}

export async function executePrDecision(deps: PrDecisionDeps, input: PrDecisionInput): Promise<PrDecisionResult> {
  const row = getPrDelivery(deps.db, input.prDeliveryId)
  if (!row) return { status: 404, body: { error: 'Unknown prDeliveryId' } }

  // Compare-and-set pre-check: the caller decided against a snapshot — if the
  // row moved on (the other surface answered first), it must reconcile, not act.
  if (row.decision !== input.expectedDecision) return staleDecision(row.decision)
  if (!actionAllowed(input.action, row)) return illegalAction(row.decision)

  switch (input.action) {
    case 'create-pr': return runCreatePr(deps, row)
    case 'publish': return runPublish(deps, row)
    case 'discard': return runDiscard(deps, row)
    case 'poll-merge': return runPollMerge(deps, row)
    case 'merge-local': return runMergeLocal(deps, row)
  }
}

/**
 * Atomic CAS transition; a `false` return means a concurrent mutation raced us
 * between the pre-check and here — surface the same 409 with the fresh state.
 */
function casTransition(deps: PrDecisionDeps, row: RailPrDeliveryRow, next: PrDecision, patch: PrDeliveryPatch = {}): PrDecisionResult | null {
  if (transitionDecision(deps.db, row.id, row.decision, next, patch)) return null
  const current = getPrDelivery(deps.db, row.id)
  return staleDecision(current?.decision ?? row.decision)
}

/**
 * Post-transition fan-out: re-broadcast the durable rail.pr_state snapshot
 * (both surfaces converge on it) and, for agent-chat-originated launches,
 * update the persisted inline card in place.
 */
function finalizeTransition(deps: PrDecisionDeps, id: string): PrDeliverySnapshot | undefined {
  const row = getPrDelivery(deps.db, id)
  if (!row) return undefined
  const snap = toPrDeliverySnapshot(row)
  deps.broadcast(toRailPrStateMessage(deps.project.id, snap))
  if (row.origin_conversation_id) {
    const agent = (deps.agentChat ?? getAgentChatManager)()
    // Shared mapper (rail-pr-store.toPrDecisionCardEnvelope) — the SAME shape
    // rail-isolated-launch's origin-card sync posts, so the two card-writing
    // sites (incl. the runIds chip data) can never drift.
    agent?.updatePrDecisionCard(row.origin_conversation_id, toPrDecisionCardEnvelope(deps.project.id, snap))
  }
  return snap
}

function parsePrNumber(prUrl: string): number | null {
  const m = /\/pull\/(\d+)/.exec(prUrl)
  return m ? parseInt(m[1], 10) : null
}

function batchWorktreeRoot(slug: string): string {
  // Mirrors rail-isolated-launch's worktreesRoot — derivable, never stored.
  return path.join(resolveHome(), '.specrails', 'projects', slug, 'worktrees')
}

async function resolveExistingPrDecisionAfterPush(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<'pr_draft' | 'pr_ready'> {
  if (!row.pr_url) return 'pr_ready'
  const r = await deps.exec.run('gh', ['pr', 'view', row.pr_url, '--json', 'isDraft,state'], deps.project.path)
  if (r.code !== 0) return 'pr_ready'
  try {
    const parsed = JSON.parse(r.stdout) as { isDraft?: unknown; state?: unknown }
    if (parsed.isDraft === true) return 'pr_draft'
  } catch {
    /* fall through to the conservative published/open state */
  }
  return 'pr_ready'
}

async function retryExistingPrFollowupPush(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  if (!row.branch || !row.pr_url) return { status: 502, body: { error: 'push_failed', detail: 'missing PR branch/url' } }
  const pushed = await pushBranch(deps.exec, {
    repoDir: deps.project.path,
    branch: row.branch,
    baseBranch: row.base_branch,
  })
  if (pushed.state === 'local-only') {
    const conflict = casTransition(deps, row, 'pr_failed', { prState: 'local-only' })
    if (conflict) return conflict
    finalizeTransition(deps, row.id)
    return { status: 200, body: { ok: true, decision: 'pr_failed', prUrl: row.pr_url, detail: pushed.reason } }
  }

  const next = await resolveExistingPrDecisionAfterPush(deps, row)
  const snap = toPrDeliverySnapshot(row)
  const conflict = casTransition(deps, row, next, { prState: 'pr-created' })
  if (conflict) return conflict
  await releaseRailWorktrees({ db: deps.db, git: deps.git, repoDir: deps.project.path, worktreeIds: snap.worktreeIds })
  const after = finalizeTransition(deps, row.id)
  return { status: 200, body: { ok: true, decision: next, prUrl: after?.prUrl ?? row.pr_url, prState: 'pr-created' } }
}

/** Naming + body data for a PR's ticket, resolved at create-pr time. */
interface PrTicketData extends TicketNamingInput {
  description?: string | null
}

/**
 * Load the PR's ticket data (title/labels/description) from the ticket store,
 * with the Jira key resolved PER TICKET: the authoritative `jira_links` row
 * prevails over the ticket's `jira_key` field (JIRA ALWAYS PREVAILS), no HTTP.
 * Tolerant of a missing/corrupt store or link table — degrades to bare local
 * ids, never throws, never blocks PR creation.
 */
function loadPrTicketData(deps: PrDecisionDeps, ticketIds: number[]): PrTicketData[] {
  let tickets: Record<string, { title?: string; description?: string; labels?: string[]; jira_key?: string | null }> = {}
  try {
    tickets = readStore(resolveTicketFile(deps)).tickets as typeof tickets
  } catch {
    /* tolerated — the PR falls back to bare ticket refs */
  }
  return ticketIds.map((id) => {
    const t = tickets[String(id)]
    let jiraKey: string | null = t?.jira_key ?? null
    try {
      const link = getLinkByLocalId(deps.db, id)
      if (link && !link.tombstoned && link.jiraKey) jiraKey = link.jiraKey
    } catch {
      /* tolerated — fall back to the ticket field */
    }
    return {
      ticketId: id,
      title: t?.title ?? null,
      labels: t?.labels ?? null,
      description: t?.description ?? null,
      jiraKey,
    }
  })
}

/** True when the branch exists as a local ref in the base repo. */
async function branchExists(deps: PrDecisionDeps, branch: string): Promise<boolean> {
  const r = await deps.git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], deps.project.path)
  return r.code === 0
}

/**
 * Recovery for a recorded unit branch that no longer exists (the wedged
 * local-only retry: the settled record drifted from the branch that really
 * carries the commits, or the branch was deleted externally). Scan the ticket's
 * rail_worktrees ledger (newest first) for ANY other branch a rail allocated
 * for the same ticket that still exists AND has commits ahead of the base —
 * that branch is the real carrier of the work. Null when nothing recoverable.
 */
async function findRecoverableBranch(
  deps: PrDecisionDeps,
  unit: DeliverBranchRecord,
  baseBranch: string,
): Promise<string | null> {
  let candidates: ReturnType<typeof listRailWorktreesForTicket> = []
  try {
    candidates = listRailWorktreesForTicket(deps.db, unit.ticketId)
  } catch {
    return null
  }
  for (const wt of candidates) {
    if (!wt.branch || wt.branch === unit.branch || wt.branch === baseBranch) continue
    if (!(await branchExists(deps, wt.branch))) continue
    const ahead = await deps.git.run(['rev-list', '--count', `${baseBranch}..${wt.branch}`], deps.project.path)
    const n = ahead.code === 0 ? parseInt(ahead.stdout.trim(), 10) : NaN
    if (Number.isFinite(n) && n > 0) return wt.branch
  }
  return null
}

async function runCreatePr(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  if (row.decision === 'pr_failed' && row.pr_url && row.branch) {
    return retryExistingPrFollowupPush(deps, row)
  }

  const snap = toPrDeliverySnapshot(row)

  // Pre-flight: every succeeded unit branch must actually exist before we push
  // it — a missing ref can only degrade to local-only again, so a retry on a
  // wedged row would loop forever. When a recorded branch is gone, recover the
  // REAL branch from the ticket's worktree ledger (see findRecoverableBranch)
  // and persist the substitution on the row; unrecoverable → honest pr_failed.
  let effectiveBranches = snap.branches
  let branchesRecovered = false
  for (const unit of snap.branches) {
    if (!unit.succeeded) continue
    if (await branchExists(deps, unit.branch)) continue
    const real = await findRecoverableBranch(deps, unit, row.base_branch)
    if (!real) {
      const detail = `branch '${unit.branch}' (ticket #${unit.ticketId}) no longer exists locally and no other rail branch for the ticket holds commits — nothing to deliver`
      const conflict = casTransition(deps, row, 'pr_failed')
      if (conflict) return conflict
      finalizeTransition(deps, row.id)
      return { status: 200, body: { ok: true, decision: 'pr_failed', detail } }
    }
    console.warn(`[rail-pr-decision] recorded branch '${unit.branch}' missing — recovered '${real}' from the ticket ${unit.ticketId} worktree ledger`)
    effectiveBranches = effectiveBranches.map((b) => (b === unit ? { ...b, branch: real } : b))
    branchesRecovered = true
  }

  // Succeeded COVERED tickets for the PR title/body: a single unit covers every
  // launch ticket (scope='all'), per-ticket units cover exactly their own.
  const succeededUnits = effectiveBranches.filter((b) => b.succeeded)
  const succeededTicketIds =
    effectiveBranches.length === 1 && succeededUnits.length === 1
      ? snap.ticketIds
      : succeededUnits.map((b) => b.ticketId)

  const ticketData = loadPrTicketData(deps, succeededTicketIds)
  // The batch name is derived ONLY for multi-unit deliveries — the single-ticket
  // path delivers straight from its unit branch and must never even compute one.
  const batchPreferred = succeededUnits.length > 1 ? batchBranchNameFor(ticketData) : null

  // Retry hazard: deliverRailAsPr assembles with `worktree add -b` (no -B) and a
  // prior degraded delivery KEEPS the batch branch — so a retry would die on
  // "branch already exists". Defensively drop the stale batch branch first
  // (batch deliveries only). HARD GUARDS: NEVER a branch present in the row's
  // unit records (deleting one would destroy the commits about to be delivered)
  // and NEVER the integration branch; a missing branch is tolerated.
  const unitBranches = new Set(effectiveBranches.map((b) => b.branch))
  if (batchPreferred && batchPreferred !== row.base_branch && !unitBranches.has(batchPreferred)) {
    await deps.git.run(['branch', '-D', batchPreferred], deps.project.path).catch(() => {})
  }

  // Per-ticket covering branch for the body's honest Tests digest: per-ticket
  // units map 1:1; a single 'all'-scope unit covers every launch ticket.
  const branchFor = (ticketId: number): string | null => {
    const unit = succeededUnits.find((b) => b.ticketId === ticketId)
    if (unit) return unit.branch
    return succeededUnits.length === 1 ? succeededUnits[0].branch : null
  }

  // Diffstats are best-effort: a git failure degrades the body (section
  // omitted / "diff unavailable" note), never blocks the PR.
  let changes: Map<string, BranchChanges> | null = null
  try {
    changes = await collectBranchChanges(deps.git, deps.project.path, row.base_branch, succeededUnits.map((b) => b.branch))
  } catch {
    changes = null
  }

  const title = buildPrTitle(ticketData, { loopName: row.loop_name })
  const body = buildCanonicalPrBody({
    loopName: row.loop_name,
    baseBranch: row.base_branch,
    tickets: ticketData.map((t) => ({ ...t, branch: branchFor(t.ticketId) })),
    changes,
  })

  let next: PrDecision
  // Underlying git/gh failure detail for a degraded or failed delivery —
  // relayed on the response body so the decision surfaces can say WHY instead
  // of a bare "retry". Never persisted (the durable columns stay state-only).
  let detail: string | null = null
  const patch: PrDeliveryPatch = {}
  // Persist any pre-flight substitution so the row records the branch that
  // actually carries the commits — the next retry/discard works from reality.
  if (branchesRecovered) patch.branches = effectiveBranches
  try {
    const result = await deliverRailAsPr(deps.git, deps.exec, {
      baseRepo: deps.project.path,
      integrationBranch: row.base_branch,
      railKey: row.rail_key,
      batchBranch: batchPreferred ?? undefined,
      batchWorktreeRoot: batchWorktreeRoot(deps.project.slug),
      branches: effectiveBranches,
      title,
      body,
    })
    if (result.state === 'delivered') {
      next = 'pr_draft'
      patch.branch = result.branch
      patch.prState = result.pr.state
      if (result.pr.state === 'pr-created' && result.pr.prUrl) {
        patch.prUrl = result.pr.prUrl
        patch.prNumber = parsePrNumber(result.pr.prUrl)
      } else {
        // Degraded (pushed / local-only): no PR exists — only retry or discard.
        patch.prUrl = null
        patch.prNumber = null
        detail = result.pr.reason ?? null
      }
    } else {
      // 'assembly-failed' (or an unexpected 'no-op' — settle guarantees ≥1
      // succeeded unit, but a wedged row must not 500) → retryable failure.
      next = 'pr_failed'
      detail = result.reason
    }
  } catch (err) {
    // publishDraftPr can propagate GitGuardrailError — a guardrail violation is
    // a retryable delivery failure, never a crash.
    console.error('[rail-pr-decision] create-pr delivery failed:', err)
    next = 'pr_failed'
    detail = err instanceof Error ? err.message : String(err)
  }

  const conflict = casTransition(deps, row, next, patch)
  if (conflict) return conflict
  if (next === 'pr_draft' && patch.prUrl) {
    await releaseRailWorktrees({ db: deps.db, git: deps.git, repoDir: deps.project.path, worktreeIds: snap.worktreeIds })
  }
  const after = finalizeTransition(deps, row.id)
  // Tickets stay on_review — a draft PR is still awaiting the engineer's merge.
  return {
    status: 200,
    body: {
      ok: true,
      decision: next,
      prUrl: after?.prUrl ?? null,
      prState: after?.prState ?? row.pr_state,
      ...(detail ? { detail } : {}),
    },
  }
}

async function runPublish(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  const r = await deps.exec.run('gh', ['pr', 'ready', row.pr_url!], deps.project.path)
  if (r.code !== 0) return ghFailed(r) // no transition — the draft is still a draft
  const snap = toPrDeliverySnapshot(row)
  const conflict = casTransition(deps, row, 'pr_ready')
  if (conflict) return conflict
  await releaseRailWorktrees({ db: deps.db, git: deps.git, repoDir: deps.project.path, worktreeIds: snap.worktreeIds })
  finalizeTransition(deps, row.id)
  return { status: 200, body: { ok: true, decision: 'pr_ready', prUrl: row.pr_url } }
}

async function runDiscard(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  const snap = toPrDeliverySnapshot(row)
  const implementationFailed = row.decision === 'implementation_failed'

  // 1. Close the PR (drops its head branch) when one exists. Best-effort — a
  //    gh failure must never leave the discard half-done.
  //
  // Implementation-failed rows are different: the implement run produced no
  // deliverable update. If the row belongs to an existing-PR continuation it may
  // still carry that PR's url/branch from launch time; clearing the failed card
  // must not close or delete the user's existing review branch.
  if (row.pr_url && !implementationFailed) {
    try {
      const r = await deps.exec.run('gh', ['pr', 'close', row.pr_url, '--delete-branch'], deps.project.path)
      if (r.code !== 0) {
        console.warn(`[rail-pr-decision] gh pr close failed (continuing discard): ${(r.stderr.trim() || r.stdout.trim()).split('\n')[0]}`)
      }
    } catch (err) {
      console.warn('[rail-pr-decision] gh pr close threw (continuing discard):', err)
    }
  }

  // 2. Remove the launch's worktrees (still on disk unless a restart already
  //    swept them) and close their ledger rows — the reconcile-style removal,
  //    branch deletion deferred to step 3 (a checked-out branch can't be -D'd).
  const branchSet = new Set<string>(implementationFailed ? [] : snap.branches.map((b) => b.branch))
  for (const wtId of snap.worktreeIds) {
    const wt = getRailWorktree(deps.db, wtId)
    if (!wt) continue
    if (!implementationFailed) branchSet.add(wt.branch)
    try {
      await removeWorktree(deps.git, {
        repoDir: deps.project.path, worktreePath: wt.worktree_path, branch: wt.branch, deleteBranch: false,
      })
    } catch (err) {
      console.warn(`[rail-pr-decision] discard could not remove worktree ${wt.worktree_path}: ${(err as Error).message}`)
      continue
    }
    if (!isTerminalMergeState(wt.merge_state)) updateRailWorktreeState(deps.db, wt.id, 'failed')
  }

  // 3. Delete every branch the delivery references: per-unit source branches,
  //    the assembled head and the (possibly stale) batch branch — recomputed
  //    best-effort from the same ticket data the create-pr path names it from
  //    (the delivered head is already covered by row.branch). Missing branches
  //    are tolerated; the integration branch is NEVER deleted.
  if (!implementationFailed) {
    if (row.branch) branchSet.add(row.branch)
    const succeededUnits = snap.branches.filter((b) => b.succeeded)
    if (succeededUnits.length > 1) {
      try {
        branchSet.add(batchBranchNameFor(loadPrTicketData(deps, succeededUnits.map((b) => b.ticketId))))
      } catch {
        /* best-effort defense-in-depth only */
      }
    }
    for (const branch of branchSet) {
      if (!branch || branch === row.base_branch) continue
      await deps.git.run(['branch', '-D', branch], deps.project.path).catch(() => {})
    }
  }

  const conflict = casTransition(deps, row, 'discarded')
  if (conflict) return conflict
  finalizeTransition(deps, row.id)

  // 4. Revert the parked tickets to the backlog + mirror to Jira (outbox-only;
  //    the local write above is ours).
  const changed = applyTicketTransition(deps, snap.ticketIds, 'todo')
  try {
    deps.jiraSyncManager?.onRailDiscard(changed, row.id)
  } catch (err) {
    console.error('[rail-pr-decision] jira onRailDiscard failed:', err)
  }
  return { status: 200, body: { ok: true, decision: 'discarded' } }
}

async function runPollMerge(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  const r = await deps.exec.run('gh', ['pr', 'view', row.pr_url!, '--json', 'state,mergedAt'], deps.project.path)
  if (r.code !== 0) return ghFailed(r) // no transition
  let state: string | undefined
  try {
    state = (JSON.parse(r.stdout) as { state?: string }).state
  } catch {
    return { status: 502, body: { error: 'gh_failed', detail: 'unparseable gh pr view output' } }
  }
  if (state !== 'MERGED') {
    // Not merged (OPEN/CLOSED/unknown) → observation only, nothing changes.
    return { status: 200, body: { ok: true, decision: row.decision, merged: false } }
  }

  const snap = toPrDeliverySnapshot(row)
  const branchSet = new Set<string>(snap.branches.map((b) => b.branch))
  if (row.branch) branchSet.add(row.branch)
  const succeededUnits = snap.branches.filter((b) => b.succeeded)
  if (succeededUnits.length > 1) {
    try {
      branchSet.add(batchBranchNameFor(loadPrTicketData(deps, succeededUnits.map((b) => b.ticketId))))
    } catch {
      /* best-effort cleanup only */
    }
  }
  await releaseRailWorktrees({ db: deps.db, git: deps.git, repoDir: deps.project.path, worktreeIds: snap.worktreeIds, state: 'merged' })
  for (const branch of branchSet) {
    if (!branch || branch === row.base_branch) continue
    await deps.git.run(['branch', '-D', branch], deps.project.path).catch(() => {})
  }

  const conflict = casTransition(deps, row, 'merged')
  if (conflict) return conflict
  finalizeTransition(deps, row.id)

  const changed = applyTicketTransition(deps, snap.ticketIds, 'done')
  try {
    deps.jiraSyncManager?.onRailMerged(changed, row.id, row.pr_url)
  } catch (err) {
    console.error('[rail-pr-decision] jira onRailMerged failed:', err)
  }
  return { status: 200, body: { ok: true, decision: 'merged', merged: true, prUrl: row.pr_url } }
}

/**
 * Remote-less acceptance: merge the delivery's branches into the integration
 * branch DIRECTLY in the user's checkout. This is the one decision that touches
 * the user's working tree, so it is triple-guarded and transactional-ish:
 *
 *   - The checkout must have the integration branch checked out (a branch can
 *     only be checked out in one worktree — merging via a temp worktree is
 *     impossible while the user holds it) → 409 `merge_local_blocked` otherwise.
 *   - The working tree must be CLEAN → 409 `merge_local_blocked` otherwise.
 *   - Merge = the assembled head when one exists (row.branch), else each
 *     succeeded unit branch sequentially, `--no-ff --no-edit`. Any conflict →
 *     `merge --abort` + 502 `merge_failed`, NO transition (retry or discard).
 *
 * Success mirrors poll-merge's MERGED arm: decision → merged (prUrl stays
 * null), worktrees/branches swept, tickets → done, Jira onRailMerged(null).
 */
async function runMergeLocal(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  const snap = toPrDeliverySnapshot(row)

  // Guards on the user's checkout.
  const head = await deps.git.run(['rev-parse', '--abbrev-ref', 'HEAD'], deps.project.path)
  const currentBranch = head.code === 0 ? head.stdout.trim() : ''
  if (currentBranch !== row.base_branch) {
    return {
      status: 409,
      body: { error: 'merge_local_blocked', reason: 'wrong_branch', current: currentBranch || null, base: row.base_branch },
    }
  }
  const status = await deps.git.run(['status', '--porcelain'], deps.project.path)
  if (status.code !== 0 || status.stdout.trim() !== '') {
    return { status: 409, body: { error: 'merge_local_blocked', reason: 'dirty', base: row.base_branch } }
  }

  // What to merge: the assembled head carries every unit already; without one
  // (straight from on_review) merge each succeeded unit branch in order.
  let toMerge: string[]
  if (row.branch && (await branchExists(deps, row.branch))) {
    toMerge = [row.branch]
  } else {
    toMerge = []
    for (const unit of snap.branches.filter((b) => b.succeeded)) {
      let branch: string | null = unit.branch
      if (!(await branchExists(deps, branch))) branch = await findRecoverableBranch(deps, unit, row.base_branch)
      if (!branch) {
        return {
          status: 502,
          body: { error: 'merge_failed', detail: `branch '${unit.branch}' (ticket #${unit.ticketId}) no longer exists locally — nothing to merge` },
        }
      }
      toMerge.push(branch)
    }
  }
  if (toMerge.length === 0) {
    return { status: 502, body: { error: 'merge_failed', detail: 'no succeeded branch to merge' } }
  }

  for (const branch of toMerge) {
    const r = await deps.git.run(['merge', '--no-ff', '--no-edit', branch], deps.project.path)
    if (r.code !== 0) {
      await deps.git.run(['merge', '--abort'], deps.project.path).catch(() => {})
      const detail = (r.stderr.trim() || r.stdout.trim()).split('\n')[0] || `exit ${r.code}`
      return { status: 502, body: { error: 'merge_failed', detail: `merging '${branch}': ${detail}` } }
    }
  }

  // Post-merge sweep (same shape as discard steps 2-3): the work now lives on
  // the integration branch, so the launch's worktrees + branches are spent.
  const branchSet = new Set<string>(toMerge)
  for (const b of snap.branches) branchSet.add(b.branch)
  if (row.branch) branchSet.add(row.branch)
  for (const wtId of snap.worktreeIds) {
    const wt = getRailWorktree(deps.db, wtId)
    if (!wt) continue
    branchSet.add(wt.branch)
    try {
      await removeWorktree(deps.git, {
        repoDir: deps.project.path, worktreePath: wt.worktree_path, branch: wt.branch, deleteBranch: false,
      })
    } catch (err) {
      console.warn(`[rail-pr-decision] merge-local could not remove worktree ${wt.worktree_path}: ${(err as Error).message}`)
      continue
    }
    if (!isTerminalMergeState(wt.merge_state)) updateRailWorktreeState(deps.db, wt.id, 'merged')
  }
  for (const branch of branchSet) {
    if (!branch || branch === row.base_branch) continue
    await deps.git.run(['branch', '-D', branch], deps.project.path).catch(() => {})
  }

  const conflict = casTransition(deps, row, 'merged')
  if (conflict) return conflict
  finalizeTransition(deps, row.id)

  const changed = applyTicketTransition(deps, snap.ticketIds, 'done')
  try {
    deps.jiraSyncManager?.onRailMerged(changed, row.id, null)
  } catch (err) {
    console.error('[rail-pr-decision] jira onRailMerged (local) failed:', err)
  }
  return { status: 200, body: { ok: true, decision: 'merged', merged: true, local: true } }
}

function resolveTicketFile(deps: PrDecisionDeps): string {
  if (deps.ticketFile) return deps.ticketFile
  const exec = resolveProjectExecution({ slug: deps.project.slug, path: deps.project.path })
  return exec.relocated ? exec.ticketsPath : resolveTicketStoragePath(deps.project.path)
}

/**
 * Move the launch's on_review tickets to `todo` (discard) or `done` (merged),
 * broadcasting ticket_updated per changed spec — mirroring onLoopRunFinished's
 * revert style in project-registry. ONLY tickets still parked at on_review move
 * (a manually re-triaged spec is respected). Best-effort: a ticket-store
 * failure is logged, never fatal (the decision row already transitioned).
 */
function applyTicketTransition(deps: PrDecisionDeps, ticketIds: number[], to: 'todo' | 'done'): number[] {
  const changed: number[] = []
  if (ticketIds.length === 0) return changed
  try {
    const ticketFile = resolveTicketFile(deps)
    const now = new Date().toISOString()
    const store = mutateStore(ticketFile, (s) => {
      for (const tid of ticketIds) {
        const ticket = s.tickets[String(tid)]
        if (!ticket || ticket.status !== 'on_review') continue
        ticket.status = to
        ticket.updated_at = now
        changed.push(tid)
      }
    })
    for (const tid of changed) {
      const ticket = store.tickets[String(tid)]
      if (!ticket) continue
      deps.broadcast({
        type: 'ticket_updated',
        ticket: ticket as unknown as TicketUpdatedMessage['ticket'],
        projectId: deps.project.id,
        timestamp: ticket.updated_at,
      } as TicketUpdatedMessage)
    }
  } catch (err) {
    console.error('[rail-pr-decision] failed to apply ticket transition:', err)
  }
  return changed
}
