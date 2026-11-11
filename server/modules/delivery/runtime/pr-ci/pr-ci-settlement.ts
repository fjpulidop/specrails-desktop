import type { GitRunner } from '../../../../worktree-manager'
import type { DeliverBranchRecord } from '../rail-pr-store'
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
