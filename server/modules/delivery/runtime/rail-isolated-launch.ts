/**
 * Isolated (worktree-per-ticket) rail launch — the live wiring that turns the
 * tested building blocks (worktree-manager, merge-manager, rail-merge-orchestrator,
 * ledger) into a running parallel rail. Gated OFF by default (rail-isolation's
 * opt-in flag), so this path is inert unless explicitly enabled.
 *
 * Intent: allocate one worktree+branch per independent delivery → fan out the loop
 * runs IN those worktrees (so concurrent AI CLIs never collide) → when ALL runs
 * settle, run the sequential validated merge-back on the base repo, then clean
 * up worktrees. Tickets continuing one PR are grouped into its single checkout.
 *
 * The run spawns with cwd = the worktree (and repoDir = the worktree, so
 * writes/git land there). Because `git worktree add` materializes only TRACKED
 * files, each worktree gets a PER-RUN OVERLAY at allocation
 * (worktree-overlay.ts): the framework surface (`/specrails:*` commands, sr-*
 * agents, skills, rules, `.mcp.json`, the instruction file) is merge-linked in
 * from the project's EFFECTIVE artifact root — the workspace for RELOCATED
 * projects, the repo's own on-disk untracked entries for legacy ones — never
 * overwriting anything the checkout brought. Overlay entries are excluded from
 * `commitWorktree` so they never land on the ticket branch/PR; overlay failures
 * degrade (log + `rail.overlay_degraded` broadcast) instead of aborting the
 * rail. Relocated artifact state (tickets/backlog/profiles) reaches the spawn
 * via the executors' base env (see workspace-resolution.resolveLoopBaseEnv).
 *
 * The launch runs as explicit stages (each in its own file, all composed here):
 * 0. validation & frozen scope — rail-isolated-launch-scope.ts
 * 1. worktree preparation (repo-locked allocation) — rail-isolated-launch-allocation.ts
 * 2. run launch (fan-out + per-run settlement) — rail-isolated-launch-runs.ts
 * 3. delivery/settlement wiring — rail-isolated-launch-settlement.ts, with the
 *    PR decision in rail-isolated-launch-pr-decision.ts
 * The delivery-row publisher, contracts, helpers, the shared per-run Git
 * settlement and restart recovery live in their own files; this module keeps
 * the public entry points.
 */
import { defaultGitRunner, removeWorktree } from '../../../worktree-manager'
import { isolatedWorktreesRoot, resolveOverlaySources } from './isolated-worktree'
import { resolveProjectExecution } from '../../../workspace-resolution'
import { defaultExec } from './pr-publisher'
import type { IsolatedLaunchInput, IsolatedLaunchIO } from './rail-isolated-launch-contracts'
import { routeLaunchRepositories, freezeLaunchScope } from './rail-isolated-launch-scope'
import { createLaunchDeliveryPublisher, type LaunchDeliveryState } from './rail-isolated-launch-delivery-state'
import { allocateIsolatedRuns } from './rail-isolated-launch-allocation'
import { startIsolatedRuns } from './rail-isolated-launch-runs'
import { scheduleIsolatedSettlement } from './rail-isolated-launch-settlement'

export {
  PrContinuationIsolationError, RUN_STOPPED_DETAIL, isStoppedByPerson,
  type AllocatedRun, type IsolatedLaunchInput, type IsolatedLaunchIO, type SettledRun,
} from './rail-isolated-launch-contracts'
export { buildSpecSnapshot } from './rail-isolated-launch-support'
export { reattachIsolatedSettlement, reconcileRailWorktrees } from './rail-isolated-recovery'

/**
 * Launch the rail's tickets in isolated worktrees + schedule the merge-back.
 * Returns the loop run ids. Throws if worktree allocation fails, but only after
 * tearing down owned partial allocation. The router refuses shared-cwd
 * fallback for these errors; execution stays bound to a verified worktree.
 */
export async function launchIsolatedRail(input: IsolatedLaunchInput, io: IsolatedLaunchIO = {}): Promise<string[]> {
  // 0. Validation & frozen scope.
  const route = routeLaunchRepositories(input, io)
  if (route instanceof Promise) return route
  input = route.input
  const { singleRepositoryId, expectedRepositoryBaseSha } = route
  const { ctx, railIndex, ticketIds } = input
  const git = io.git ?? defaultGitRunner
  const exec = io.exec ?? defaultExec
  const remove = io.remove ?? removeWorktree
  const resolveExecution = io.resolveExecution ?? resolveProjectExecution
  const baseRepo = ctx.project.path
  const slug = ctx.project.slug
  const worktreesRoot = isolatedWorktreesRoot(slug, input.repositoryExecution?.repositoryId)
  const { constants, addendaStorePath, addendaPlan, claimedAddendaByRun, prMode, units } = freezeLaunchScope(input)

  // Ask-first PR delivery (safe-pr-review-flow): persist the authoritative
  // decision row UP FRONT (decision='building') — so the origin link survives
  // every await and late-joining clients hydrate mid-build via GET /rails —
  // and re-broadcast the durable rail.pr_state snapshot on every mutation.
  const deliveryState: LaunchDeliveryState = { prDeliveryId: null, supersededDelivery: null }
  const delivery = createLaunchDeliveryPublisher(ctx, railIndex, ticketIds, deliveryState)

  // Effective artifact root for the per-worktree overlay (relocated workspace
  // vs the repo's own untracked entries, plus the provider's dir/instruction
  // file). Resolved ONCE per launch; see resolveOverlaySources.
  const overlaySources = resolveOverlaySources({ slug, baseRepo, provider: input.provider }, resolveExecution)
  // Degraded overlay = the run may be missing native commands/agents. Never
  // aborts the rail (a partial surface beats no run) but MUST be visible:
  // stderr-style server log + a project-scoped WS event.
  const notifyOverlayDegraded = (ticketId: number, warnings: string[]): void => {
    console.error(`[rail-isolated] worktree overlay degraded (ticket ${ticketId}): ${warnings.join('; ')}`)
    try {
      ctx.broadcast({ type: 'rail.overlay_degraded', projectId: ctx.project.id, railIndex, ticketId, warnings })
    } catch { /* non-fatal */ }
  }

  // 1. Worktree preparation (serialized per base repo, all-or-nothing).
  const { launchContinuation, allocated } = await allocateIsolatedRuns({
    input, io, git, exec, remove, baseRepo, slug, worktreesRoot, prMode, units,
    addendaStorePath, addendaPlan, claimedAddendaByRun, overlaySources, notifyOverlayDegraded,
    expectedRepositoryBaseSha, deliveryState, delivery,
  })

  // 2. Run launch: one loop run per worktree, each with its deferred settlement.
  const { guardedRunPromises, markWorktree } = startIsolatedRuns({
    input, io, git, baseRepo, prMode, constants, claimedAddendaByRun, singleRepositoryId,
    overlaySources, launchContinuation, allocated, deliveryState, delivery,
  })

  // 3. Delivery / settlement wiring + PR decision (background).
  scheduleIsolatedSettlement({
    input, io, git, exec, remove, resolveExecution, baseRepo, prMode, constants,
    launchContinuation, allocated, guardedRunPromises, markWorktree, deliveryState, delivery,
  })

  return allocated.map((a) => a.runId)
}
