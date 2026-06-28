/**
 * Parallel-rail isolation gate (pure). Decides whether a rail launch's per-ticket
 * loop runs should each execute in their own git worktree (so concurrent AI CLIs
 * never collide on a shared working tree) and later be merged back.
 *
 * The decision is intentionally simple + side-effect-free so it is fully unit
 * tested; the worktree/merge plumbing lives in worktree-manager / merge-manager.
 *
 * Design stance (see openspec/changes/parallel-implementation-worktrees):
 *  - "mutates the repo" is the DEFAULT. A loop is read-only only when it explicitly
 *    says so — a false read-only would corrupt the shared tree, a false mutating
 *    only costs a (cleaned-up) empty worktree.
 *  - Isolation only matters when there are MULTIPLE concurrent writers, i.e. a
 *    per-ticket rail with >1 ticket. A single writer (N=1 / scope=all / standalone)
 *    has nothing to collide with and keeps today's shared-cwd behaviour.
 */

/** A loop mutates the repo unless it is explicitly flagged read-only. */
export function mutatesRepo(loop: { readOnly?: boolean }): boolean {
  return !loop.readOnly
}

/**
 * The isolation gate flag. **Opt-in during rollout**: worktree isolation runs
 * ONLY when `SPECRAILS_RAIL_WORKTREES` is `1`/`true`/`on`; otherwise every loop run
 * keeps the legacy single shared cwd (byte-identical to before this feature). This
 * lets the integration land inert and be validated on a live rail before it is
 * flipped to default-on. Read per-call so a test can flip the env without
 * re-importing.
 */
export function isRailWorktreesEnabled(): boolean {
  const v = (process.env.SPECRAILS_RAIL_WORKTREES ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on'
}

export interface IsolationDecisionInput {
  /** Loops feature enabled for the server. */
  loopsEnabled: boolean
  /** Rail launch scope — only per-ticket fans out concurrent writers. */
  scope: 'per-ticket' | 'all'
  /** Number of tickets the rail will fan out over. */
  ticketCount: number
  /** The chosen loop's read-only flag (absent ⇒ mutating). */
  readOnly?: boolean
}

/**
 * True when this launch should isolate each ticket's run in its own worktree.
 * ALL must hold: loops enabled, kill-switch off, per-ticket scope, >1 ticket, and
 * the loop mutates the repo.
 */
export function isolationApplies(input: IsolationDecisionInput): boolean {
  return (
    input.loopsEnabled &&
    isRailWorktreesEnabled() &&
    input.scope === 'per-ticket' &&
    input.ticketCount > 1 &&
    mutatesRepo({ readOnly: input.readOnly })
  )
}
