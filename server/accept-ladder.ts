/**
 * Accept-ladder pre-resolution (nontech-review-experience Wave 2).
 *
 * The packet offers one verb, "Accept". What that verb PHYSICALLY does depends
 * on the repo: with a remote and an authenticated GitHub CLI it produces a PR
 * (reviewable, reversible); without one it merges straight into the user's own
 * checkout (irreversible). Today both buttons render side by side and the state
 * is only learned after an attempt — so this module pre-resolves it, using the
 * probes the app already ships, before the user is asked anything.
 *
 * Fail-CLOSED on capability: an unprovable remote/auth resolves to
 * `merge-local`, which the packet always confirm-gates. The dangerous mistake
 * would be the reverse — silently claiming a PR path that then degrades to
 * "pushed / local-only" and leaves the user staring at git vocabulary.
 */
import { defaultExec, type Exec } from './pr-publisher'

export type AcceptTarget = 'create-pr' | 'merge-local'

export interface AcceptCapability {
  target: AcceptTarget
  /** A push destination exists (`git remote` listed at least one). */
  hasRemote: boolean
  /** `gh auth token` exited 0 — the offline auth check the prereq panel uses. */
  ghAuthenticated: boolean
  /** True when Accept writes directly into the user's working checkout. */
  irreversible: boolean
  /** Machine reason for the resolution; the client localizes it. */
  reasonCode: 'pr-capable' | 'no-remote' | 'gh-unauthenticated' | 'probe-failed'
}

export interface AcceptCapabilityIO {
  exec?: Exec
  /** Repo dir the probes run in. */
  repoDir: string
}

/**
 * Both probes are read-only and offline. `gh auth token` is preferred over
 * `gh auth status` because it is the same offline exit-code check
 * setup-prerequisites already uses for the "Not signed in" badge.
 */
export async function resolveAcceptCapability(io: AcceptCapabilityIO): Promise<AcceptCapability> {
  const exec = io.exec ?? defaultExec

  let hasRemote = false
  let probeFailed = false
  try {
    const remotes = await exec.run('git', ['remote'], io.repoDir)
    hasRemote = remotes.code === 0 && remotes.stdout.trim().length > 0
  } catch {
    probeFailed = true
  }

  let ghAuthenticated = false
  if (hasRemote) {
    try {
      const auth = await exec.run('gh', ['auth', 'token'], io.repoDir)
      ghAuthenticated = auth.code === 0
    } catch {
      probeFailed = true
    }
  }

  const target: AcceptTarget = hasRemote && ghAuthenticated ? 'create-pr' : 'merge-local'
  const reasonCode: AcceptCapability['reasonCode'] = target === 'create-pr'
    ? 'pr-capable'
    : probeFailed
      ? 'probe-failed'
      : !hasRemote
        ? 'no-remote'
        : 'gh-unauthenticated'

  return {
    target,
    hasRemote,
    ghAuthenticated,
    irreversible: target === 'merge-local',
    reasonCode,
  }
}
