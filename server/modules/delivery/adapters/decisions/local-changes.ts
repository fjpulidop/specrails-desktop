/**
 * The person's uncommitted work saved by "Integrate locally"
 * (proactive-local-integration): the response body, the server-side
 * restoration of a conflicting stash on its own branch + worktree (never
 * delegated to the read-only mission agent, which is only informed), the
 * "Restore my changes" / "Bring them back" / "Discard the restored branch"
 * actions and startup recovery.
 *
 * Every effect runs under the repository lock and refuses while a decision
 * lease is held, so it never interleaves with another delivery operation.
 */
import { withRepoLock } from '../../../../repo-lock'
import { getAgentChatManager } from '../../../missions/runtime/agent-chat-registry'
import {
  getPrDelivery, listPrDeliveriesWithLocalStash, readLocalStash, setPrDeliveryLocalStash, toPrDeliverySnapshot,
  type LocalRestoreBranchRecord, type LocalStashRecord, type RailPrDeliveryRow,
} from '../../runtime/rail-pr-store'
import { dropBySha, findSpecrailsStashes, recordAfterRestore, restoreBranchName, restoreLocalChanges } from '../../runtime/local-stash'
import {
  bringBackRestoreBranch, commitRestoreBranch, prepareRestoreBranch, removeRestoreBranch, restoreCommitMessage,
} from '../../runtime/local-restore-branch'
import { PrDecisionDeps, PrDecisionResult } from './contracts'
import { batchWorktreeRoot } from './metadata'
import { finalizeTransition } from './transitions'

/** What the decision response tells the surfaces about the saved work. */
export function localChangesBody(record: LocalStashRecord): Record<string, unknown> {
  const restore = record.restore ? (({ worktreePath: _worktreePath, ...wire }) => wire)(record.restore) : null
  return {
    state: record.state,
    stashName: record.name,
    stashSha: record.sha,
    branch: record.branch,
    restoreBranch: record.restoreBranch,
    conflictPaths: record.conflictPaths,
    ...(restore ? { restore } : {}),
  }
}

/**
 * The automatic turn's text (agent-facing, English like every briefing).
 * Mission agents are read-only: this only REPORTS what happened and what
 * Specrails is doing — it never asks the agent to write, apply or commit.
 */
export function buildLocalChangesBriefing(input: {
  deliveryId: string
  ticketIds: readonly number[]
  record: LocalStashRecord
  branch: string
}): string {
  const { record } = input
  const restoreBranch = record.restoreBranch ?? restoreBranchName(record.sha)
  const tickets = input.ticketIds.length > 0 ? input.ticketIds.map((id) => `#${id}`).join(', ') : 'this delivery'
  const files = record.conflictPaths.length > 0 ? record.conflictPaths.map((p) => `- ${p}`).join('\n') : '- (git reported no unmerged path)'
  return [
    `[Specrails] Status report — no action needed from you. Integrated ${tickets} into \`${input.branch}\` locally (delivery ${input.deliveryId}).`,
    `The person's uncommitted changes on \`${input.branch}\` were saved as a git stash before integrating ("${record.name}"). Re-applying them on top of the integrated result conflicted, so \`${input.branch}\` was left exactly as integrated and the stash is kept safe. Conflicting files:`,
    files,
    '',
    `Specrails itself is restoring those changes on the new branch \`${restoreBranch}\` in its own separate worktree and resolving the conflicts there. Nothing touches \`${input.branch}\` until the person clicks "Bring them back" on the delivery card, which also shows the restored files for review.`,
    'Report this status to the person in one or two sentences. You are read-only here: do not run git commands, do not suggest shell commands, and never suggest dropping, popping or clearing the stash.',
  ].join('\n')
}

function originConversation(deps: PrDecisionDeps, row: RailPrDeliveryRow): string | null {
  if (row.origin_conversation_id) return row.origin_conversation_id
  if (row.parent_delivery_id) return getPrDelivery(deps.db, row.parent_delivery_id)?.origin_conversation_id ?? null
  return null
}

/** Hand a conflicting restore to the delivery's origin mission agent. One turn
 * per delivery (durable turn key); fire-and-forget, never throws. */
