/**
 * Isolated (worktree-per-ticket) rail launch — the live wiring that turns the
 * tested building blocks (worktree-manager, merge-manager, rail-merge-orchestrator,
 * ledger) into a running parallel rail. Gated OFF by default (rail-isolation's
 * opt-in flag), so this path is inert unless explicitly enabled.
 *
 * Flow: allocate one worktree+branch per ticket → fan out the loop runs IN those
 * worktrees (so concurrent AI CLIs never collide) → when ALL runs settle, run the
 * sequential validated merge-back on the base repo, then clean up worktrees.
 *
 * NOTE (v1 scope): the run spawns with cwd = the worktree (and repoDir = the
 * worktree). This is correct for legacy projects and for loops whose steps are
 * generic prompts (e.g. autoloop-tdd). A relocated project running a loop that
 * needs the workspace's native `/specrails:*` commands requires a per-run
 * workspace overlay — that overlay is the documented follow-up; until then enable
 * isolation for those only after validating.
 */
import * as path from 'path'
import { resolveHome } from './artifact-registry'
import { newId } from './ids'
import { loadConstantMap } from './loop-constants'
import { defaultGitRunner, createWorktree, removeWorktree, commitWorktree, type GitRunner, type WorktreeHandle } from './worktree-manager'
import { createRailWorktree, updateRailWorktreeState, listNonTerminalRailWorktrees } from './rail-worktrees-store'
import type { DbInstance } from './db'
import { getProjectSettings } from './db'
import { resolveIntegrationBranch } from './integration-branch'
import { isRailPrDeliveryEnabled } from './rail-isolation'
import { deliverRailAsPr, buildBatchPrBody } from './rail-pr-delivery'
import { defaultExec } from './pr-publisher'
import { runMergeBack } from './rail-merge-orchestrator'
import { createLoopExecutors } from './loop-executors'
import type { BranchToMerge } from './merge-manager'
import type { LoopGraph } from './loop-graph'
import type { ProjectContext } from './project-registry'
import type { ReasoningEffort } from './providers/types'

export interface IsolatedLaunchInput {
  ctx: ProjectContext
  railIndex: number
  ticketIds: number[]
  loopId: string
  loopName: string
  loopGraph: LoopGraph
  provider: string
  model: string
  effort?: ReasoningEffort
}

/** Injectable git/worktree IO (defaults to the real implementations) — lets the
 *  allocation + teardown logic be unit-tested without a real repo. */
export interface IsolatedLaunchIO {
  git?: GitRunner
  create?: typeof createWorktree
  remove?: typeof removeWorktree
}

interface AllocatedRun {
  ticketId: number
  runId: string
  ledgerId: string
  handle: WorktreeHandle
}

/**
 * Launch the rail's tickets in isolated worktrees + schedule the merge-back.
 * Returns the loop run ids. Throws if worktree allocation fails (the caller then
 * falls back to the shared-cwd path) — but only after tearing down any partial
 * allocation, so a failure never leaves orphaned worktrees.
 */
