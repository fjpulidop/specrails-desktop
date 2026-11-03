/**
 * Intent -> rail worktree hand-off contract (Intent mode, arch section 4.4).
 *
 * While an Intent session is live its worktree is owned by `flow_sessions`, never by
 * `rail_worktrees`. A rail launch adopts it through `requiredFlowWorktree`:
 * the worktree is reused exactly (same mount, branch and frozen HEAD) and the
 * ownership transfer — the `rail_worktrees` row plus the Intent's own state —
 * commits in ONE SQLite transaction that delivery owns. Intent supplies only the
 * callbacks below; delivery never issues SQL against Intent's table and Intent
 * never imports delivery's launch internals.
 */

export interface IntentAdoption {
  railIndex: number
  runId: string
  ledgerId: string
  deliveryId: string | null
  /** HEAD observed on the adopted mount (equals the frozen Intent HEAD). */
  headSha: string
}

export interface RequiredFlowWorktree {
  flowId: string
  /** The project repository the Intent worktree belongs to: a non-primary Git
   * member launches as that ONE repository (a single-repository group whose
   * parent delivery the Intent adopts). Absent ⇒ the primary repository. */
  repositoryId?: string | null
  branch: string
  worktreePath: string
  /** HEAD the Intent froze before the hand-off; the mount must expose exactly it. */
  headSha: string
  /** Commit the Intent branched from: the delivery hygiene and change baseline. */
  baseSha?: string | null
  /** Bounded conversation summary (user messages and decisions) that the
   * Intent -> Spec loop hands Core's derive-change piece. */
  summary?: string
  /** The OpenSpec change this Intent's earlier Intent -> Spec run derived (still
   * active in the worktree): the run re-derives it in place. Null/absent ⇒ the
   * first derivation, named after the spec title. */
  changeId?: string | null
  /** Runs inside the launch transaction that inserts the `rail_worktrees` row.
   * Throwing aborts the transaction and the launch. */
  adopt(adoption: IntentAdoption): void
  /** Runs inside the transaction that removes the adopted ledger row when the
   * launch rolls back after adoption: ownership returns to the Intent. */
  release(reason: string): void
}

/** The mount, branch or HEAD differs from what the Intent froze (HTTP 409). */
export class IntentWorktreeMismatchError extends Error {
  readonly code = 'flow_worktree_mismatch'
  constructor(message: string) {
    super(message)
    this.name = 'IntentWorktreeMismatchError'
  }
}

/** The Intent is not waiting for this hand-off (HTTP 409). */
export class IntentHandOffNotReadyError extends Error {
  readonly code = 'flow_handoff_not_ready'
  constructor(message: string) {
    super(message)
    this.name = 'IntentHandOffNotReadyError'
  }
}

/** Per-project hand-off authority registered by the composition root. */
export interface IntentHandOffAuthority {
  /** The worktree contract of an Intent session waiting for this launch, or throws
   * `IntentHandOffNotReadyError`. */
  resolve(flowId: string): RequiredFlowWorktree & { ticketId: number; conversationId: string }
}