export function briefAgentOnLocalChanges(deps: PrDecisionDeps, row: RailPrDeliveryRow, record: LocalStashRecord, branch: string): void {
  try {
    const conversationId = originConversation(deps, row)
    if (!conversationId) return
    const agent = (deps.missionAgent ?? getAgentChatManager)()
    if (!agent) return
    const text = buildLocalChangesBriefing({ deliveryId: row.id, ticketIds: toPrDeliverySnapshot(row).ticketIds, record, branch })
    void agent.startAutomaticTurn(conversationId, text, { turnKey: `local-changes:${row.id}`, label: 'Restore local changes' })
      .catch((err: unknown) => console.error('[safe-pr] local-changes briefing failed:', err))
  } catch (err) {
    console.error('[safe-pr] local-changes briefing failed:', err)
  }
}

function broadcastDelivery(deps: PrDecisionDeps, row: RailPrDeliveryRow): void {
  try {
    finalizeTransition(deps, row.parent_delivery_id ?? row.id)
  } catch { /* the durable row stays authoritative */ }
}

/** Persist one restore attempt; leaves `local_changes_attention` once nothing is held. */
function persistRestore(deps: PrDecisionDeps, row: RailPrDeliveryRow, next: LocalStashRecord): void {
  const settled = next.state === 'restored' || next.state === 'released'
  const warnings = toPrDeliverySnapshot(row).cleanupWarnings
  setPrDeliveryLocalStash(deps.db, row.id, next, settled
    ? { from: 'local_changes_attention', to: warnings.length > 0 ? 'cleanup_incomplete' : 'merged' }
    : next.state === 'needs_attention' && row.decision === 'merged'
      ? { from: 'merged', to: 'local_changes_attention' }
      : undefined)
}

/** In-flight server-side restorations (tests and shutdown can await them). */
const inFlightRestores = new Set<Promise<void>>()

/** Resolve once every in-flight branch restoration has settled. */
export async function waitForLocalRestores(): Promise<void> {
  while (inFlightRestores.size > 0) await Promise.allSettled([...inFlightRestores])
}

function restoreRoot(deps: PrDecisionDeps): string {
  return deps.assemblyRoot ?? batchWorktreeRoot(deps.project.slug)
}

/** Fold a restore-branch change into the record and persist it (lease-independent). */
function saveRestore(deps: PrDecisionDeps, rowId: string, restore: LocalRestoreBranchRecord): LocalStashRecord | null {
  const row = getPrDelivery(deps.db, rowId)
  const current = row ? readLocalStash(row.local_stash) : null
  if (!row || !current) return null
  const next: LocalStashRecord = { ...current, restoreBranch: restore.branch, restore, updatedAt: restore.updatedAt }
  setPrDeliveryLocalStash(deps.db, row.id, next)
  broadcastDelivery(deps, row)
  return next
}

function restoreRecord(base: Partial<LocalRestoreBranchRecord> & Pick<LocalRestoreBranchRecord, 'status' | 'branch'>): LocalRestoreBranchRecord {
  return {
    worktreePath: '', baseSha: null, commitSha: null, resolvedBy: null, managedPaths: [], conflictPaths: [], files: [], detail: null,
    ...base, updatedAt: new Date().toISOString(),
  }
}

async function resolveWith(deps: PrDecisionDeps): Promise<NonNullable<PrDecisionDeps['localRestoreResolver']>> {
  if (deps.localRestoreResolver) return deps.localRestoreResolver
  // Lazy: the AI executor stack loads only when a restore actually conflicts.
  const { defaultLocalRestoreResolver } = await import('../../runtime/local-restore-resolver')
  return defaultLocalRestoreResolver
}

/**
 * Restore a conflicting stash server-side: new branch + worktree from the
 * integrated target, `git stash apply` there, managed files take the
 * integrated version, a clean result is committed at once; otherwise the
 * write-capable resolver runs confined to that worktree (outside the
 * repository lock) and Specrails verifies + commits. The target branch and
 * the stash are never touched. Fire-and-forget; never throws.
 */
export function startLocalRestoreBranch(deps: PrDecisionDeps, rowId: string): Promise<void> {
  const run = runLocalRestoreBranch(deps, rowId).catch((err: unknown) => {
    console.error('[safe-pr] local-changes branch restore failed:', err)
  })
  inFlightRestores.add(run)
  void run.finally(() => inFlightRestores.delete(run))
  return run
}

