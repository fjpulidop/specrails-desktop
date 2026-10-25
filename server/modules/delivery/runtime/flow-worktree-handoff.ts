/**
 * Flow -> rail worktree hand-off contract (Flow mode, arch section 4.4).
 *
 * While a Flow is live its worktree is owned by `flow_sessions`, never by
 * `rail_worktrees`. A rail launch adopts it through `requiredFlowWorktree`:
 * the worktree is reused exactly (same mount, branch and frozen HEAD) and the
 * ownership transfer — the `rail_worktrees` row plus the Flow's own state —
 * commits in ONE SQLite transaction that delivery owns. Flow supplies only the
 * callbacks below; delivery never issues SQL against Flow's table and Flow
 * never imports delivery's launch internals.
 */

export interface FlowAdoption {
  railIndex: number
  runId: string
  ledgerId: string
  deliveryId: string | null
  /** HEAD observed on the adopted mount (equals the frozen Flow HEAD). */
  headSha: string
}

export interface RequiredFlowWorktree {
  flowId: string
  /** The project repository the Flow worktree belongs to: a non-primary Git
   * member launches as that ONE repository (a single-repository group whose
   * parent delivery the Flow adopts). Absent ⇒ the primary repository. */
  repositoryId?: string | null
  branch: string
  worktreePath: string
  /** HEAD the Flow froze before the hand-off; the mount must expose exactly it. */
  headSha: string
  /** Commit the Flow branched from: the delivery hygiene and change baseline. */
  baseSha?: string | null
  /** Bounded conversation summary (user messages and decisions) that the
   * Flow -> Spec loop hands Core's derive-change piece. */
  summary?: string
  /** The OpenSpec change this Flow's earlier Flow -> Spec run derived (still
   * active in the worktree): the run re-derives it in place. Null/absent ⇒ the
   * first derivation, named after the spec title. */
  changeId?: string | null
  /** Runs inside the launch transaction that inserts the `rail_worktrees` row.
   * Throwing aborts the transaction and the launch. */
  adopt(adoption: FlowAdoption): void
  /** Runs inside the transaction that removes the adopted ledger row when the
   * launch rolls back after adoption: ownership returns to the Flow. */
  release(reason: string): void
}

/** The mount, branch or HEAD differs from what the Flow froze (HTTP 409). */
export class FlowWorktreeMismatchError extends Error {
  readonly code = 'flow_worktree_mismatch'
  constructor(message: string) {
    super(message)
    this.name = 'FlowWorktreeMismatchError'
  }
}

/** The Flow is not waiting for this hand-off (HTTP 409). */
export class FlowHandOffNotReadyError extends Error {
  readonly code = 'flow_handoff_not_ready'
  constructor(message: string) {
    super(message)
    this.name = 'FlowHandOffNotReadyError'
  }
}

/** Per-project hand-off authority registered by the composition root. */
export interface FlowHandOffAuthority {
  /** The worktree contract of a Flow waiting for this launch, or throws
   * `FlowHandOffNotReadyError`. */
  resolve(flowId: string): RequiredFlowWorktree & { ticketId: number; conversationId: string }
}
