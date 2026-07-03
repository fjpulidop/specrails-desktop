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
 *  - When the flag is on we isolate EVERY mutating per-ticket run, not just rails
 *    with >1 ticket. Two separate single-ticket rails launched concurrently are
 *    ALSO concurrent writers on the same repo, and partial isolation is unsafe (an
 *    isolated rail merging back into another rail's dirty shared tree). So it is
 *    all-or-nothing: opt in (the flag) → everything isolates → always safe. The
 *    cross-rail merge-back is serialised by a per-repo lock. `scope: all` (one run)
 *    and standalone runs stay on the shared cwd (single writer by construction).
 */

/** A loop mutates the repo unless it is explicitly flagged read-only. */
export function mutatesRepo(loop: { readOnly?: boolean }): boolean {
  return !loop.readOnly
}

/**
 * The isolation gate flag. **Default-on kill-switch**: worktree isolation runs for
 * every repo-mutating per-ticket rail UNLESS `SPECRAILS_RAIL_WORKTREES` is set to
 * `0`/`false`/`off`, which restores the legacy single shared cwd (byte-identical to
 * before this feature). Default-on is safe because the launch path degrades
 * gracefully when isolation is unavailable — a non-git repo, an unborn HEAD, or a
 * worktree-allocation error all fall back to the shared cwd (see rails-router).
 * Read per-call so a test can flip the env without re-importing.
 */
export function isRailWorktreesEnabled(): boolean {
  const v = (process.env.SPECRAILS_RAIL_WORKTREES ?? '').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off'
}

/**
 * Flag for the draft-PR delivery path (safe-pr-workflow). **Default ON kill-switch**
 * — a settled isolated rail assembles its ticket branches onto a batch branch and
 * delivers ONE draft PR (specrails never merges into the base), UNLESS
 * `SPECRAILS_RAIL_DELIVER_PR` is set to `0`/`false`/`off`, which restores the legacy
 * local merge-back. Also gates injecting `SPECRAILS_GIT_AUTO=false` into rail spawns
 * so specrails-core's implement stops self-shipping. Kept separate from the
 * isolation gate so the two roll out independently.
 */
export function isRailPrDeliveryEnabled(): boolean {
  const v = (process.env.SPECRAILS_RAIL_DELIVER_PR ?? '').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off'
}

export interface IsolationDecisionInput {
  /** Loops feature enabled for the server. */
  loopsEnabled: boolean
  /** Rail launch scope — only per-ticket fans out per-ticket runs. */
  scope: 'per-ticket' | 'all'
  /** Number of tickets the rail will fan out over. */
  ticketCount: number
  /** The chosen loop's read-only flag (absent ⇒ mutating). */
  readOnly?: boolean
}

/**
 * True when this launch should isolate each ticket's run in its own worktree.
 * ALL must hold: loops enabled, flag on, per-ticket scope, at least one ticket,
 * and the loop mutates the repo. (Not gated on ticketCount>1 — concurrent
 * single-ticket rails are also concurrent writers; see the module note.)
 */
export function isolationApplies(input: IsolationDecisionInput): boolean {
  return (
    input.loopsEnabled &&
    isRailWorktreesEnabled() &&
    input.scope === 'per-ticket' &&
    input.ticketCount > 0 &&
    mutatesRepo({ readOnly: input.readOnly })
  )
}