async function runLocalRestoreBranch(deps: PrDecisionDeps, rowId: string): Promise<void> {
  const initial = getPrDelivery(deps.db, rowId)
  if (!initial) return
  const lockPath = initial.repository_path ?? deps.project.path
  type PendingResolve = { worktreePath: string; branch: string; baseSha: string; conflictPaths: string[]; managedPaths: string[]; targetBranch: string; stashName: string; message: string }
  const job = await withRepoLock(lockPath, async (): Promise<PendingResolve | null> => {
    const row = getPrDelivery(deps.db, rowId)
    const record = row ? readLocalStash(row.local_stash) : null
    if (!row || !record || record.state !== 'needs_attention') return null
    const existing = record.restore
    if (existing && (existing.status === 'resolving' || existing.status === 'ready')) return null
    const repo = record.checkoutPath
    if (existing?.status === 'failed') {
      // A failed attempt is Specrails' own scratch branch; the stash still
      // holds the person's work, so a retry starts from a clean slate.
      await removeRestoreBranch(deps.git, repo, existing.worktreePath, existing.branch, true)
    }
    const ticketIds = toPrDeliverySnapshot(row).ticketIds
    const message = restoreCommitMessage(ticketIds)
    const prepared = await prepareRestoreBranch(deps.git, {
      repo, sha: record.sha, targetBranch: record.branch, worktreesRoot: restoreRoot(deps), ticketId: ticketIds[0] ?? 0,
    })
    if (!prepared.ok) {
      saveRestore(deps, row.id, restoreRecord({ status: 'failed', branch: prepared.branch, worktreePath: prepared.worktreePath ?? '', detail: prepared.detail }))
      return null
    }
    const base = { branch: prepared.branch, worktreePath: prepared.worktreePath, baseSha: prepared.baseSha, managedPaths: prepared.managedPaths, conflictPaths: prepared.conflictPaths }
    if (prepared.conflictPaths.length === 0) {
      // It applied cleanly on the integrated tree (or only managed files
      // conflicted): commit now, no resolver needed.
      const committed = await commitRestoreBranch(deps.git, { ...base, message })
      saveRestore(deps, row.id, committed.ok
        ? restoreRecord({ ...base, status: 'ready', resolvedBy: 'clean', commitSha: committed.commitSha, files: committed.files })
        : restoreRecord({ ...base, status: 'failed', detail: committed.detail, conflictPaths: committed.conflictPaths ?? [] }))
      return null
    }
    saveRestore(deps, row.id, restoreRecord({ ...base, status: 'resolving' }))
    return { ...base, targetBranch: record.branch, stashName: record.name, message }
  })
  if (!job) return
  let resolverError: string | null = null
  try {
    const resolver = await resolveWith(deps)
    await resolver({ worktreePath: job.worktreePath, branch: job.branch, targetBranch: job.targetBranch, conflictPaths: job.conflictPaths, stashName: job.stashName })
  } catch (err) {
    resolverError = err instanceof Error ? err.message : String(err)
  }
  await withRepoLock(lockPath, async () => {
    const row = getPrDelivery(deps.db, rowId)
    const record = row ? readLocalStash(row.local_stash) : null
    // Discarded / restarted meanwhile: that newer state wins.
    if (!row || !record?.restore || record.restore.status !== 'resolving' || record.restore.branch !== job.branch) return
    const base = { branch: job.branch, worktreePath: job.worktreePath, baseSha: job.baseSha, managedPaths: job.managedPaths, conflictPaths: job.conflictPaths }
    const committed = await commitRestoreBranch(deps.git, { ...base, message: job.message })
    saveRestore(deps, row.id, committed.ok
      ? restoreRecord({ ...base, status: 'ready', resolvedBy: 'resolver', commitSha: committed.commitSha, files: committed.files })
      : restoreRecord({
        ...base, status: 'failed',
        conflictPaths: committed.conflictPaths ?? job.conflictPaths,
        detail: resolverError ? `The conflict resolver failed: ${resolverError}` : committed.detail,
      }))
  })
}

/** A conflicting restore: inform the mission (report only) and restore server-side. */
export function handleConflictingRestore(deps: PrDecisionDeps, row: RailPrDeliveryRow, record: LocalStashRecord, branch: string): void {
  briefAgentOnLocalChanges(deps, row, record, branch)
  void startLocalRestoreBranch(deps, row.id)
}

