import type { Exec, ExecResult } from './pr-publisher'

export type ObservedPrState = 'OPEN' | 'CLOSED' | 'MERGED'

export interface PrLifecycleObservation {
  ok: true
  state: ObservedPrState
  isDraft: boolean
  headRefName: string | null
  baseRefName: string | null
  headRefOid: string | null
  mergeCommitOid: string | null
  commitOids: string[]
  /** `null` means GitHub did not return enough commit evidence to decide. */
  includesExpectedSha: boolean | null
}

export interface PrLifecycleUnavailable {
  ok: false
  detail: string
}

export type PrLifecycleResult = PrLifecycleObservation | PrLifecycleUnavailable

const SHA_RE = /^[0-9a-f]{40,64}$/i
export const PR_LIFECYCLE_JSON_FIELDS = 'state,isDraft,headRefName,baseRefName,headRefOid,mergeCommit,commits'

function firstLine(result: ExecResult): string {
  return (result.stderr.trim() || result.stdout.trim()).split('\n')[0].trim().slice(0, 512)
}

function oid(value: unknown): string | null {
  return typeof value === 'string' && SHA_RE.test(value) ? value.toLowerCase() : null
}

/**
 * Observe one exact PR and, when requested, whether its immutable commit/merge
 * evidence contains a delivery SHA. The helper never guesses from a ledger row:
 * command failure, malformed JSON, and missing commit evidence remain explicit.
 */
export async function observePrLifecycle(
  exec: Exec,
  repoDir: string,
  prUrl: string,
  expectedSha?: string | null,
): Promise<PrLifecycleResult> {
  let result: ExecResult
  try {
    result = await exec.run(
      'gh',
      ['pr', 'view', prUrl, '--json', PR_LIFECYCLE_JSON_FIELDS],
      repoDir,
    )
  } catch (err) {
    return { ok: false, detail: (err instanceof Error ? err.message : String(err)).slice(0, 512) }
  }
  if (result.code !== 0) return { ok: false, detail: firstLine(result) || `exit ${result.code}` }

  try {
    const parsed = JSON.parse(result.stdout) as {
      state?: unknown
      isDraft?: unknown
      headRefName?: unknown
      baseRefName?: unknown
      headRefOid?: unknown
      mergeCommit?: { oid?: unknown } | null
      commits?: Array<{ oid?: unknown }>
    }
    const normalizedState = typeof parsed.state === 'string' ? parsed.state.toUpperCase() : ''
    if (normalizedState !== 'OPEN' && normalizedState !== 'CLOSED' && normalizedState !== 'MERGED') {
      return { ok: false, detail: `unrecognized PR state: ${normalizedState || 'missing'}` }
    }

    const headRefOid = oid(parsed.headRefOid)
    const mergeCommitOid = oid(parsed.mergeCommit?.oid)
    const commitsReturned = Array.isArray(parsed.commits)
    const commitOids = commitsReturned
      ? [...new Set(parsed.commits!.map((commit) => oid(commit?.oid)).filter((value): value is string => value !== null))]
      : []
    const expected = expectedSha && SHA_RE.test(expectedSha) ? expectedSha.toLowerCase() : null
    // A merged PR's live head branch can advance after the merge. Its current
    // headRefOid is therefore NOT proof that the merge included that object.
    // Only the PR's commit snapshot / merge commit are valid MERGED evidence.
    // While OPEN, delivery verification is intentionally stronger than mere
    // ancestry: the remote PR head itself must still be the frozen delivery
    // object. Otherwise a concurrent writer could advance/substitute the head
    // and a stale card would incorrectly report our exact push as verified.
    // CLOSED/MERGED no longer have a mutable review head, so their immutable PR
    // commit snapshot (or merge object) is the relevant inclusion evidence.
    const observedOids = new Set((normalizedState === 'OPEN'
      ? [headRefOid]
      : [mergeCommitOid, ...commitOids]
    ).filter((value): value is string => value !== null))
    const includesExpectedSha = expected === null
      ? null
      : observedOids.has(expected)
        ? true
        : commitsReturned
          ? false
          : null

    return {
      ok: true,
      state: normalizedState,
      isDraft: parsed.isDraft === true,
      headRefName: typeof parsed.headRefName === 'string' ? parsed.headRefName : null,
      baseRefName: typeof parsed.baseRefName === 'string' ? parsed.baseRefName : null,
      headRefOid,
      mergeCommitOid,
      commitOids,
      includesExpectedSha,
    }
  } catch {
    return { ok: false, detail: 'unparseable gh pr view output' }
  }
}

/** Head/base identity is required in every lifecycle state. A PR retargeted to
 * another base must never satisfy delivery merely because it still lists the
 * expected commit. */
export function matchesRecordedPrIdentity(
  observation: PrLifecycleResult,
  branch: string,
  baseBranch: string,
): boolean {
  return observation.ok && observation.headRefName === branch && observation.baseRefName === baseBranch
}

/** OPEN is continuation-safe only for the same recorded head/base identity. */
export function isExactOpenPr(
  observation: PrLifecycleResult,
  branch: string,
  baseBranch: string,
): boolean {
  return observation.ok && matchesRecordedPrIdentity(observation, branch, baseBranch) && observation.state === 'OPEN'
}
