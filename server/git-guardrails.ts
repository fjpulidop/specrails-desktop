/**
 * Git safety guardrails — the single rule set for git commands Specrails will
 * not let through, whoever issues them.
 *
 * specrails must NEVER force-push and NEVER push directly to a project's
 * integration branch — work always lands on a ticket/batch branch and reaches the
 * integration branch only through a human-merged PR. Two enforcement points
 * share these pure rules:
 *
 * - the APP's own git invocations: `assertGitAllowed` is wired into the
 *   sanctioned push/PR path (`pr-publisher`) as defense-in-depth, so even a
 *   future bug that constructed a bad push is refused loudly;
 * - git issued by a Claude agent INSIDE a turn: the agent policy hook
 *   (`server/modules/agent-policy`) bundles this file and applies the same
 *   rules, plus the run-scoped ones below (`isHardReset`, `branchDeleteTargets`,
 *   `pushDeletesRemoteBranch`), before the tool call runs.
 *
 * Keep this file dependency-free: it is bundled into the hook script.
 */
export class GitGuardrailError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitGuardrailError'
  }
}

const FORCE_FLAGS = new Set(['--force', '-f', '--force-with-lease', '--mirror'])

/** Refspec-like operands of a `git push` arg list (flags and their values excluded). */
function pushOperands(args: string[]): string[] {
  const out: string[] = []
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') { out.push(...args.slice(i + 1)); break }
    if (a.startsWith('-')) {
      // Options that take a separate value.
      if (['-o', '--push-option', '--repo', '--receive-pack', '--exec'].includes(a)) i++
      continue
    }
    out.push(a)
  }
  return out
}

/**
 * True when a `git push` arg list forces history: a force flag (incl.
 * `--force-with-lease=…`, `--mirror`, combined short flags such as `-uf`) or a
 * `+<src>:<dst>` refspec.
 */
export function isForcePush(args: string[]): boolean {
  if (args[0] !== 'push') return false
  for (const a of args.slice(1)) {
    if (a === '--') break
    if (FORCE_FLAGS.has(a) || a.startsWith('--force-with-lease=')) return true
    if (/^-[a-zA-Z]+$/.test(a) && a.slice(1).includes('f')) return true
  }
  return pushOperands(args).slice(1).some((spec) => spec.startsWith('+'))
}

/** The destination ref of a push refspec (`src:dst` → dst; `name` → name; `+x` → x). */
function refspecDestination(spec: string): string {
  const bare = spec.startsWith('+') ? spec.slice(1) : spec
  return bare.includes(':') ? bare.slice(bare.indexOf(':') + 1) : bare
}

function sameBranch(ref: string, branch: string): boolean {
  return ref === branch || ref === `refs/heads/${branch}`
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
    return sameBranch(refspecDestination(a), branch)
  })
}

/**
 * The branch names a `git push` would write when the refspec is implicit
 * (`git push`, `git push origin`, `git push origin HEAD`): the current branch.
 * Returns the explicit destinations otherwise.
 */
export function pushDestinations(args: string[], currentBranch: string | null): string[] {
  if (args[0] !== 'push') return []
  const operands = pushOperands(args)
  const refspecs = operands.slice(1)
  if (refspecs.length === 0) return currentBranch ? [currentBranch] : []
  return refspecs.map((spec) => {
    const dst = refspecDestination(spec)
    return dst === 'HEAD' || dst === '' ? currentBranch ?? dst : dst.replace(/^refs\/heads\//, '')
  }).filter(Boolean)
}

/** True when a `git push` deletes a remote branch (`--delete`, `-d`, `:<dst>`). */
export function pushDeletesRemoteBranch(args: string[]): boolean {
  if (args[0] !== 'push') return false
  if (args.slice(1).some((a) => a === '--delete' || a === '-d')) return true
  return pushOperands(args).slice(1).some((spec) => spec.startsWith(':') || spec.startsWith('+:'))
}

/** True for `git reset --hard …` (also `--merge`/`--keep` are not destructive enough to block). */
export function isHardReset(args: string[]): boolean {
  return args[0] === 'reset' && args.slice(1).includes('--hard')
}

/**
 * Branch names a `git branch` invocation deletes (`-d`, `-D`, `--delete`,
 * combined `-df`); empty when it deletes nothing.
 */
export function branchDeleteTargets(args: string[]): string[] {
  if (args[0] !== 'branch') return []
  const flags = args.slice(1).filter((a) => a.startsWith('-'))
  const deletes = flags.some((a) => a === '--delete' || (/^-[a-zA-Z]+$/.test(a) && /[dD]/.test(a.slice(1))))
  if (!deletes) return []
  // `-r` deletes remote-tracking refs: still a delete, names as given.
  return args.slice(1).filter((a) => !a.startsWith('-'))
}

/**
 * Throw if a git command violates the guardrails. Only `push` is policed on
 * the app path; every other command is allowed through unchanged.
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