async function underDeliveryLock(
  deps: PrDecisionDeps,
  prDeliveryId: string,
  fn: (row: RailPrDeliveryRow, record: LocalStashRecord) => Promise<PrDecisionResult>,
): Promise<PrDecisionResult> {
  const initial = getPrDelivery(deps.db, prDeliveryId)
  if (!initial) return { status: 404, body: { error: 'Unknown prDeliveryId' } }
  return withRepoLock(initial.repository_path ?? deps.project.path, async () => {
    deps.assertAdmission?.()
    const row = getPrDelivery(deps.db, prDeliveryId)
    if (!row) return { status: 404, body: { error: 'Unknown prDeliveryId' } }
    const parent = row.parent_delivery_id ? getPrDelivery(deps.db, row.parent_delivery_id) : null
    if (row.operation_token || parent?.operation_token) {
      return { status: 409, body: { error: 'operation_in_progress', current: row.decision, operation: row.operation ?? parent?.operation ?? null } }
    }
    const record = readLocalStash(row.local_stash)
    if (!record) return { status: 404, body: { error: 'no_local_changes' } }
    return fn(row, record)
  })
}

/**
 * "Bring them back to <target>": fast-forward the person's checkout to the
 * reviewed restore commit (merging a moved target into the restore branch
 * first, in its worktree), then drop the stash — the person confirmed — and
 * remove the restore worktree/branch.
 */
export async function runBringBackLocalChanges(deps: PrDecisionDeps, prDeliveryId: string): Promise<PrDecisionResult> {
  return underDeliveryLock(deps, prDeliveryId, async (row, record) => {
    const restore = record.restore
    if (restore?.status === 'brought_back') return { status: 200, body: { ok: true, localChanges: localChangesBody(record) } }
    if (!restore || restore.status !== 'ready' || !restore.commitSha) {
      return { status: 409, body: { error: 'restore_not_ready', localChanges: localChangesBody(record) } }
    }
    const result = await bringBackRestoreBranch(deps.git, {
      checkout: record.checkoutPath, repo: record.checkoutPath, targetBranch: record.branch,
      branch: restore.branch, worktreePath: restore.worktreePath, commitSha: restore.commitSha,
    })
    if (!result.ok) {
      return {
        status: 409,
        body: { error: 'local_restore_blocked', reason: result.reason, detail: result.detail, current: result.current ?? null, base: record.branch, localChanges: localChangesBody(record) },
      }
    }
    const warnings = [...result.warnings]
    const dropped = await dropBySha(deps.git, record.checkoutPath, record.sha)
    if (dropped) warnings.push(dropped)
    const at = new Date().toISOString()
    const next: LocalStashRecord = { ...record, state: 'restored', restore: { ...restore, status: 'brought_back', commitSha: result.commitSha, updatedAt: at }, updatedAt: at }
    persistRestore(deps, row, next)
    broadcastDelivery(deps, row)
    return { status: 200, body: { ok: true, localChanges: localChangesBody(next), ...(warnings.length > 0 ? { warnings } : {}) } }
  })
}

/** "Discard the restored branch": remove the restore worktree + branch. The stash is KEPT. */
export async function runDiscardRestoreBranch(deps: PrDecisionDeps, prDeliveryId: string): Promise<PrDecisionResult> {
  return underDeliveryLock(deps, prDeliveryId, async (row, record) => {
    const restore = record.restore
    if (!restore || restore.status === 'discarded' || restore.status === 'brought_back') {
      return { status: 200, body: { ok: true, localChanges: localChangesBody(record) } }
    }
    if (restore.status === 'resolving') {
      return { status: 409, body: { error: 'restore_in_progress', localChanges: localChangesBody(record) } }
    }
    const warnings = await removeRestoreBranch(deps.git, record.checkoutPath, restore.worktreePath, restore.branch, true)
    const next = saveRestore(deps, row.id, { ...restore, status: 'discarded', updatedAt: new Date().toISOString() }) ?? record
    return { status: 200, body: { ok: true, localChanges: localChangesBody(next), ...(warnings.length > 0 ? { warnings } : {}) } }
  })
}

/**
 * "Restore my changes": re-attempt applying the recorded stash. A clean apply
 * drops it; a conflict restores the integrated tree again and keeps it.
 */
