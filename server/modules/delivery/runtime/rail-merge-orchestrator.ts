/**
 * Wires the pure merge-back state machine (merge-manager) to the live AI executor
 * + git, building the three deps it needs:
 *   - verifyIntegrated → run `{{cmd:verify}}` on the integrated base, parse VERIFICATION: PASS
 *   - resolveConflict  → run `{{cmd:resolve-merge}}` on the conflict, then check no unmerged paths remain
 *   - rebaseAndFix     → run `{{cmd:fix}}` on the merged base, commit, re-verify
 *
 * Everything is injected (executor + git) so this orchestrator is unit-tested
 * without spawning a CLI or touching a real repo. The AI steps run in the BASE
 * repo (where the merges happen), using the rail's provider/model.
 */
import { expandCommands } from '../../loops/runtime/loop-command-catalog'
import { resolveConstants } from '../../loops/runtime/loop-constants'
import { mergeBack, type BranchToMerge, type MergeOutcome, type MergeState } from './merge-manager'
import { previewPairMerge, type PairMerge } from './merge-preview-git'
import { withRepoLock } from '../../../repo-lock'
import { recordInvocation } from '../../accounting/runtime/ai-invocations'
import { newId } from '../../../ids'
import type { DbInstance } from '../../../db'
import type { GitRunner } from '../../../worktree-manager'
import type { AiStepResult } from '../../loops/runtime/loop-run-manager'
import type { ReasoningEffort } from '../../../providers/types'

/** The subset of LoopExecutors the orchestrator needs (just AI steps). */
export interface MergeExecutor {
  runAiStep(input: {
    prompt: string
    provider: string
    model: string
    effort?: ReasoningEffort
    cwd: string
    repoDir?: string
  }): Promise<AiStepResult>
}

export interface MergeBackContext {
  git: GitRunner
  executor: MergeExecutor
  /** The repository where merges + verify/resolve/fix steps run. */
  baseDir: string
  provider: string
  model: string
  effort?: ReasoningEffort
  /** Resolved `{{const:*}}` map (loadConstantMap) for command-template expansion. */
  constants: Record<string, string>
  branches: BranchToMerge[]
  /** State sink (ledger + WS); receives 'merging' + the terminal MergeState. */
  onState?: (ticketId: number, state: MergeState | 'merging') => void
  /** Merge preview used to order the merge-back (default: merge-tree in a
   *  scratch object store; merge-preview-git.ts). */
  previewMerge?: (repoDir: string, baseSha: string, headSha: string) => Promise<PairMerge>
  /**
   * Cost-accounting sink (CRIT-2). When present, EVERY AI merge-back step
   * (verify / resolve-merge / fix) records an `ai_invocations` `surface='job'`
   * row (surface_ref_id = `${jobId}:merge:${step}`, ticket_id = the rail's
   * primary ticket, cost/estimated straight from `finaliseInvocationResult`
   * inside `runAiStep`) and broadcasts `spending.invalidated`. Omitted by the
   * pure unit tests that don't assert accounting → those steps stay untracked
   * (byte-identical legacy behaviour).
   */
  recording?: MergeStepRecording
}

/** Cost-accounting deps for the merge-back AI steps (CRIT-2). */
export interface MergeStepRecording {
  db: DbInstance
  projectId: string
  /** Rail identifier — surface_ref_id is `${jobId}:merge:${step}`. */
  jobId: string
  /** Primary ticket of the rail (ticketIds[0]) when resolvable. */
  ticketId?: number | null
  broadcast?: (msg: { type: 'spending.invalidated'; projectId: string }) => void
}

/**
 * Persist one merge-back AI step as a `surface='job'` invocation row. Cost /
 * estimated / tokens are already resolved by `finaliseInvocationResult` inside
 * `runAiStep` (native when the terminal `result` event arrived, estimated on
 * kill/timeout). A hard-failed step (spawn error / non-zero exit / timeout) is
 * recorded `status='failed'` so it never enters the success-only avg-cost.
 */
export function recordMergeStep(
  rec: MergeStepRecording,
  stepName: string,
  res: AiStepResult,
  startedAt: string,
  fallbackProvider: string,
  fallbackModel: string,
): void {
  try {
    recordInvocation(rec.db, {
      id: newId(),
      project_id: rec.projectId,
      provider: res.provider ?? fallbackProvider,
      surface: 'job',
      surface_ref_id: `${rec.jobId}:merge:${stepName}`,
      ticket_id: rec.ticketId ?? null,
      status: res.failed ? 'failed' : 'success',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      total_cost_usd: res.cost,
      total_cost_usd_estimated: res.estimated ?? false,
      tokens_in: res.tokensIn,
      tokens_out: res.tokensOut,
      tokens_cache_read: res.tokensCacheRead,
      tokens_cache_create: res.tokensCacheCreate,
      duration_ms: res.durationMs,
      model: res.model ?? fallbackModel,
    })
  } catch (err) {
    // Never let an accounting failure break the merge-back traversal.
    console.error('[rail-merge] failed to record merge-step invocation:', err)
    return
  }
  // Invalidate open spending dashboards (wrapped — a broadcast failure must not
  // break traversal; mirrors the loop / file-summary callsites).
  try {
    rec.broadcast?.({ type: 'spending.invalidated', projectId: rec.projectId })
  } catch { /* best-effort */ }
}

