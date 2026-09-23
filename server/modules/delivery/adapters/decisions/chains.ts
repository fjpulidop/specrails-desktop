import { durableBranchHeads, durableOverlayCleanupEvidence, durableSettlementIgnoredPaths, releaseRailWorktrees } from '../../runtime/rail-worktree-release'
import { type RailPrDeliveryRow } from '../../runtime/rail-pr-store'
import { newId } from '../../../../ids'
import { listChainsTouchingDelivery, parseLaunched, pauseChainsForDiscardedHead, toChainSnapshot } from '../../../builder/runtime/milestone-chain-store'
import {
  getPrDelivery as chainGetDelivery,
  toPrDeliverySnapshot as chainSnapshotOf,
  isTerminalPrDecision as chainIsTerminal,
  claimPrDeliveryOperation as chainClaimOp,
  releasePrDeliveryOperation as chainReleaseOp,
} from '../../runtime/rail-pr-store'
import { PrDecisionDeps } from './contracts'
import { COMMIT_SHA_RE } from './evidence'
import { releasableWorktreeIds, deleteOwnedBranchesIfUnchanged } from './ownership'
import { safetyArchiveRecorder, casTransitionWithTicketEffect, applyTerminalTicketEffect, finalizeTransition } from './transitions'


// ─── Milestone chain hooks (premium-milestone-progress D4) ───────────────────

/** Decisions a stacked sibling can sit at while its head is already merged. */
export const SWEEPABLE_DECISIONS: ReadonlySet<string> = new Set(['on_review', 'pr_draft', 'pr_ready', 'pr_closed'])


/**
 * Merging a STACKED delivery also lands every earlier chunk it was built on.
 * Walk the chain(s) this delivery belongs to and settle each still-undecided
 * sibling whose delivered head commit is PROVABLY an ancestor of the chain's
 * integration branch (`git merge-base --is-ancestor`) as `merged` — the same
 * CAS + ticket effect (`done`) + Jira hook a direct merge runs. Chain-local by
 * design; siblings whose head is not an ancestor are left untouched. Returns
 * the swept delivery ids. Never throws.
 */
export async function sweepMergedChainAncestors(deps: PrDecisionDeps, mergedRow: RailPrDeliveryRow): Promise<string[]> {
  const swept: string[] = []
  if (deps.repositoryChildOf) return swept
  let chains: ReturnType<typeof listChainsTouchingDelivery>
  try { chains = listChainsTouchingDelivery(deps.db, mergedRow.id) } catch { return swept }
  for (const chain of chains) {
    const integration = chain.integration_branch
    if (!integration) continue
    for (const entry of parseLaunched(chain)) {
      if (!entry.deliveryId || entry.deliveryId === mergedRow.id || swept.includes(entry.deliveryId)) continue
      const other = chainGetDelivery(deps.db, entry.deliveryId)
      if (!other || chainIsTerminal(other.decision) || !SWEEPABLE_DECISIONS.has(other.decision)) continue
      const snap = chainSnapshotOf(other)
      // An assembled delivery SHA proves the whole chunk. Without that head,
      // every unit needs its own immutable proof; accepting just the first
      // ancestor could mark unmerged tickets done and delete their branches.
      const requiredShas = snap.deliverySha ? [snap.deliverySha] : snap.units.map((unit) => unit.finalSha)
      const validShas = requiredShas.filter((sha): sha is string => typeof sha === 'string' && COMMIT_SHA_RE.test(sha))
      if (requiredShas.length === 0 || validShas.length !== requiredShas.length) continue
      let allAncestors = true
      try {
        for (const sha of new Set(validShas)) {
          const r = await deps.git.run(['merge-base', '--is-ancestor', sha, integration], deps.project.path)
          if (r.code !== 0) { allAncestors = false; break }
        }
      } catch { allAncestors = false }
      if (!allAncestors) continue
      const token = newId()
      if (!chainClaimOp(deps.db, other.id, other.decision, 'poll-merge', token)) continue
      let released = false
      try {
        const claimed = { ...other, operation_token: token } as RailPrDeliveryRow
        const cleanupWarnings = await releaseRailWorktrees({
          db: deps.db, git: deps.git, repoDir: deps.project.path,
          worktreeIds: releasableWorktreeIds(deps, snap), state: 'merged',
          expectedHeadByBranch: durableBranchHeads(snap.branches),
          overlayEvidenceByBranch: durableOverlayCleanupEvidence(snap.branches),
          settlementIgnoredByBranch: durableSettlementIgnoredPaths(snap.branches),
          onSafetyArchive: safetyArchiveRecorder(deps, claimed),
        })
        await deleteOwnedBranchesIfUnchanged(deps, claimed, snap, cleanupWarnings)
        const conflict = casTransitionWithTicketEffect(deps, claimed, 'merged', {
          deliveryOutcome: 'delivered',
          statusCode: cleanupWarnings.length > 0 ? 'cleanup_incomplete' : 'merged',
          statusDetail: `merged as part of ${mergedRow.rail_key}`,
          cleanupWarnings,
        }, {
          deliveryId: claimed.id,
          ticketIds: snap.ticketIds,
          targetStatus: 'done',
          jiraAction: 'merged',
          prUrl: claimed.pr_url,
        })
        if (conflict) continue
        applyTerminalTicketEffect(deps, claimed, 'merged', cleanupWarnings)
        // Release BEFORE finalizing: a row still holding a lease defers its
        // broadcast to the lease owner's finally, which here would never come.
        chainReleaseOp(deps.db, other.id, token)
        released = true
        finalizeTransition(deps, other.id)
        swept.push(other.id)
      } catch (err) {
        console.error(`[milestone-chain] ancestor sweep failed for ${other.id}:`, err)
      } finally {
        if (!released) chainReleaseOp(deps.db, other.id, token)
      }
    }
  }
  return swept
}


/** A discarded delivery that a chain's later chunks build on pauses those
 *  chains (`head_discarded`, head rewound to the previous chunk's branch). */
export function pauseChainsOnDiscard(deps: PrDecisionDeps, row: RailPrDeliveryRow): void {
  if (deps.repositoryChildOf) return
  try {
    const branchOf = (id: string): string | null => {
      const other = chainGetDelivery(deps.db, id)
      if (!other) return null
      const s = chainSnapshotOf(other)
      return s.branch ?? s.units.find((u) => u.succeeded && u.branch)?.branch ?? null
    }
    const paused = pauseChainsForDiscardedHead(deps.db, row.id, branchOf)
    for (const chain of paused) {
      deps.broadcast({ type: 'milestone.chain_changed', projectId: deps.project.id, chain: toChainSnapshot(chain), timestamp: new Date().toISOString() })
    }
  } catch (err) {
    console.error('[milestone-chain] discard hook failed:', err)
  }
}
