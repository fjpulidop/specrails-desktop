import {
  type DeliverBranchRecord, type PrDeliverySnapshot, type RailPrDeliveryRow
} from '../../runtime/rail-pr-store'
import { getRailWorktree } from '../../runtime/rail-worktrees-store'
import { COMMIT_SHA_RE } from './evidence'
import { PrDecisionDeps } from './contracts'


/** A legacy record's `succeeded` bit meant delivery eligibility. New records
 * state that eligibility directly; blocked/no-change units are never swept as
 * a side effect of delivering another unit in the same batch. */
export function unitWasDelivered(unit: DeliverBranchRecord): boolean {
  return unit.deliveryOutcome === undefined ? unit.succeeded : unit.deliveryOutcome === 'ready'
}


/** Branch deletion is ownership-based, never name-derived. Legacy rows without
 * ownership evidence degrade to preservation. A multi-unit assembled head is
 * owned when it is distinct from every recorded unit branch. */
export function ownedDeliveryBranches(
  row: RailPrDeliveryRow,
  snap: PrDeliverySnapshot,
  cleanupWarnings?: string[],
): Set<string> {
  const unknownOwnership = row.is_continuation !== 1
    ? snap.branches.filter((unit) => unitWasDelivered(unit) && unit.branchOwnership === undefined)
    : []
  if (cleanupWarnings && unknownOwnership.length > 0) {
    cleanupWarnings.push(
      `branch cleanup preserved ${unknownOwnership.length} legacy ${unknownOwnership.length === 1 ? 'branch' : 'branches'} because ownership was not recorded`,
    )
  }
  const owned = new Set(
    snap.branches
      .filter((unit) => unit.branchOwnership === 'created' && unitWasDelivered(unit))
      .map((unit) => unit.branch),
  )
  if (
    row.is_continuation !== 1 && snap.branches.length > 1 && row.branch &&
    !snap.branches.some((unit) => unit.branch === row.branch)
  ) owned.add(row.branch)
  return owned
}


export function immutableHeadForOwnedBranch(
  row: RailPrDeliveryRow,
  snap: PrDeliverySnapshot,
  branch: string,
): string | null {
  if (branch === row.branch && row.delivery_sha && COMMIT_SHA_RE.test(row.delivery_sha)) {
    return row.delivery_sha.toLowerCase()
  }
  const unitHeads = new Set(
    snap.branches
      .filter((unit) => unitWasDelivered(unit) && unit.branch === branch && unit.finalSha && COMMIT_SHA_RE.test(unit.finalSha))
      .map((unit) => unit.finalSha!.toLowerCase()),
  )
  return unitHeads.size === 1 ? [...unitHeads][0] : null
}


export async function deleteOwnedBranchesIfUnchanged(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  snap: PrDeliverySnapshot,
  cleanupWarnings: string[],
  protectedBranches: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const branch of ownedDeliveryBranches(row, snap, cleanupWarnings)) {
    if (!branch || branch === row.base_branch) continue
    // A failed release leaves the linked worktree mounted for inspection. Do
    // not even attempt to delete its checked-out branch: preserving the files
    // while erasing their durable ref would make the recovery story depend on
    // Git's incidental checked-out-branch rejection.
    if (protectedBranches.has(branch)) {
      cleanupWarnings.push(`branch ${branch}: retained with its worktree for inspection`)
      continue
    }
    try {
      const expectedHead = immutableHeadForOwnedBranch(row, snap, branch)
      if (!expectedHead) {
        cleanupWarnings.push(`branch ${branch}: retained because no unambiguous immutable delivered HEAD was recorded`)
        continue
      }
      const observed = await deps.git.run(['rev-parse', '--verify', `refs/heads/${branch}`], deps.project.path)
      const observedHead = observed.code === 0 ? observed.stdout.trim().toLowerCase() : ''
      if (!COMMIT_SHA_RE.test(observedHead) || observedHead !== expectedHead) {
        cleanupWarnings.push(
          `branch ${branch}: retained because its current tip no longer matches delivered HEAD ${expectedHead.slice(0, 12)}`,
        )
        continue
      }
      const deleted = await deps.git.run(['branch', '-D', branch], deps.project.path)
      if (deleted.code !== 0) {
        cleanupWarnings.push(`branch ${branch}: ${(deleted.stderr.trim() || deleted.stdout.trim()).split('\n')[0] || `exit ${deleted.code}`}`)
      }
    } catch (err) {
      cleanupWarnings.push(`branch ${branch}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}


export function releasableWorktreeIds(
  deps: PrDecisionDeps,
  snap: PrDeliverySnapshot,
): string[] {
  const preservedBranches = new Set(snap.branches.filter((unit) => !unitWasDelivered(unit)).map((unit) => unit.branch))
  return snap.worktreeIds.filter((id) => {
    const wt = getRailWorktree(deps.db, id)
    return !wt || !preservedBranches.has(wt.branch)
  })
}
