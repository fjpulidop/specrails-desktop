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

export const defaultExec: Exec = {
  run(cmd, args, cwd) {
    return new Promise<ExecResult>((resolve) => {
      // `windowsSpawnEnv()` backfills SystemRoot / ComSpec / USERPROFILE, which a
      // GUI-launched / pkg-stripped Windows sidecar can lack — without them the
      // `git`/`gh` child (and the `sh -c` the `!gh …` credential helper runs) can
      // fail to start. NOT `GIT_EXEC_ENV`: that hardened env disables credentials
      // (GIT_ASKPASS=echo / GIT_TERMINAL_PROMPT=0), which the push must keep. No-op
      // on POSIX (returns process.env), so mac/Linux behaviour is byte-identical.
      const env = windowsSpawnEnv()
      execFile(cmd, args, { cwd, env, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
        resolve({ code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' })
      })
    })
  },
}

export type PrPublishState = 'pr-created' | 'pushed' | 'local-only'

export interface PrPublishResult {
  state: PrPublishState
  branch: string
  /** Present only when state === 'pr-created'. */
  prUrl?: string
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
}

/** Extract the first PR URL gh prints (e.g. https://github.com/o/r/pull/12). */
export function parsePrUrl(stdout: string): string | undefined {
  const m = stdout.match(/https?:\/\/\S+\/pull\/\d+/)
  return m ? m[0] : undefined
}

export async function publishDraftPr(exec: Exec, input: PublishDraftPrInput): Promise<PrPublishResult> {
  const remote = input.remote ?? 'origin'
  const { repoDir, branch, baseBranch } = input

  // 1. Push the branch (set upstream). Failure → local-only, never throw.
  //    Guardrail: never force-push, never push the integration branch itself.
  const pushArgs = ['push', '-u', remote, branch]
  assertGitAllowed('git', pushArgs, { protectedBranch: baseBranch })
  let push = await exec.run('git', pushArgs, repoDir)
  if (push.code !== 0 && isCredentialFailure(push)) {
    // The push failed authenticating over HTTPS — typically the machine's
    // configured credential helper (e.g. git-credential-osxkeychain) is not on
    // the app's PATH (GUI-launch PATH divergence: the sidecar inherits launchd's
    // PATH, not the user's login shell). Retry borrowing gh's credentials — the
    // SAME auth we use for `gh pr create` below, so if the PR can be created the
    // push can succeed — instead of depending on a machine credential helper.
    // `-c credential.helper=` first RESETS the (broken) inherited helper list,
    // then adds gh's. Harmless for SSH remotes (git ignores credential.helper).
    // The semantic push (refspec/remote) is unchanged, so the guardrail asserted
    // above still holds; no-op when gh is absent (retry fails the same way).
    const retry = await exec.run(
      'git',
      ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...pushArgs],
      repoDir,
    )
    if (retry.code === 0) push = retry
  }
  if (push.code !== 0) {
    return { state: 'local-only', branch, reason: reasonFrom(push) }
  }

  // 2. Open a DRAFT PR. Failure (no gh / not authed / perms) → pushed, never throw.
  const pr = await exec.run(
    'gh',
    ['pr', 'create', '--draft', '--base', baseBranch, '--head', branch, '--title', input.title, '--body', input.body],
    repoDir,
  )
  if (pr.code !== 0) {
    return { state: 'pushed', branch, reason: reasonFrom(pr) }
  }

  const prUrl = parsePrUrl(pr.stdout)
  if (!prUrl) {
    // gh exited 0 but we couldn't find a URL — treat as pushed (the PR likely
    // exists) rather than claiming a URL we don't have.
    return { state: 'pushed', branch, reason: 'pr-created-no-url' }
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
