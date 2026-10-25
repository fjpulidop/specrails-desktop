/**
 * The write-capable conflict resolver for a conflicting "Integrate locally"
 * stash restore (proactive-local-integration). It is the same AI
 * merge-resolver the parallel-rail merge-back uses (`{{cmd:resolve-merge}}`
 * with the MERGE_SAFE contract, spawned through the loop executors' headless
 * rail-job path, i.e. with write permissions), confined to the restore
 * worktree: cwd and repoDir are that worktree, never the person's checkout.
 *
 * Mission agents are read-only and are never asked to do this.
 */
import { expandCommands } from '../../loops/runtime/loop-command-catalog'
import { BUILTIN_CONSTANTS, resolveConstants } from '../../loops/runtime/loop-constants'
import { createLoopExecutors } from '../../loops/runtime/loop-executors'
import { defaultMachineProvider } from '../../../provider-selection'
import { getProviderDefault } from '../../specs/runtime/spec-models'

export interface LocalRestoreResolverInput {
  worktreePath: string
  branch: string
  targetBranch: string
  conflictPaths: readonly string[]
  stashName: string
}

export type LocalRestoreResolver = (input: LocalRestoreResolverInput) => Promise<void>

/** The resolver prompt (agent-facing, English like every briefing). */
export function buildLocalRestoreResolverPrompt(input: LocalRestoreResolverInput, provider: string): string {
  const resolveMerge = resolveConstants(expandCommands('{{cmd:resolve-merge}}', { provider }), BUILTIN_CONSTANTS)
  return [
    resolveMerge,
    '',
    `Context: this worktree is on \`${input.branch}\`, cut from the integrated \`${input.targetBranch}\`. The person's uncommitted changes from before integrating ("${input.stashName}") were applied on top and conflicted.`,
    'Keep BOTH intents: the integrated code and the person\'s local edits. Conflicting files:',
    ...input.conflictPaths.map((p) => `- ${p}`),
    '',
    'Rules:',
    '- Work only inside this worktree and only on those files; do not switch branches, do not touch any other branch or worktree.',
    '- Run nothing destructive: no `git reset --hard`, `git checkout -- .`, `git clean`, `git stash drop/pop/clear`, `git push` or file deletions.',
    `- When every conflict marker is gone, stage the files and commit on \`${input.branch}\` (Specrails verifies and commits anything left).`,
  ].join('\n')
}

/** Default: the project's machine-primary provider and its default model. */
export const defaultLocalRestoreResolver: LocalRestoreResolver = async (input) => {
  const provider = defaultMachineProvider()
  const model = getProviderDefault(provider)
  await createLoopExecutors().runAiStep({
    prompt: buildLocalRestoreResolverPrompt(input, provider),
    provider,
    model,
    cwd: input.worktreePath,
    repoDir: input.worktreePath,
  })
}
