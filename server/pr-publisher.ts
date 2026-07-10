/**
 * App-owned "deliver a mutating loop's result as a DRAFT PR" primitive.
 *
 * This is the single sanctioned path for a loop's work to leave the machine:
 * push the (already-committed) ticket/integration branch and open a **draft**
 * pull request against the designated integration branch. specrails never
 * merges and never opens a non-draft PR — the human owns the merge.
 *
 * Degradation ladder (a loop must NEVER fail because a PR could not be opened):
 *   pr-created  → branch pushed AND `gh pr create --draft` succeeded.
 *   pushed      → branch pushed but the PR could not be created (no `gh`, not
 *                 authenticated, insufficient remote perms). The user can open
 *                 the PR by hand from the pushed branch.
 *   local-only  → the branch could not be pushed (no remote / no network /
 *                 auth). The work is still safe as a local branch.
 *
 * Pure over an injectable `Exec` so it is unit-tested without git/gh or a network.
 */
import { execFile } from 'child_process'
import { assertGitAllowed } from './git-guardrails'
import { windowsSpawnEnv } from './util/win-spawn'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Injectable command executor (git / gh). Default shells out to the binary. */
export interface Exec {
  run(cmd: string, args: string[], cwd: string): Promise<ExecResult>
}

export const PR_COMMAND_TIMEOUT_MS = 120_000

export function createBoundedExec(timeoutMs = PR_COMMAND_TIMEOUT_MS): Exec {
  const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs))
  return {
    run(cmd, args, cwd) {
      return new Promise<ExecResult>((resolve) => {
      // `windowsSpawnEnv()` backfills SystemRoot / ComSpec / USERPROFILE, which a
      // GUI-launched / pkg-stripped Windows sidecar can lack — without them the
      // `git`/`gh` child (and the `sh -c` the `!gh …` credential helper runs) can
      // fail to start. NOT `GIT_EXEC_ENV`: that hardened env disables credentials
      // (GIT_ASKPASS=echo / GIT_TERMINAL_PROMPT=0), which the push must keep. No-op
      // on POSIX (returns process.env), so mac/Linux behaviour is byte-identical.
      const env = windowsSpawnEnv()
      // These commands can run while holding the per-repository mutation lock.
      // A wedged credential helper/network child must be reaped before the lock
      // can be released; otherwise every later launch/decision/checkout hangs
      // behind it forever. Two minutes is deliberately generous for push/gh.
      execFile(cmd, args, {
        cwd,
        env,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        timeout: boundedTimeoutMs,
        killSignal: 'SIGTERM',
      }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
        const errorText = err ? err.message : ''
        resolve({
          code,
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() || errorText,
        })
      })
      })
    },
  }
}

export const defaultExec: Exec = createBoundedExec()

export type PrPublishState = 'pr-created' | 'pushed' | 'local-only'

export interface PrPublishResult {
  state: PrPublishState
  branch: string
  /** Present only when state === 'pr-created'. */
  prUrl?: string
  /** Draft lifecycle reported by an adopted existing PR, when available. */
  isDraft?: boolean
  /** Human/machine-readable reason for a degraded (pushed / local-only) outcome. */
  reason?: string
}

export interface PublishDraftPrInput {
  /** A git dir that shares the repo's object-store (the worktree or the base repo). */
  repoDir: string
  /** The already-committed branch carrying the work. */
  branch: string
  /** The designated integration branch the draft PR targets. */
  baseBranch: string
  title: string
  body: string
  /** Remote to push to (default `origin`). */
  remote?: string
  /** Immutable settled object to publish under `branch`. When present, the
   * branch ref may move without changing what this delivery pushes. */
  sourceSha?: string
}

export interface PushBranchInput {
  /** A git dir that shares the repo's object-store (the worktree or the base repo). */
  repoDir: string
  /** The already-committed branch carrying the work. */
  branch: string
  /** Protected base branch: never push this branch as a delivery head. */
  baseBranch: string
  /** Remote to push to (default `origin`). */
  remote?: string
  /** Optional verified commit to publish. Existing-PR continuations pass the
   *  worktree HEAD here so a concurrent local ref move cannot make `pr_ready`
   *  describe a different commit than the one the run produced. */
  sourceSha?: string
}

export type PushBranchResult =
  | { state: 'pushed'; branch: string }
  | { state: 'local-only'; branch: string; reason: string }

/** Extract the first PR URL gh prints (e.g. https://github.com/o/r/pull/12). */
export function parsePrUrl(stdout: string): string | undefined {
  const m = stdout.match(/https?:\/\/\S+\/pull\/\d+/)
  return m ? m[0] : undefined
}

interface ExistingPrCandidate {
  url?: unknown
  isDraft?: unknown
  headRefName?: unknown
  baseRefName?: unknown
  state?: unknown
}

/**
 * Recover an ambiguously-created PR by its exact remote identity. GitHub does
 * not allow a second open PR for the same head in the common case, but we still
 * require exactly one OPEN head/base match before adopting it: a fuzzy title or
 * ticket match would attach the delivery to someone else's review.
 */