export async function runRestoreLocalChanges(deps: PrDecisionDeps, prDeliveryId: string): Promise<PrDecisionResult> {
  return underDeliveryLock(deps, prDeliveryId, async (row, record) => {
    if (record.state === 'restored' || record.state === 'released') {
      return { status: 200, body: { ok: true, localChanges: localChangesBody(record) } }
    }
    const result = await restoreLocalChanges(deps.git, record)
    const next = recordAfterRestore(record, result)
    persistRestore(deps, row, next)
    broadcastDelivery(deps, row)
    if (result.state === 'blocked') {
      return {
        status: 409,
        body: { error: 'local_restore_blocked', reason: result.reason, detail: result.detail, current: result.current ?? null, base: record.branch, localChanges: localChangesBody(next) },
      }
    }
    // Still conflicting: Specrails restores it on its own branch (idempotent
    // while one is resolving or ready for review).
    if (next.state === 'needs_attention') void startLocalRestoreBranch(deps, row.id)
    return { status: 200, body: { ok: true, localChanges: localChangesBody(next), ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}) } }
  })
}

/**
 * Startup recovery (admission still closed, leases already cleared): every
 * `saved` stash is re-applied; a Specrails stash whose record never landed
 * (crash between `git stash push` and the write) is adopted from its message
 * first. Conflicts follow the same keep-the-stash path: the mission is informed and
 * Specrails restores the stash on its own branch.
 * Returns the delivery ids it touched. Never throws.
 */
export async function recoverLocalStashes(deps: PrDecisionDeps): Promise<string[]> {
  const touched: string[] = []
  try {
    const repos = new Set<string>([deps.project.path])
    for (const row of listPrDeliveriesWithLocalStash(deps.db)) {
      const record = readLocalStash(row.local_stash)
      if (record?.checkoutPath) repos.add(record.checkoutPath)
    }
    // Adopt orphaned Specrails stashes (message carries the delivery id).
    for (const repo of repos) {
      for (const found of await findSpecrailsStashes(deps.git, repo)) {
        const row = getPrDelivery(deps.db, found.deliveryId)
        if (!row || readLocalStash(row.local_stash) || !found.branch) continue
        const at = new Date().toISOString()
        setPrDeliveryLocalStash(deps.db, row.id, {
          sha: found.sha, name: found.name, checkoutPath: repo, branch: found.branch, state: 'saved',
          restoreBranch: null, conflictPaths: [], savedAt: at, updatedAt: at,
        })
      }
    }
    for (const candidate of listPrDeliveriesWithLocalStash(deps.db)) {
      const record = readLocalStash(candidate.local_stash)
      if (!record || record.state !== 'saved') continue
      await withRepoLock(candidate.repository_path ?? deps.project.path, async () => {
        const row = getPrDelivery(deps.db, candidate.id)
        const current = row ? readLocalStash(row.local_stash) : null
        if (!row || !current || current.state !== 'saved' || row.operation_token) return
        const result = await restoreLocalChanges(deps.git, current)
        if (result.state === 'blocked') {
          console.warn(`[safe-pr] local changes of ${row.id} not restored at startup: ${result.detail}`)
          return
        }
        const next = recordAfterRestore(current, result)
        persistRestore(deps, row, next)
        touched.push(row.id)
        if (next.state === 'needs_attention') handleConflictingRestore(deps, row, next, current.branch)
      })
    }
    // Branch restorations: a resolver interrupted by the restart is settled
    // `failed` (its worktree is kept for Discard / retry); a conflicting
    // stash that never got one (e.g. recorded before this existed) starts now.
    const conflictedNow = new Set(touched)
    for (const candidate of listPrDeliveriesWithLocalStash(deps.db)) {
      const record = readLocalStash(candidate.local_stash)
      if (!record || record.state !== 'needs_attention' || conflictedNow.has(candidate.id)) continue
      if (record.restore?.status === 'resolving') {
        saveRestore(deps, candidate.id, { ...record.restore, status: 'failed', detail: 'Interrupted by a restart before the conflicts were resolved.', updatedAt: new Date().toISOString() })
        touched.push(candidate.id)
      } else if (!record.restore) {
        void startLocalRestoreBranch(deps, candidate.id)
      }
    }
  } catch (err) {
    console.error('[safe-pr] local-changes recovery failed:', err)
  }
  return touched
}