export async function launchIsolatedRail(input: IsolatedLaunchInput, io: IsolatedLaunchIO = {}): Promise<string[]> {
  const { ctx, railIndex, ticketIds, loopId, loopName, loopGraph, provider, model, effort } = input
  const git = io.git ?? defaultGitRunner
  const create = io.create ?? createWorktree
  const remove = io.remove ?? removeWorktree
  const baseRepo = ctx.project.path
  const slug = ctx.project.slug
  const worktreesRoot = path.join(resolveHome(), '.specrails', 'projects', slug, 'worktrees')
  const constants = loadConstantMap(ctx.desktopDb)

  // Resolve the project's designated integration branch ONCE, and branch every
  // ticket's worktree off it (not the ambient HEAD). Empty setting → auto-resolve
  // (repo default → HEAD fallback). See server/integration-branch.ts.
  const integration = await resolveIntegrationBranch(git, {
    repoDir: baseRepo,
    projectSetting: getProjectSettings(ctx.db).integrationBranch,
  })

  // 1. Allocate ALL worktrees up front (all-or-nothing) so a mid-way failure
  //    can't leave the rail half-isolated.
  const allocated: AllocatedRun[] = []
  try {
    for (const ticketId of ticketIds) {
      const handle = await create(git, { repoDir: baseRepo, worktreesRoot, slug, ticketId, baseRef: integration.branch })
      const runId = newId()
      const ledgerId = newId()
      createRailWorktree(ctx.db, {
        id: ledgerId, railIndex, ticketId, runId,
        branch: handle.branch, worktreePath: handle.worktreePath,
      })
      allocated.push({ ticketId, runId, ledgerId, handle })
    }
  } catch (err) {
    for (const a of allocated) {
      await remove(git, { repoDir: baseRepo, worktreePath: a.handle.worktreePath, branch: a.handle.branch }).catch(() => {})
    }
    throw err
  }

  // 2. Fan out: one loop run per ticket, spawning IN its worktree.
  const runPromises: Promise<{ run: AllocatedRun; succeeded: boolean }>[] = []
  for (const a of allocated) {
    ctx.railLoopRuns.set(a.runId, { railIndex, ticketIds: [a.ticketId] })
    const spec = ctx.getTicketSpec(a.ticketId)
    const p = ctx.loopRunManager
      .run({
        runId: a.runId, loopId, loopName, graph: loopGraph, projectId: ctx.project.id,
        cwd: a.handle.worktreePath, repoDir: a.handle.worktreePath,
        isolation: { branch: a.handle.branch, worktreePath: a.handle.worktreePath },
        railIndex, ticketId: a.ticketId,
        spec: spec ? { ...spec, ticketIds: [a.ticketId] } : { ticketIds: [a.ticketId] },
        constants, provider, model, effort,
      })
      .then(async (r) => {
        ctx.onLoopRunFinished(r.runId, r.outcome)
        const succeeded = r.outcome === 'success'
        // Commit the run's work to its branch so the merge-back can integrate it
        // (loops like autoloop-tdd don't commit) and a re-launch can resume it.
        await commitWorktree(git, a.handle.worktreePath, `specrails: ticket-${a.ticketId} (run ${a.runId})`)
        updateRailWorktreeState(ctx.db, a.ledgerId, succeeded ? 'built' : 'failed')
        return { run: a, succeeded }
      })
      .catch(async (err) => {
        console.error('[rail-isolated] loop run failed:', err)
        ctx.onLoopRunFinished(a.runId, 'failed')
        // Commit partial work too → durable in git → resumable on re-launch.
        await commitWorktree(git, a.handle.worktreePath, `specrails: ticket-${a.ticketId} partial (run ${a.runId})`)
        updateRailWorktreeState(ctx.db, a.ledgerId, 'failed')
        return { run: a, succeeded: false }
      })
    runPromises.push(p)
    try { ctx.jiraSyncManager.onRailLaunch([a.ticketId], a.runId) } catch { /* non-fatal */ }
  }

  // 3. When ALL runs settle → integrate on the base repo (background; the HTTP
  //    response has already returned the run ids). Two mutually-exclusive paths:
  //     • DEFAULT (flag off): legacy local merge-back into the checked-out branch.
  //     • SPECRAILS_RAIL_DELIVER_PR on: assemble the ticket branches into a batch
  //       branch off the designated integration branch and open ONE draft PR —
  //       specrails never merges into base (safe-pr-workflow).
  void Promise.allSettled(runPromises).then(async (settled) => {
    const results = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))
    const branches: BranchToMerge[] = results.map((r) => ({
      ticketId: r.run.ticketId, branch: r.run.handle.branch, succeeded: r.succeeded,
    }))

    if (isRailPrDeliveryEnabled()) {
      try {
        const succeededTickets = results.filter((r) => r.succeeded).map((r) => ({
          ticketId: r.run.ticketId, title: ctx.getTicketSpec(r.run.ticketId)?.title,
        }))
        const delivery = await deliverRailAsPr(git, defaultExec, {
          baseRepo, integrationBranch: integration.branch, slug,
          railKey: `${railIndex}-${loopId}`, batchWorktreeRoot: worktreesRoot,
          branches,
          title: `${loopName}: ${succeededTickets.length} ticket(s)`,
          body: buildBatchPrBody(loopName, succeededTickets),
        })
        ctx.broadcast({
          type: 'rail.pr_delivered', projectId: ctx.project.id, railIndex,
          delivery: delivery.state,
          ...(delivery.state === 'delivered'
            ? { prState: delivery.pr.state, prUrl: delivery.pr.prUrl, branch: delivery.branch }
            : {}),
        })
      } catch (err) {
        console.error('[rail-isolated] pr-delivery failed:', err)
      }
      return
    }

    try {
      const outcomes = await runMergeBack({
        git, executor: createLoopExecutors(), baseDir: baseRepo,
        provider, model, effort, constants, branches,
        // CRIT-2: record every merge-back AI step (verify/resolve-merge/fix) as a
        // `surface='job'` invocation tied to the rail (surface_ref_id
        // `${jobId}:merge:${step}`), primary ticket = ticketIds[0].
        recording: {
          db: ctx.db,
          projectId: ctx.project.id,
          jobId: `rail-${railIndex}-${loopId}`,
          ticketId: ticketIds[0] ?? null,
          broadcast: (msg) => ctx.broadcast(msg),
        },
        onState: (ticketId, state) => {
          const r = results.find((x) => x.run.ticketId === ticketId)
          if (state === 'merged' || state === 'needs-review') {
            if (r) updateRailWorktreeState(ctx.db, r.run.ledgerId, state)
            ctx.broadcast({ type: 'rail.worktree_progress', projectId: ctx.project.id, railIndex, ticketId, state })
          }
        },
      })
      for (const o of outcomes) {
        const r = results.find((x) => x.run.ticketId === o.ticketId)
        if (!r) continue
        // Merged → drop the branch; needs-review / skipped → keep the branch for the human.
        await remove(git, {
          repoDir: baseRepo, worktreePath: r.run.handle.worktreePath, branch: o.branch,
          deleteBranch: o.state === 'merged',
        }).catch(() => {})
      }
    } catch (err) {
      console.error('[rail-isolated] merge-back failed:', err)
    }
  })

  return allocated.map((a) => a.runId)
}

/**
 * Startup reconciliation: a crash mid-fan-out leaves worktrees on disk and ledger
 * rows stuck in a non-terminal state. Remove each orphan's worktree (best-effort,
 * keeping its branch for inspection) and mark the row `failed`. No-op (no git
 * calls) when there are no stuck rows — so it is free for projects that never used
 * isolation. Returns how many rows were reconciled.
 */
export async function reconcileRailWorktrees(
  db: DbInstance,
  repoDir: string,
  io: { git?: GitRunner; remove?: typeof removeWorktree } = {}
): Promise<number> {
  const git = io.git ?? defaultGitRunner
  const remove = io.remove ?? removeWorktree
  const stuck = listNonTerminalRailWorktrees(db)
  for (const row of stuck) {
    await remove(git, { repoDir, worktreePath: row.worktree_path, branch: row.branch, deleteBranch: false }).catch(() => {})
    updateRailWorktreeState(db, row.id, 'failed')
  }
  return stuck.length
}
