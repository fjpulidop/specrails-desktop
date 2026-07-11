import { createHash } from 'crypto'
import type { GitRunner } from './worktree-manager'

const COMMIT_SHA_RE = /^[0-9a-f]{40,64}$/i
const MAX_RECOVERY_COMMIT_CANDIDATES = 512

export type UnreachableRecoveryScan =
  | { ok: true; commits: string[] }
  | { ok: false; detail: string }

export type RunMarkedCommitDiscovery =
  | { kind: 'unique'; sha: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'scan_failed'; detail: string }

/**
 * Read the complete bounded unreachable-commit surface. Unknown output and an
 * excessive candidate universe fail closed: truncating either could turn an
 * ambiguous recovery into a false unique result.
 */
export async function scanUnreachableRecoveryCommits(
  git: GitRunner,
  repoDir: string,
): Promise<UnreachableRecoveryScan> {
  try {
    const result = await git.run(
      ['fsck', '--unreachable', '--no-reflogs', '--no-progress'],
      repoDir,
    )
    if (result.code !== 0) {
      return { ok: false, detail: 'Git could not enumerate unreachable recovery objects' }
    }

    const commits = new Set<string>()
    for (const rawLine of result.stdout.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      const commit = /^unreachable commit ([0-9a-f]{40,64})$/i.exec(line)
      if (commit) {
        commits.add(commit[1].toLowerCase())
        if (commits.size > MAX_RECOVERY_COMMIT_CANDIDATES) {
          return { ok: false, detail: 'Git exposed too many unreachable commits for safe recovery' }
        }
        continue
      }
      if (/^(?:unreachable|dangling) (?:blob|tree|tag) [0-9a-f]{40,64}$/i.test(line)) continue
      return { ok: false, detail: 'Git returned malformed unreachable-object evidence' }
    }
    return { ok: true, commits: [...commits] }
  } catch {
    return { ok: false, detail: 'Git could not enumerate unreachable recovery objects' }
  }
}

/**
 * Combine refs, reflogs and unreachable commits, then inspect every subject.
 * Any enumeration/inspection failure invalidates the entire uniqueness proof.
 */
export async function discoverRunMarkedCommit(
  git: GitRunner,
  repoDir: string,
  runId: string,
  suppliedScan?: UnreachableRecoveryScan,
): Promise<RunMarkedCommitDiscovery> {
  if (!runId || runId.length > 256 || /[\0\r\n]/.test(runId)) {
    return { kind: 'scan_failed', detail: 'The recorded run identifier is not safe to inspect' }
  }
  const unreachable = suppliedScan ?? await scanUnreachableRecoveryCommits(git, repoDir)
  if (!unreachable.ok) return { kind: 'scan_failed', detail: unreachable.detail }

  const candidates = new Set(unreachable.commits.map((sha) => sha.toLowerCase()))
  let refs
  try {
    refs = await git.run(
      ['log', '--all', '--reflog', '--fixed-strings', `--grep=(run ${runId})`, '--format=%H'],
      repoDir,
    )
  } catch {
    return { kind: 'scan_failed', detail: 'Git could not enumerate recovery refs and reflogs' }
  }
  if (refs.code !== 0) {
    return { kind: 'scan_failed', detail: 'Git could not enumerate recovery refs and reflogs' }
  }
  for (const rawLine of refs.stdout.split(/\r?\n/)) {
    const sha = rawLine.trim()
    if (!sha) continue
    if (!COMMIT_SHA_RE.test(sha)) {
      return { kind: 'scan_failed', detail: 'Git returned malformed recovery commit evidence' }
    }
    candidates.add(sha.toLowerCase())
    if (candidates.size > MAX_RECOVERY_COMMIT_CANDIDATES) {
      return { kind: 'scan_failed', detail: 'Git exposed too many commits for safe recovery' }
    }
  }

  const marker = `(run ${runId})`
  const marked: string[] = []
  for (const sha of candidates) {
    let subject
    try {
      subject = await git.run(['show', '-s', '--format=%s', sha], repoDir)
    } catch {
      return { kind: 'scan_failed', detail: 'Git could not inspect every recovery commit subject' }
    }
    if (subject.code !== 0) {
      return { kind: 'scan_failed', detail: 'Git could not inspect every recovery commit subject' }
    }
    if (subject.stdout.trim().includes(marker)) marked.push(sha)
  }
  if (marked.length === 0) return { kind: 'none' }
  if (marked.length > 1) return { kind: 'ambiguous', count: marked.length }
  return { kind: 'unique', sha: marked[0] }
}

export async function commitCarriesRunMarker(
  git: GitRunner,
  repoDir: string,
  sha: string,
  runId: string,
): Promise<boolean> {
  if (!COMMIT_SHA_RE.test(sha)) return false
  try {
    const result = await git.run(['show', '-s', '--format=%s', sha], repoDir)
    return result.code === 0 && result.stdout.trim().includes(`(run ${runId})`)
  } catch {
    return false
  }
}

export function recoveryRefForDelivery(deliveryId: string): string {
  const digest = createHash('sha256').update(deliveryId).digest('hex')
  return `refs/specrails/recovery/${digest}`
}

export type RecoveryCommitProtection =
  | { kind: 'present'; ref: string; sha: string }
  | { kind: 'absent'; ref: string }
  | { kind: 'unreadable'; ref: string }

export type RecoveryCommitProtectionScan =
  | { ok: true; protections: Map<string, string> }
  | { ok: false; detail: string }