const VERIFICATION_PASS_RE = /VERIFICATION:\s*PASS/i

/** Run the merge-back for a settled isolated rail. Returns per-ticket outcomes. */
export async function runMergeBack(ctx: MergeBackContext): Promise<MergeOutcome[]> {
  const { git, executor, baseDir, provider, model, effort, constants, recording } = ctx
  const expand = (cmd: string): string =>
    resolveConstants(expandCommands(`{{cmd:${cmd}}}`, { provider }), constants)
  const step = async (cmd: string): Promise<AiStepResult> => {
    // Capture the real turn-start BEFORE the await — the row is bucketed/ordered
    // by started_at, so it must be the start, not the finish instant.
    const startedAt = new Date().toISOString()
    const res = await executor.runAiStep({ prompt: expand(cmd), provider, model, effort, cwd: baseDir, repoDir: baseDir })
    if (recording) recordMergeStep(recording, cmd, res, startedAt, provider, model)
    return res
  }

  const verifyIntegrated = async (): Promise<boolean> => {
    const res = await step('verify')
    return VERIFICATION_PASS_RE.test(res.text)
  }

  const resolveConflict = async (_b: BranchToMerge): Promise<boolean> => {
    await step('resolve-merge')
    // Resolved iff no unmerged paths remain. (merge-manager stages + commits.)
    const u = await git.run(['diff', '--name-only', '--diff-filter=U'], baseDir)
    return u.stdout.trim().length === 0
  }

  const rebaseAndFix = async (_b: BranchToMerge): Promise<boolean> => {
    await step('fix')
    await git.run(['add', '-A'], baseDir)
    // Commit the fix; harmless no-op (non-zero) when the fix changed nothing.
    await git.run(['commit', '-m', 'fix: integrate parallel rail branch'], baseDir)
    return verifyIntegrated()
  }

  // Serialise the WHOLE merge-back per base repo so two concurrent rails (e.g. two
  // single-ticket rails launched together) never merge/reset the same repo at once.
  return withRepoLock(baseDir, async () =>
    mergeBack(
      { git, baseDir, resolveConflict, verifyIntegrated, rebaseAndFix, onState: ctx.onState },
      await withMergePreview(git, baseDir, ctx.branches, ctx.previewMerge ?? previewPairMerge),
    )
  )
}

const SHA_RE = /^[0-9a-f]{40,64}$/i

/**
 * Attach merge-preview facts to every succeeded branch (conflicts against the
 * base as it stands now, and against each other) so clean candidates merge
 * first. Read-only; any Git failure leaves that branch without facts and the
 * previous order applies.
 */
export async function withMergePreview(
  git: GitRunner,
  baseDir: string,
  branches: BranchToMerge[],
  preview: (repoDir: string, baseSha: string, headSha: string) => Promise<PairMerge>,
): Promise<BranchToMerge[]> {
  const sha = async (ref: string): Promise<string | null> => {
    try {
      const r = await git.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], baseDir)
      const value = r.code === 0 ? r.stdout.trim() : ''
      return SHA_RE.test(value) ? value : null
    } catch { return null }
  }
  const eligible = branches.filter((b) => b.succeeded)
  if (eligible.length < 2) return branches
  const base = await sha('HEAD')
  if (!base) return branches
  const heads = new Map<BranchToMerge, string>()
  for (const b of eligible) {
    const head = await sha(`refs/heads/${b.branch}`)
    if (head) heads.set(b, head)
  }
  const safe = (p: Promise<PairMerge>): Promise<PairMerge | null> => p.catch(() => null)
  const baseConflicts = new Map<BranchToMerge, number | null>()
  await Promise.all([...heads].map(async ([b, head]) => {
    const r = await safe(preview(baseDir, base, head))
    baseConflicts.set(b, !r || r.status === 'unknown' ? null : r.status === 'conflicts' ? Math.max(1, r.fileCount) : 0)
  }))
  const siblings = new Map<BranchToMerge, number>()
  const entries = [...heads]
  await Promise.all(entries.flatMap(([a, ha], i) => entries.slice(i + 1).map(async ([b, hb]) => {
    const r = await safe(preview(baseDir, ha, hb))
    if (r?.status !== 'conflicts') return
    siblings.set(a, (siblings.get(a) ?? 0) + 1)
    siblings.set(b, (siblings.get(b) ?? 0) + 1)
  })))
  return branches.map((b) => heads.has(b)
    ? { ...b, preview: { baseConflicts: baseConflicts.get(b) ?? null, siblingConflicts: siblings.get(b) ?? 0 } }
    : b)
}
