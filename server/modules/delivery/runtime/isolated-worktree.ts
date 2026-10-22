/**
 * Isolated worktree preparation — the single machinery that turns a ticket into
 * a dedicated, run-ready checkout. Shared by the isolated rail launch (which
 * owns batching, PR continuation, delivery rows and the rail ledger) and any
 * other consumer that needs "one fresh worktree for this ticket" (Flow).
 *
 * `materializeIsolatedWorktree` is the lock-free core: create/reuse the mount,
 * verify its HEAD, apply the per-run framework overlay, link warm
 * `node_modules` and freeze the Code-Explorer provenance snapshot. The caller
 * MUST hold `withRepoLock(repoDir)`. A verification failure removes only the
 * resources this call created (ownership-aware rollback) and rethrows.
 *
 * `prepareIsolatedWorktree` is the self-contained public entry: it takes the
 * repository lock, refreshes remote-tracking refs, resolves the base ref and
 * conventional branch name exactly as a rail launch does, then materializes.
 * It records no rail ledger row; the caller owns the returned checkout.
 */
import * as path from 'path'
import { resolveHome } from '../../../artifact-registry'
import { newId } from '../../../ids'
import { getProjectSettings } from '../../../db'
import { getLinkByLocalId } from '../../../jira/jira-db'
import { getAdapter } from '../../../providers'
import { isCodeExplorerEnabled } from '../../../feature-flags'
import { withRepoLock } from '../../../repo-lock'
import { getProjectRepositories } from '../../../project-repositories'
import { resolveProjectExecution } from '../../../workspace-resolution'
import { fetchOrigin, resolveIntegrationBranch, resolveWorktreeBaseRef } from '../../../integration-branch'
import {
  createWorktree, defaultGitRunner, listLocalBranches, removeWorktree, worktreeBranch,
  type GitRunner, type WorktreeHandle,
} from '../../../worktree-manager'
import { applyWorktreeOverlay, type OverlayCleanupEvidence } from '../../../worktree-overlay'
import { linkNodeModulesIntoWorktree } from '../../../worktree-node-modules'
import { snapshotWorkingTree, type WorkingTreeSnapshot } from '../../code/runtime/file-provenance'
import { resolveCollisionFreeName, ticketBranchName, type TicketNamingInput } from './pr-naming'
import type { ProjectContext } from '../../../project-registry'

const COMMIT_SHA_RE = /^[0-9a-f]{40,64}$/i

/** Injectable git/worktree IO for worktree preparation (defaults to the real
 *  implementations). `IsolatedLaunchIO` extends this shape. */
export interface IsolatedWorktreeIO {
  git?: GitRunner
  create?: typeof createWorktree
  remove?: typeof removeWorktree
  /** Per-run framework overlay applied to each fresh worktree. */
  overlay?: typeof applyWorktreeOverlay
  /** Warm-dependency reuse: links the base checkout's node_modules into the
   *  fresh worktree so runs skip the cold `npm install`. */
  linkNodeModules?: typeof linkNodeModulesIntoWorktree
  /** Resolves the project's execution (relocated vs legacy) — decides the
   *  overlay's primary root and whether the repo is added as fallback. */
  resolveExecution?: typeof resolveProjectExecution
  /** Code-Explorer pre-run worktree snapshot. */
  snapshot?: typeof snapshotWorkingTree
}

/** `adopted`: a Flow worktree/branch the rail took over at hand-off. From the
 * adoption on the rail owns it fully, so release treats it like `created`;
 * allocation rollback never removes it (ownership returns to the Flow). */
export type IsolatedBranchOwnership = 'created' | 'preexisting' | 'borrowed-pr' | 'adopted'
export type IsolatedWorktreeOwnership = 'created' | 'preexisting' | 'adopted'

/** Where the per-worktree overlay reads the framework surface from. */
export interface OverlaySources {
  sourceRoot: string
  fallbackSourceRoots?: string[]
  providerDir: string
  instructionsFilename: string
}

/**
 * Ticket data for the conventional branch name (pr-naming): title/labels from
 * the ticket-spec reader, the Jira key resolved with the authoritative
 * `jira_links` row prevailing over the ticket's own `jira_key` field (JIRA
 * ALWAYS PREVAILS). Fully failure-tolerant — a missing store/link degrades to
 * the bare local ticket id.
 */