export async function listRecoveryCommitProtections(
  git: GitRunner,
  repoDir: string,
): Promise<RecoveryCommitProtectionScan> {
  try {
    const result = await git.run(
      ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/specrails/recovery/'],
      repoDir,
    )
    if (result.code !== 0) {
      return { ok: false, detail: 'Git could not enumerate delivery recovery refs' }
    }
    const protections = new Map<string, string>()
    for (const rawLine of result.stdout.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      const match = /^(refs\/specrails\/recovery\/[0-9a-f]{64})\t([0-9a-f]{40,64})$/i.exec(line)
      if (!match || protections.has(match[1])) {
        return { ok: false, detail: 'Git returned malformed delivery recovery refs' }
      }
      protections.set(match[1], match[2].toLowerCase())
      if (protections.size > MAX_RECOVERY_COMMIT_CANDIDATES) {
        return { ok: false, detail: 'Git exposed too many delivery recovery refs for safe cleanup' }
      }
    }
    return { ok: true, protections }
  } catch {
    return { ok: false, detail: 'Git could not enumerate delivery recovery refs' }
  }
}

export async function inspectRecoveryCommitProtection(
  git: GitRunner,
  repoDir: string,
  deliveryId: string,
): Promise<RecoveryCommitProtection> {
  const ref = recoveryRefForDelivery(deliveryId)
  try {
    const exists = await git.run(['show-ref', '--verify', '--quiet', ref], repoDir)
    if (exists.code === 1) return { kind: 'absent', ref }
    if (exists.code !== 0) return { kind: 'unreadable', ref }
    const result = await git.run(['rev-parse', '--verify', ref], repoDir)
    if (result.code !== 0) return { kind: 'unreadable', ref }
    const sha = result.stdout.trim().toLowerCase()
    return COMMIT_SHA_RE.test(sha)
      ? { kind: 'present', ref, sha }
      : { kind: 'unreadable', ref }
  } catch {
    return { kind: 'unreadable', ref }
  }
}

/** Pin a proven orphan without moving any user-visible branch or checkout. */
export async function protectRecoveryCommit(
  git: GitRunner,
  repoDir: string,
  deliveryId: string,
  sha: string,
): Promise<{ ok: true; ref: string } | { ok: false; detail: string }> {
  if (!COMMIT_SHA_RE.test(sha)) return { ok: false, detail: 'The recovery commit SHA is invalid' }
  const ref = recoveryRefForDelivery(deliveryId)
  const zero = '0'.repeat(sha.length)
  try {
    const created = await git.run(['update-ref', ref, sha, zero], repoDir)
    if (created.code !== 0) {
      const existing = await git.run(['rev-parse', '--verify', ref], repoDir)
      if (existing.code !== 0 || existing.stdout.trim().toLowerCase() !== sha.toLowerCase()) {
        return { ok: false, detail: 'A different commit already owns this delivery recovery ref' }
      }
    }
    const verified = await git.run(['rev-parse', '--verify', ref], repoDir)
    if (verified.code !== 0 || verified.stdout.trim().toLowerCase() !== sha.toLowerCase()) {
      return { ok: false, detail: 'Git could not verify the delivery recovery ref' }
    }
    return { ok: true, ref }
  } catch {
    return { ok: false, detail: 'Git could not protect the recovered commit from cleanup' }
  }
}

/** Move an already-owned protection ref to a newly committed descendant using
 * an exact compare-and-set. The old orphan remains pinned unless the caller
 * proves it still owns the ref at the instant of the update. */
export async function advanceRecoveryCommitProtection(
  git: GitRunner,
  repoDir: string,
  deliveryId: string,
  previousSha: string,
  nextSha: string,
): Promise<{ ok: true; ref: string } | { ok: false; detail: string }> {
  if (!COMMIT_SHA_RE.test(previousSha) || !COMMIT_SHA_RE.test(nextSha)) {
    return { ok: false, detail: 'The recovery commit SHA is invalid' }
  }
  if (previousSha.toLowerCase() === nextSha.toLowerCase()) {
    return protectRecoveryCommit(git, repoDir, deliveryId, nextSha)
  }
  const ref = recoveryRefForDelivery(deliveryId)
  try {
    const moved = await git.run(['update-ref', ref, nextSha, previousSha], repoDir)
    if (moved.code !== 0) {
      return { ok: false, detail: 'The delivery recovery ref changed before the new commit could be protected' }
    }
    const verified = await git.run(['rev-parse', '--verify', ref], repoDir)
    if (verified.code !== 0 || verified.stdout.trim().toLowerCase() !== nextSha.toLowerCase()) {
      return { ok: false, detail: 'Git could not verify the advanced delivery recovery ref' }
    }
    return { ok: true, ref }
  } catch {
    return { ok: false, detail: 'Git could not advance the delivery recovery ref safely' }
  }
}

/** Delete only the exact protected object; a substituted ref is preserved. */
export async function releaseRecoveryCommit(
  git: GitRunner,
  repoDir: string,
  deliveryId: string,
  expectedSha?: string | null,
): Promise<boolean> {
  // A missing/invalid expected object is not authority to delete a durable
  // protection ref. Callers may be settling legacy rows that never created
  // one, while a concurrently repaired row could already own this delivery's
  // ref. Preserve unknown state rather than deleting by name alone.
  if (!expectedSha || !COMMIT_SHA_RE.test(expectedSha)) return false
  const ref = recoveryRefForDelivery(deliveryId)
  try {
    const removed = await git.run(['update-ref', '-d', ref, expectedSha], repoDir)
    if (removed.code === 0) return true
    const existing = await git.run(['rev-parse', '--verify', ref], repoDir)
    return existing.code !== 0
  } catch {
    return false
  }
}
