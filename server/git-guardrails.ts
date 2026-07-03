/**
 * Git safety guardrails for the app-owned push/PR path (safe-pr-workflow).
 *
 * specrails must NEVER force-push and NEVER push directly to a project's
 * integration branch — work always lands on a ticket/batch branch and reaches the
 * integration branch only through a human-merged PR. This is a pure policy check
 * wired into the sanctioned git/PR path (`pr-publisher`) as defense-in-depth: even
 * a future bug that constructed a bad push is refused loudly.
 *
 * NOTE: this guards the APP's own git invocations. Blocking git issued by the AI
 * agent *inside* a loop turn (e.g. a rogue `git push --force`) requires a
 * per-worktree pre-push hook and is a documented follow-up.
 */
export class GitGuardrailError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitGuardrailError'
  }
}

const FORCE_FLAGS = new Set(['--force', '-f', '--force-with-lease'])

/** True when a `git push` arg list carries a force flag (incl. `--force-with-lease=…`). */
export function isForcePush(args: string[]): boolean {
  return args[0] === 'push' && args.some((a) => FORCE_FLAGS.has(a) || a.startsWith('--force-with-lease='))
}

/**
 * Does a `git push` arg list target the protected branch? Catches
 *   push <remote> <protected>        (implicit same-name)
 *   push <remote> HEAD:<protected>   (explicit dst refspec)
 *   push <remote> <src>:<protected>
 * We only ever push the ticket/batch branch, so any of these is a bug.
 */
export function pushesToBranch(args: string[], branch: string): boolean {
  if (args[0] !== 'push' || !branch) return false
  return args.slice(1).some((a) => {
    if (a.startsWith('-')) return false // a flag, not a refspec
    const dst = a.includes(':') ? a.slice(a.indexOf(':') + 1) : a
    return dst === branch || dst === `refs/heads/${branch}`
  })
}

/**
 * Throw if a git command violates the guardrails. Only `push` is policed today;
 * every other command is allowed through unchanged.
 */
export function assertGitAllowed(cmd: string, args: string[], opts: { protectedBranch?: string } = {}): void {
  if (cmd !== 'git' || args[0] !== 'push') return
  if (isForcePush(args)) {
    throw new GitGuardrailError('force-push is not allowed on the safe-PR path')
  }
  if (opts.protectedBranch && pushesToBranch(args, opts.protectedBranch)) {
    throw new GitGuardrailError(`direct push to the integration branch "${opts.protectedBranch}" is not allowed`)
  }
}