export function ticketNamingInput(ctx: ProjectContext, ticketId: number): TicketNamingInput {
  let spec: { title?: string; labels?: string[]; jira_key?: string | null } | undefined
  try {
    spec = ctx.getTicketSpec(ticketId) as typeof spec
  } catch {
    /* tolerated */
  }
  let jiraKey: string | null = spec?.jira_key ?? null
  try {
    const link = getLinkByLocalId(ctx.db, ticketId)
    if (link && !link.tombstoned && link.jiraKey) jiraKey = link.jiraKey
  } catch {
    /* tolerated */
  }
  return { ticketId, title: spec?.title ?? null, labels: spec?.labels ?? null, jiraKey }
}

export async function readHeadSha(git: GitRunner, cwd: string): Promise<string | null> {
  try {
    const result = await git.run(['rev-parse', '--verify', 'HEAD'], cwd)
    const sha = result.code === 0 ? result.stdout.trim() : ''
    return COMMIT_SHA_RE.test(sha) ? sha : null
  } catch {
    return null
  }
}

/** `~/.specrails/projects/<slug>/worktrees[/<repositoryId>]` — per-run mounts
 *  live beneath `<root>/<runId>`. */
export function isolatedWorktreesRoot(slug: string, repositoryId?: string): string {
  return path.join(resolveHome(), '.specrails', 'projects', slug, 'worktrees', ...(repositoryId ? [repositoryId] : []))
}

/**
 * Effective artifact root for the per-worktree overlay: a RELOCATED project's
 * framework surface (slash commands, sr-* agents, skills, rules, .mcp.json,
 * instruction file) lives in the WORKSPACE, not the repo — and `git worktree
 * add` materializes only TRACKED files, so without the overlay a relocated
 * worktree spawn has no `/specrails:*` commands at all. Legacy projects
 * overlay their repo's own untracked on-disk entries instead. A resolution
 * failure degrades to the legacy (repo) source; an unknown provider degrades
 * to claude-shaped defaults.
 */
export function resolveOverlaySources(
  input: { slug: string; baseRepo: string; provider: string },
  resolveExecution: typeof resolveProjectExecution = resolveProjectExecution,
): OverlaySources {
  let sourceRoot = input.baseRepo
  let fallbackSourceRoots: string[] | undefined
  try {
    const exec = resolveExecution({ slug: input.slug, path: input.baseRepo })
    if (exec.relocated && exec.workspaceDir) {
      sourceRoot = exec.workspaceDir
      // The repo as FALLBACK root: repo-resident untracked carve-outs
      // (OpenSpec's `/opsx:*` commands, `openspec-*` skills, user extras)
      // are absent from both the checkout (untracked) and the workspace
      // (the framework ships only `specrails/`), so without this the claude
      // CLI reports `Unknown command: /opsx:ff` inside isolated rails.
      fallbackSourceRoots = [input.baseRepo]
    }
  } catch { /* legacy fallback */ }
  let providerDir = '.claude'
  let instructionsFilename = 'CLAUDE.md'
  try {
    const adapter = getAdapter(input.provider)
    providerDir = adapter.projectDirName
    instructionsFilename = adapter.instructionsFilename
  } catch { /* unknown provider — claude-shaped defaults */ }
  return { sourceRoot, fallbackSourceRoots, providerDir, instructionsFilename }
}

export interface MaterializeIsolatedWorktreeInput {
  repoDir: string
  /** Run-specific mount root (`<isolatedWorktreesRoot>/<runId>`). */
  worktreesRoot: string
  slug: string
  ticketId: number
  baseRef: string
  branch: string
  /** Ownership known from branch planning (before createWorktree reports). */
  branchOwnership: IsolatedBranchOwnership
  /** True when branch identity is an external contract (PR continuation):
   *  createWorktree's report never downgrades the planned ownership. */
  pinBranchOwnership?: boolean
  refreshFromBaseRef?: boolean
  fresh?: boolean
  reuseBranchWorktree?: boolean
  /** Verifies the materialized checkout and returns its pre-run HEAD. Throwing
   *  rolls back resources this call created. Default: read HEAD. */
  verifyHead?: (handle: WorktreeHandle, git: GitRunner) => Promise<string | null>
  overlay: OverlaySources
  /** Degraded overlay/warm-link warnings (the run proceeds regardless). */
  onDegraded: (warnings: string[]) => void
}

export interface MaterializedIsolatedWorktree {
  handle: WorktreeHandle
  worktreePath: string
  branch: string
  /** HEAD observed before any agent runs. Null means Git could not prove it. */
  initialSha: string | null
  /** Worktree-relative overlay-owned (and warm-linked) paths — excluded from commits. */
  overlayExcludes: string[]
  overlayCleanupEvidence: OverlayCleanupEvidence[]
  warmLinkEvidence: OverlayCleanupEvidence[]
  provenanceSnapshot: WorkingTreeSnapshot | null
  branchOwnership: IsolatedBranchOwnership
  worktreeOwnership: IsolatedWorktreeOwnership
}