async function findExactOpenPr(
  exec: Exec,
  input: Pick<PublishDraftPrInput, 'repoDir' | 'branch' | 'baseBranch'>,
): Promise<{ prUrl: string; isDraft?: boolean } | null> {
  const lookup = await exec.run(
    'gh',
    [
      'pr', 'list', '--state', 'open', '--head', input.branch, '--base', input.baseBranch,
      '--json', 'url,isDraft,headRefName,baseRefName,state',
    ],
    input.repoDir,
  )
  if (lookup.code !== 0) return null
  try {
    const parsed = JSON.parse(lookup.stdout) as unknown
    if (!Array.isArray(parsed)) return null
    const exact = (parsed as ExistingPrCandidate[]).filter((candidate) =>
      candidate.state === 'OPEN' &&
      candidate.headRefName === input.branch &&
      candidate.baseRefName === input.baseBranch &&
      typeof candidate.url === 'string' &&
      parsePrUrl(candidate.url) === candidate.url,
    )
    if (exact.length !== 1) return null
    return {
      prUrl: exact[0].url as string,
      ...(typeof exact[0].isDraft === 'boolean' ? { isDraft: exact[0].isDraft } : {}),
    }
  } catch {
    return null
  }
}

/** Push a committed delivery branch, including the gh-credential retry used by
 *  draft PR creation. This is also used for follow-up commits on an existing PR:
 *  that path must update the same remote PR branch without trying to create a
 *  second PR. */
export async function pushBranch(exec: Exec, input: PushBranchInput): Promise<PushBranchResult> {
  const remote = input.remote ?? 'origin'
  const { repoDir, branch, baseBranch, sourceSha } = input

  if (sourceSha !== undefined && !/^[0-9a-f]{40,64}$/i.test(sourceSha)) {
    return { state: 'local-only', branch, reason: 'invalid verified source commit' }
  }
  // A raw commit refspec deliberately omits `-u`: git cannot configure branch
  // tracking from an object id, and an existing PR branch already has a remote.
  const pushArgs = sourceSha
    ? ['push', remote, `${sourceSha}:refs/heads/${branch}`]
    : ['push', '-u', remote, branch]
  assertGitAllowed('git', pushArgs, { protectedBranch: baseBranch })
  let push = await exec.run('git', pushArgs, repoDir)
  if (push.code !== 0 && isCredentialFailure(push)) {
    const retry = await exec.run(
      'git',
      ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...pushArgs],
      repoDir,
    )
    if (retry.code === 0) push = retry
  }
  if (push.code !== 0) return { state: 'local-only', branch, reason: reasonFrom(push) }
  return { state: 'pushed', branch }
}

export async function publishDraftPr(exec: Exec, input: PublishDraftPrInput): Promise<PrPublishResult> {
  const remote = input.remote ?? 'origin'
  const { repoDir, branch, baseBranch } = input

  // 1. Push the branch (set upstream). Failure → local-only, never throw.
  //    Guardrail: never force-push, never push the integration branch itself.
  const pushed = await pushBranch(exec, { repoDir, branch, baseBranch, remote, sourceSha: input.sourceSha })
  if (pushed.state === 'local-only') return pushed

  // 2. Open a DRAFT PR. Failure (no gh / not authed / perms) → pushed, never throw.
  const pr = await exec.run(
    'gh',
    ['pr', 'create', '--draft', '--base', baseBranch, '--head', branch, '--title', input.title, '--body', input.body],
    repoDir,
  )
  const prUrl = pr.code === 0 ? parsePrUrl(pr.stdout) : undefined
  if (!prUrl) {
    // `gh pr create` can report success without a parseable URL, return an
    // "already exists" error on a retry, or fail after GitHub accepted the
    // request. Resolve every ambiguous outcome by exact head/base identity.
    const existing = await findExactOpenPr(exec, { repoDir, branch, baseBranch })
    if (existing) return { state: 'pr-created', branch, ...existing }
    return {
      state: 'pushed',
      branch,
      reason: pr.code === 0 ? 'pr-created-no-url' : reasonFrom(pr),
    }
  }
  return { state: 'pr-created', branch, prUrl }
}

function reasonFrom(r: ExecResult): string {
  const msg = (r.stderr.trim() || r.stdout.trim()).split('\n')[0]
  return msg || `exit ${r.code}`
}

/**
 * True when a failed `git push` looks like an HTTPS credential/authentication
 * problem (as opposed to a rejected ref, missing remote, network, etc.) — the
 * only class worth retrying through gh's credential helper. Matches the
 * canonical git strings, including the "'credential-<helper>' is not a git
 * command" case that happens when the configured helper binary isn't on PATH.
 */
function isCredentialFailure(r: ExecResult): boolean {
  const s = `${r.stderr}\n${r.stdout}`.toLowerCase()
  return (
    s.includes('could not read username') ||
    s.includes('could not read password') ||
    s.includes('authentication failed') ||
    s.includes('credential-') ||
    s.includes('terminal prompts disabled')
  )
}
