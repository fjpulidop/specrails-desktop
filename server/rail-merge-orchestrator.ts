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
import { expandCommands } from './loop-command-catalog'
import { resolveConstants } from './loop-constants'
import { mergeBack, type BranchToMerge, type MergeOutcome, type MergeState } from './merge-manager'
import type { GitRunner } from './worktree-manager'
import type { AiStepResult, LoopExecutors } from './loop-run-manager'
import type { ReasoningEffort } from './providers/types'

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
}

const VERIFICATION_PASS_RE = /VERIFICATION:\s*PASS/i

/** Run the merge-back for a settled isolated rail. Returns per-ticket outcomes. */
export async function runMergeBack(ctx: MergeBackContext): Promise<MergeOutcome[]> {
  const { git, executor, baseDir, provider, model, effort, constants } = ctx
  const expand = (cmd: string): string =>
    resolveConstants(expandCommands(`{{cmd:${cmd}}}`, { provider }), constants)
  const step = (cmd: string) =>
    executor.runAiStep({ prompt: expand(cmd), provider, model, effort, cwd: baseDir, repoDir: baseDir })

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

  return mergeBack(
    { git, baseDir, resolveConflict, verifyIntegrated, rebaseAndFix, onState: ctx.onState },
    ctx.branches
  )
}
