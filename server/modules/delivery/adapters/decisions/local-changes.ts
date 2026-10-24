/**
 * The person's uncommitted work saved by "Integrate locally"
 * (proactive-local-integration): the response body, the mission-agent
 * briefing for a conflicting restore, the "Restore my changes" action and
 * startup recovery of a stash that was saved but never restored.
 *
 * Every effect runs under the repository lock and refuses while a decision
 * lease is held, so it never interleaves with another delivery operation.
 */
import { withRepoLock } from '../../../../repo-lock'
import { getAgentChatManager } from '../../../missions/runtime/agent-chat-registry'
import {
  getPrDelivery, listPrDeliveriesWithLocalStash, readLocalStash, setPrDeliveryLocalStash, toPrDeliverySnapshot,
  type LocalStashRecord, type RailPrDeliveryRow,
} from '../../runtime/rail-pr-store'
import { findSpecrailsStashes, recordAfterRestore, restoreBranchName, restoreLocalChanges } from '../../runtime/local-stash'
import { PrDecisionDeps, PrDecisionResult } from './contracts'
import { finalizeTransition } from './transitions'

/** What the decision response tells the surfaces about the saved work. */
export function localChangesBody(record: LocalStashRecord): Record<string, unknown> {
  return {
    state: record.state,
    stashName: record.name,
    stashSha: record.sha,
    branch: record.branch,
    restoreBranch: record.restoreBranch,
    conflictPaths: record.conflictPaths,
  }
}

/** The automatic turn's text (agent-facing, English like every briefing). */
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
    `[Specrails] Integrated ${tickets} into \`${input.branch}\` locally (delivery ${input.deliveryId}).`,
    `Before integrating, the person's uncommitted changes on \`${input.branch}\` were saved as a git stash. Re-applying them on top of the integrated result conflicted, so the integrated tree was restored and the stash was KEPT:`,
    `- stash commit: ${record.sha}`,
    `- stash message: "${record.name}"`,
    `Conflicting files:`,
    files,
    '',
    'Please restore those changes for the person on a NEW branch and resolve the conflicts there:',
    `1. Leave \`${input.branch}\` untouched: work in a separate worktree, e.g. \`git worktree add -b ${restoreBranch} <temporary path> ${input.branch}\`.`,
    `2. In that worktree run \`git stash apply ${record.sha}\` (apply — never pop) and resolve every conflict, keeping both the person's intent and the integrated code.`,
    `3. Commit the result on \`${restoreBranch}\` and report back: the branch name, what conflicted and how you resolved it.`,
    `Never commit to \`${input.branch}\` directly and never run \`git stash drop\`, \`git stash pop\` or \`git stash clear\`: the stash is the person's only copy until they confirm.`,
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

/**
 * "Restore my changes": re-attempt applying the recorded stash. A clean apply
 * drops it; a conflict restores the integrated tree again and keeps it.
 */
export async function runRestoreLocalChanges(deps: PrDecisionDeps, prDeliveryId: string): Promise<PrDecisionResult> {
  const initial = getPrDelivery(deps.db, prDeliveryId)
  if (!initial) return { status: 404, body: { error: 'Unknown prDeliveryId' } }
  const lockPath = initial.repository_path ?? deps.project.path
  return withRepoLock(lockPath, async () => {
    deps.assertAdmission?.()
    const row = getPrDelivery(deps.db, prDeliveryId)
    if (!row) return { status: 404, body: { error: 'Unknown prDeliveryId' } }
    const parent = row.parent_delivery_id ? getPrDelivery(deps.db, row.parent_delivery_id) : null
    if (row.operation_token || parent?.operation_token) {
      return { status: 409, body: { error: 'operation_in_progress', current: row.decision, operation: row.operation ?? parent?.operation ?? null } }
    }
    const record = readLocalStash(row.local_stash)
    if (!record) return { status: 404, body: { error: 'no_local_changes' } }
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
    return { status: 200, body: { ok: true, localChanges: localChangesBody(next), ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}) } }
  })
}

/**
 * Startup recovery (admission still closed, leases already cleared): every
 * `saved` stash is re-applied; a Specrails stash whose record never landed
 * (crash between `git stash push` and the write) is adopted from its message
 * first. Conflicts follow the same keep-the-stash + brief-the-agent path.
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
        if (next.state === 'needs_attention') briefAgentOnLocalChanges(deps, row, next, current.branch)
      })
    }
  } catch (err) {
    console.error('[safe-pr] local-changes recovery failed:', err)
  }
  return touched
}