/**
 * Create (or resume) the worktree, verify it, then apply the overlay, warm
 * links and provenance snapshot. The caller holds the repository lock.
 */
export async function materializeIsolatedWorktree(
  input: MaterializeIsolatedWorktreeInput,
  io: IsolatedWorktreeIO = {},
): Promise<MaterializedIsolatedWorktree> {
  const git = io.git ?? defaultGitRunner
  const create = io.create ?? createWorktree
  const remove = io.remove ?? removeWorktree
  const overlay = io.overlay ?? applyWorktreeOverlay
  const handle = await create(git, {
    repoDir: input.repoDir,
    worktreesRoot: input.worktreesRoot,
    slug: input.slug,
    ticketId: input.ticketId,
    baseRef: input.baseRef,
    branch: input.branch,
    refreshFromBaseRef: input.refreshFromBaseRef,
    fresh: input.fresh,
    reuseBranchWorktree: input.reuseBranchWorktree,
  })
  const worktreeOwnership: IsolatedWorktreeOwnership = handle.worktreeCreated === false ? 'preexisting' : 'created'
  let branchOwnership = input.branchOwnership
  if (!input.pinBranchOwnership && (handle.branch !== input.branch || handle.branchCreated === false)) {
    branchOwnership = 'preexisting'
  }
  let initialSha: string | null
  try {
    initialSha = input.verifyHead
      ? await input.verifyHead(handle, git)
      : await readHeadSha(git, handle.worktreePath)
  } catch (err) {
    // Only unmount/delete resources this call actually created.
    if (worktreeOwnership === 'created') {
      await remove(git, {
        repoDir: input.repoDir,
        worktreePath: handle.worktreePath,
        branch: handle.branch,
        deleteBranch: branchOwnership === 'created',
      }).catch(() => {})
    }
    throw err
  }

  // Per-run overlay: merge-link the framework surface the checkout didn't
  // bring into the worktree (idempotent; resume-safe via its manifest).
  let overlayExcludes: string[] = []
  let overlayCleanupEvidence: OverlayCleanupEvidence[] = []
  try {
    const res = overlay({
      worktreePath: handle.worktreePath,
      sourceRoot: input.overlay.sourceRoot,
      fallbackSourceRoots: input.overlay.fallbackSourceRoots,
      providerDir: input.overlay.providerDir,
      instructionsFilename: input.overlay.instructionsFilename,
    })
    overlayExcludes = res.createdPaths
    overlayCleanupEvidence = res.cleanupEvidence ?? []
    if (res.warnings.length > 0) input.onDegraded(res.warnings)
  } catch (err) {
    // applyWorktreeOverlay never throws; this guards injected test doubles
    // and future edits — the spawn proceeds regardless.
    input.onDegraded([err instanceof Error ? err.message : String(err)])
  }
  // Warm-dependency reuse: link the base checkout's node_modules trees into
  // the fresh worktree (best-effort; a failure just leaves the run on the
  // legacy cold start). Linked paths join the overlay exclusion list so they
  // inherit the commit-time guarantees.
  let warmLinkEvidence: OverlayCleanupEvidence[] = []
  try {
    const nm = (io.linkNodeModules ?? linkNodeModulesIntoWorktree)(input.repoDir, handle.worktreePath)
    // `authenticated` (not `linked`) is the authorized set: it also covers
    // links a previous pass created, which a resumed launch would otherwise
    // leave both un-excluded from the commit and unauthorized for release.
    const authorized = nm.authenticated ?? nm.linked ?? []
    if (authorized.length > 0) overlayExcludes = overlayExcludes.concat(authorized)
    warmLinkEvidence = nm.evidence ?? []
    if (nm.warnings.length > 0) input.onDegraded(nm.warnings)
  } catch (err) {
    input.onDegraded([err instanceof Error ? err.message : String(err)])
  }
  // Code-Explorer provenance: freeze the worktree's pre-run state (HEAD sha +
  // the overlay's untracked set) so the settle diff attributes exactly the
  // run's own writes. Best-effort — a snapshot failure only loses provenance.
  let provenanceSnapshot: WorkingTreeSnapshot | null = null
  if (isCodeExplorerEnabled()) {
    try {
      provenanceSnapshot = (io.snapshot ?? snapshotWorkingTree)(handle.worktreePath)
    } catch (err) {
      console.warn(`[rail-isolated] provenance snapshot failed: ${(err as Error).message}`)
    }
  }
  return {
    handle,
    worktreePath: handle.worktreePath,
    branch: handle.branch,
    initialSha,
    overlayExcludes,
    overlayCleanupEvidence,
    warmLinkEvidence,
    provenanceSnapshot,
    branchOwnership,
    worktreeOwnership,
  }
}

