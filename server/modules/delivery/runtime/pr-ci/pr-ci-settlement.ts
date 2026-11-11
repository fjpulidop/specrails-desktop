import fs from 'node:fs'
import type { DbInstance } from '../../../../db'
import type { GitRunner } from '../../../../worktree-manager'
import { toPrDeliverySnapshot, transitionDecision, type DeliverBranchRecord, type RailPrDeliveryRow } from '../rail-pr-store'
import type { PrDecision, PrDeliveryStatusCode } from '../../domain/state'
import { isExactOpenPr, observePrLifecycle } from '../pr-lifecycle'
import type { Exec } from '../pr-publisher'

/**
 * Settlement of a `factory:pr-ci` generation (pr-ci-loop).
 *
 * The deliverable of a CI loop is the pull request itself, never a new local
 * implementation: whether the loop ends green or stops (checks that are not the
 * code's fault, budget, blocker), the generation stays attached to its OPEN PR
 * at the exact head GitHub exposes, with the CI outcome as its status. It never
 * becomes "implementation failed". Work the loop did not verify and push is
 * kept on a delivery-owned ref and the branch returns to the PR head, so the
 * next continuation ("Fix CI" again, a review follow-up) admits it.
 *
 * Returns null when the PR cannot be proven OPEN with the same identity (closed,
 * merged, retargeted, unverifiable, or moved by someone else): the ordinary
 * continuation settlement then applies unchanged.
 */
export interface PrCiSettlementInput {
  git: GitRunner
  exec: Exec
  baseRepo: string
  deliveryId: string
  continuation: { prUrl: string; branch: string; baseBranch: string }
  /** The run's worktrees (one per run of this repository). */
  worktrees: string[]
  /** Core's completion of the run: `ok` means CI ended green (or the PR has no checks). */
  completion: { ok: boolean; reasons: string[] } | null
  branches: DeliverBranchRecord[]
}
export interface PrCiSettlement {
  next: Extract<PrDecision, 'pr_draft' | 'pr_ready'>
  deliverySha: string
  statusCode: Extract<PrDeliveryStatusCode, 'ci_green' | 'ci_needs_attention'>
  statusDetail: string | null
  branches: DeliverBranchRecord[]
  /** Unverified local work moved off the PR branch, when there was any. */
  keptRef: string | null
}

const SHA_RE = /^[0-9a-f]{40,64}$/i
export const prCiKeptRef = (deliveryId: string): string => `refs/specrails/pr-ci/${deliveryId}`

export async function settlePrCiGeneration(input: PrCiSettlementInput): Promise<PrCiSettlement | null> {
  const observed = await observePrLifecycle(input.exec, input.baseRepo, input.continuation.prUrl)
  if (!observed.ok || !isExactOpenPr(observed, input.continuation.branch, input.continuation.baseBranch)) return null
  const prHead = observed.headRefOid?.toLowerCase()
  if (!prHead || !SHA_RE.test(prHead)) return null
  let keptRef: string | null = null
  for (const worktree of input.worktrees) {
    const head = await input.git.run(['rev-parse', '--verify', 'HEAD'], worktree)
    const local = head.stdout.trim().toLowerCase()
    if (head.code !== 0 || !SHA_RE.test(local)) return null
    if (local === prHead) continue
    // Only local commits on top of the PR head are ours to move; anything else
    // (someone pushed meanwhile) is left to the ordinary settlement.
    if ((await input.git.run(['merge-base', '--is-ancestor', prHead, 'HEAD'], worktree)).code !== 0) return null
    keptRef = prCiKeptRef(input.deliveryId)
    if ((await input.git.run(['update-ref', keptRef, local], worktree)).code !== 0) return null
    if ((await input.git.run(['reset', '--hard', prHead], worktree)).code !== 0) return null
  }
  const green = input.completion?.ok === true
  const reason = (input.completion?.reasons ?? []).filter(Boolean).join(' ').trim()
  const detail = green ? null : [
    reason || 'The CI loop stopped before the checks turned green.',
    keptRef ? `Unverified local changes were not pushed; they are kept at ${keptRef}.` : '',
  ].filter(Boolean).join(' ').slice(0, 4000)
  return {
    next: observed.isDraft === false ? 'pr_ready' : 'pr_draft',
    deliverySha: prHead,
    statusCode: green ? 'ci_green' : 'ci_needs_attention',
    statusDetail: detail,
    branches: input.branches.map(unit => ({ ...unit, succeeded: true, implementationOutcome: 'succeeded', deliveryOutcome: 'ready', finalSha: prHead, failureCode: null })),
    keptRef,
  }
}

/**
 * "Run again" on a CI loop generation that ended as an implementation failure
 * (settled before the CI settlement existed, or when its PR could not be
 * proven OPEN at the time): re-attach it to its PR so the CI loop can run on it
 * again. Each repository row is settled exactly like a finished loop: proven
 * OPEN at the head GitHub exposes, unverified local commits kept on
 * `prCiKeptRef`, status `ci_needs_attention`. All-or-nothing per row; returns
 * false (nothing changed for that row) when a PR is not provably OPEN or its
 * branch moved. The caller refreshes a multi-repository parent afterwards.
 */
export async function resettleFailedPrCiRows(input: {
  db: DbInstance
  git: GitRunner
  exec: Exec
  rows: RailPrDeliveryRow[]
  fallbackRepo: string
}): Promise<boolean> {
  for (const row of input.rows) {
    if (row.decision !== 'implementation_failed') continue
    if (!row.pr_url || !row.branch) return false
    const worktrees = mountedWorktrees(input.db, row)
    const settled = await settlePrCiGeneration({
      git: input.git, exec: input.exec, baseRepo: row.repository_path ?? input.fallbackRepo, deliveryId: row.id,
      continuation: { prUrl: row.pr_url, branch: row.branch, baseBranch: row.base_branch },
      worktrees,
      completion: { ok: false, reasons: [row.status_detail ?? ''] },
      branches: toPrDeliverySnapshot(row).branches,
    })
    if (!settled) return false
    if (!transitionDecision(input.db, row.id, 'implementation_failed', settled.next, {
      implementationOutcome: 'succeeded', deliveryOutcome: 'delivered',
      statusCode: settled.statusCode, statusDetail: settled.statusDetail,
      deliverySha: settled.deliverySha, branches: settled.branches,
    })) return false
  }
  return true
}

/** The run worktrees of a row that are still mounted on disk. */
function mountedWorktrees(db: DbInstance, row: RailPrDeliveryRow): string[] {
  let ids: string[] = []
  try { ids = (JSON.parse(row.worktree_ids) as unknown[]).filter((id): id is string => typeof id === 'string') } catch { return [] }
  return ids.flatMap(id => {
    const wt = db.prepare('SELECT worktree_path, merge_state FROM rail_worktrees WHERE id = ?').get(id) as { worktree_path: string; merge_state: string | null } | undefined
    return wt && wt.merge_state !== 'released' && fs.existsSync(wt.worktree_path) ? [wt.worktree_path] : []
  })
}