export interface PrepareIsolatedWorktreeInput {
  ctx: ProjectContext
  ticketId: number
  /** Explicit base branch/ref. Omitted → the project's integration branch,
   *  preferring the freshly fetched `origin/<branch>`. */
  baseRef?: string | null
  /** Explicit new branch name. Omitted → conventional ticket branch name with
   *  collision suffixes. An existing branch is never reused (fails closed). */
  branch?: string | null
  /** Provider whose project dir/instruction file the overlay materializes. */
  provider: string
  /** Mount id (`<worktreesRoot>/<runId>`). Default: a new id. */
  runId?: string
  /** Degraded fetch/overlay/warm-link warnings. Default: server log only. */
  onDegraded?: (warnings: string[]) => void
}

export interface PreparedIsolatedWorktree extends MaterializedIsolatedWorktree {
  runId: string
  /** Ref the worktree was created from. */
  baseRef: string
  /** Frozen commit `baseRef` resolved to under the lock (null if unprovable). */
  baseSha: string | null
  /** Resolved integration branch name (the PR base). */
  integrationBranch: string
}

/**
 * Prepare one fresh isolated worktree for a ticket under the repository lock:
 * fetch, base ref resolution, branch planning, createWorktree, overlay, warm
 * links and provenance snapshot. Rollback removes only what this call created.
 * No rail ledger row is written; the caller owns the returned checkout and its
 * release (using the returned ownership flags).
 */
export async function prepareIsolatedWorktree(
  input: PrepareIsolatedWorktreeInput,
  io: IsolatedWorktreeIO = {},
): Promise<PreparedIsolatedWorktree> {
  const { ctx, ticketId } = input
  const git = io.git ?? defaultGitRunner
  const baseRepo = ctx.project.path
  const slug = ctx.project.slug
  const runId = input.runId ?? newId()
  const onDegraded = input.onDegraded ?? ((warnings: string[]) => {
    console.error(`[isolated-worktree] worktree preparation degraded (ticket ${ticketId}): ${warnings.join('; ')}`)
  })
  const overlaySources = resolveOverlaySources({ slug, baseRepo, provider: input.provider }, io.resolveExecution)
  return withRepoLock(baseRepo, async () => {
    const fetchResult = await fetchOrigin(git, baseRepo)
    const primary = getProjectRepositories(ctx.project).find((repo) => repo.isPrimary)
    const integration = await resolveIntegrationBranch(git, {
      repoDir: baseRepo,
      explicit: input.baseRef ?? undefined,
      projectSetting: primary?.integrationBranch ?? getProjectSettings(ctx.db).integrationBranch,
    })
    const worktreeBaseRef = await resolveWorktreeBaseRef(git, { repoDir: baseRepo, integration, fetchOk: fetchResult.ok })
    if (worktreeBaseRef.warning) onDegraded([worktreeBaseRef.warning])
    const frozen = await git.run(['rev-parse', '--verify', `${worktreeBaseRef.baseRef}^{commit}`], baseRepo)
    const frozenSha = frozen.code === 0 ? frozen.stdout.trim() : ''
    const baseSha = COMMIT_SHA_RE.test(frozenSha) ? frozenSha : null

    let branch = input.branch?.trim() || null
    if (!branch) {
      const taken = await listLocalBranches(git, baseRepo)
      branch = resolveCollisionFreeName(ticketBranchName(ticketNamingInput(ctx, ticketId)), {
        taken: (name) => taken.has(name),
        reserved: [integration.branch],
      }) ?? worktreeBranch(slug, ticketId)
    }
    const prepared = await materializeIsolatedWorktree({
      repoDir: baseRepo,
      worktreesRoot: path.join(isolatedWorktreesRoot(slug), runId),
      slug,
      ticketId,
      baseRef: worktreeBaseRef.baseRef,
      branch,
      branchOwnership: 'created',
      fresh: true,
      overlay: overlaySources,
      onDegraded,
    }, io)
    return { ...prepared, runId, baseRef: worktreeBaseRef.baseRef, baseSha, integrationBranch: integration.branch }
  })
}
