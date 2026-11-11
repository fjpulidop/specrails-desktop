/**
 * Host-task handlers of the PR CI loop (pr-ci-loop, `factory:pr-ci`).
 *
 * Core runs the loop (rounds, budgets, stall detection, routing). These
 * handlers are the host adapters Core cannot own (`ownership.git: "host"`):
 *
 *   pr.update-base   fetch; integrate the PR's remote head and its base by MERGE
 *                    (never rebase); leave conflicts prepared, unconfirmed
 *   pr.sync          commit the verified candidate (closing a prepared merge)
 *                    and push it to the same PR branch (never forced)
 *   pr.checks        wait for the PR's checks on the exact pushed SHA
 *   pr.rerun-failed  re-run the failed GitHub Actions runs of that SHA once
 *
 * Every handler is idempotent (a restart may run it again) and fail-closed: an
 * unverifiable PR identity, a fork PR or a closed PR never receives a push.
 * CI logs are bounded and redacted; they are evidence for the fixer, never
 * instructions. Specrails never publishes the draft, merges or closes the PR.
 */
import type { HostTaskHandler, HostTaskInvocation, HostTaskResult } from '../../../agent-runtime/runtime/host-task-dispatcher'
import { hostTaskDelay } from '../../../agent-runtime/runtime/host-task-dispatcher'
import { isExactOpenPr, observePrLifecycle, verifyPushRemoteForPr } from '../pr-lifecycle'
import { pushBranch, type Exec, type ExecResult } from '../pr-publisher'
import { activeOpenSpecChangesAt, commitWorktreeAndVerify, type GitRunner } from '../../../../worktree-manager'

/** The PR a pr-ci run works on, resolved from Desktop's own delivery records (never from definition input). */
export interface PrCiTarget {
  deliveryId: string
  runId: string
  prUrl: string
  prNumber: number | null
  branch: string
  baseBranch: string
  /** The run's isolated worktree (checked out on `branch`). */
  worktreePath: string
  /** The base repository that owns the worktree and the `origin` remote. */
  repoDir: string
  /** Paths the overlay mounts and that must never be staged. */
  overlayExcludes: string[]
}

export interface PrCiTiming {
  /** Grace period for checks to appear after a push before `none` is concluded. */
  initialDelayMs: number
  pollMinMs: number
  pollMaxMs: number
  /** Total wait cap for one `pr.checks` before `timeout`. */
  timeoutMs: number
}
export const DEFAULT_PR_CI_TIMING: PrCiTiming = { initialDelayMs: 90_000, pollMinMs: 30_000, pollMaxMs: 120_000, timeoutMs: 60 * 60_000 }

export interface PrCiHandlerDeps {
  exec: Exec
  git: GitRunner
  resolveTarget(runId: string): PrCiTarget | null
  /** Serialize repository effects with launch/recovery (same lock as decisions). */
  withRepositoryLock<T>(repoDir: string, fn: () => Promise<T>): Promise<T>
  timing?: Partial<PrCiTiming>
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Bounds of the failure evidence handed to the fixer. */
export const PR_CI_MAX_FAILED_JOBS = 5
export const PR_CI_LOG_BYTES = 32 * 1024
const SHA_RE = /^[0-9a-f]{40,64}$/i

function firstLine(result: ExecResult): string {
  return (result.stderr.trim() || result.stdout.trim()).split('\n')[0].trim().slice(0, 512)
}

/** Redact the usual credential shapes from CI output before it is persisted or shown to an agent. */
export function redactCiText(text: string): string {
  return text
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]')
    .replace(/(authorization:\s*(?:bearer|basic|token)\s+)\S+/gi, '$1[REDACTED]')
    .replace(/(\bbearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Za-z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]')
}

/** Keep the end of a log (where failures are), at most `limit` bytes. */
export function boundLog(text: string, limit = PR_CI_LOG_BYTES): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= limit) return text
  return '[…truncated]\n' + buffer.subarray(buffer.byteLength - limit).toString('utf8').replace(/^�+/, '')
}

const failed = (detail: string): HostTaskResult => ({ outcome: 'failed', output: { detail: detail.slice(0, 2000) } })

export function createPrCiHandlers(deps: PrCiHandlerDeps): Record<string, HostTaskHandler> {
  const timing = { ...DEFAULT_PR_CI_TIMING, ...deps.timing }
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? hostTaskDelay
  const run = (args: string[], cwd: string) => deps.exec.run('git', args, cwd)
  const gh = (args: string[], cwd: string) => deps.exec.run('gh', args, cwd)

  const withTarget = (handler: (target: PrCiTarget, invocation: HostTaskInvocation) => Promise<HostTaskResult>): HostTaskHandler => async invocation => {
    const target = deps.resolveTarget(invocation.runId)
    if (!target) return failed('The pull request this run works on could not be resolved from its delivery')
    return handler(target, invocation)
  }

  /** Exact same-repository OPEN PR, or the terminal state that ends the loop. */
  const observe = async (target: PrCiTarget): Promise<{ kind: 'open' } | { kind: 'closed'; state: string } | { kind: 'refused'; detail: string }> => {
    const observed = await observePrLifecycle(deps.exec, target.repoDir, target.prUrl)
    if (!observed.ok) return { kind: 'refused', detail: `GitHub could not confirm the pull request: ${observed.detail}` }
    if (observed.isCrossRepository !== false) return { kind: 'refused', detail: 'The pull request comes from a fork; Specrails only works on same-repository pull requests' }
    if (observed.state !== 'OPEN') return { kind: 'closed', state: observed.state }
    if (!isExactOpenPr(observed, target.branch, target.baseBranch)) return { kind: 'refused', detail: `The pull request no longer targets ${target.baseBranch} from ${target.branch}` }
    return { kind: 'open' }
  }

  const head = async (cwd: string): Promise<string | null> => {
    const result = await run(['rev-parse', '--verify', 'HEAD'], cwd)
    const sha = result.stdout.trim().toLowerCase()
    return result.code === 0 && SHA_RE.test(sha) ? sha : null
  }
  const isAncestor = async (ancestor: string, cwd: string): Promise<boolean> =>
    (await run(['merge-base', '--is-ancestor', ancestor, 'HEAD'], cwd)).code === 0
  const mergeInProgress = async (cwd: string): Promise<boolean> =>
    (await run(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], cwd)).code === 0
  const conflictedPaths = async (cwd: string): Promise<string[]> => {
    const result = await run(['diff', '--name-only', '--diff-filter=U', '-z'], cwd)
    return result.code === 0 ? result.stdout.split('\0').filter(Boolean).slice(0, 200) : []
  }
  const trackedDirty = async (cwd: string): Promise<boolean> => {
    const result = await run(['status', '--porcelain', '--untracked-files=no'], cwd)
    return result.code !== 0 || result.stdout.trim().length > 0
  }

  /** Merge `ref` without committing. Returns conflicts or whether the tree changed. */
  const prepareMerge = async (ref: string, cwd: string): Promise<{ conflicts: string[] } | { merged: boolean } | { error: string }> => {
    const merge = await run(['merge', '--no-commit', '--no-ff', '--no-edit', ref], cwd)
    if (merge.code === 0) return { merged: await mergeInProgress(cwd) }
    const conflicts = await conflictedPaths(cwd)
    if (conflicts.length) return { conflicts }
    // A refused merge (untracked file in the way, …) leaves nothing prepared.
    if (await mergeInProgress(cwd)) await run(['merge', '--abort'], cwd)
    return { error: `git could not merge ${ref}: ${firstLine(merge) || `exit ${merge.code}`}` }
  }

  const updateBase = withTarget(async (target, { request, log }) => {
    const cwd = target.worktreePath
    return deps.withRepositoryLock(target.repoDir, async () => {
      const pr = await observe(target)
      if (pr.kind === 'closed') return { outcome: 'closed', output: { state: pr.state } }
      if (pr.kind === 'refused') return failed(pr.detail)
      // Replay after a restart: a merge this task already prepared is reported again, never redone.
      if (await mergeInProgress(cwd)) {
        const conflicts = await conflictedPaths(cwd)
        return conflicts.length ? { outcome: 'conflicts', output: { paths: conflicts, base: target.baseBranch } } : { outcome: 'merged', output: { base: target.baseBranch } }
      }
      if (await trackedDirty(cwd)) return failed('The PR worktree has uncommitted changes; refusing to merge over them')
      log(`Fetching ${target.baseBranch} and ${target.branch} from origin`)
      const fetch = await run(['fetch', '--no-tags', 'origin', `+refs/heads/${target.baseBranch}:refs/remotes/origin/${target.baseBranch}`, `+refs/heads/${target.branch}:refs/remotes/origin/${target.branch}`], cwd)
      if (fetch.code !== 0) return failed(`git fetch failed: ${firstLine(fetch) || `exit ${fetch.code}`}`)
      let changed = false
      // 1. Someone else pushed to the PR branch: integrate it first, by merge.
      const remoteHead = `refs/remotes/origin/${target.branch}`
      if (!(await isAncestor(remoteHead, cwd))) {
        log(`The PR branch moved on GitHub; merging origin/${target.branch}`)
        const merged = await prepareMerge(remoteHead, cwd)
        if ('error' in merged) return failed(merged.error)
        if ('conflicts' in merged) return { outcome: 'conflicts', output: { paths: merged.conflicts, base: target.branch } }
        if (merged.merged) {
          const commit = await commitWorktreeAndVerify(deps.git, cwd, `Merge origin/${target.branch} (run ${invocationRunMarker(target)})`, target.overlayExcludes)
          if (!commit.clean) return failed(`Could not record the merge of origin/${target.branch}: ${commit.error ?? 'worktree not clean'}`)
          changed = true
        }
      }
      // 2. The base: merge it only when the PR is behind AND the caller needs it
      // (GitHub reported a conflict). A PR that is merely behind stays untouched.
      const baseRef = `refs/remotes/origin/${target.baseBranch}`
      const reason = typeof request.input.reason === 'string' ? request.input.reason : 'start'
      if (!(await isAncestor(baseRef, cwd))) {
        const merged = await prepareMerge(baseRef, cwd)
        if ('error' in merged) return failed(merged.error)
        if ('conflicts' in merged) {
          log(`Conflicts with ${target.baseBranch} in ${merged.conflicts.length} file(s)`)
          return { outcome: 'conflicts', output: { paths: merged.conflicts, base: target.baseBranch } }
        }
        if (merged.merged && reason === 'conflict') {
          log(`Merged ${target.baseBranch} without conflicts`)
          return { outcome: 'merged', output: { base: target.baseBranch } }
        }
        if (merged.merged) await run(['merge', '--abort'], cwd)
      }
      return changed ? { outcome: 'merged', output: { base: target.branch } } : { outcome: 'clean', output: { base: target.baseBranch } }
    })
  })

  const sync = withTarget(async (target, { request, runId, log }) => {
    const cwd = target.worktreePath
    // Core attests verification (requiresVerified on the node); never push otherwise.
    if (!request.candidate.verified) return { outcome: 'rejected', output: { detail: 'The candidate is not verified; nothing was pushed' } }
    return deps.withRepositoryLock(target.repoDir, async () => {
      const pr = await observe(target)
      if (pr.kind === 'closed') return { outcome: 'closed', output: { state: pr.state } }
      if (pr.kind === 'refused') return { outcome: 'rejected', output: { detail: pr.detail } }
      const before = await head(cwd)
      if (!before) return failed('The PR worktree HEAD could not be verified')
      const allowed = [...new Set([...(await activeOpenSpecChangesAt(deps.git, cwd, 'HEAD')), ...(await activeOpenSpecChangesAt(deps.git, cwd, `refs/remotes/origin/${target.baseBranch}`))])]
      const summary = typeof request.input.summary === 'string' && request.input.summary.trim() ? request.input.summary.trim().split('\n')[0].slice(0, 72) : 'Fix CI'
      const commit = await commitWorktreeAndVerify(deps.git, cwd, `${summary} (run ${runId})`, target.overlayExcludes, before, allowed.length ? { allowedActiveChanges: allowed } : {})
      if (!commit.clean) return { outcome: 'rejected', output: { detail: `The verified change could not be committed safely: ${commit.error ?? commit.dirty.slice(0, 5).join(', ')}` } }
      const sha = await head(cwd)
      if (!sha) return failed('The committed HEAD could not be verified')
      const remote = await verifyPushRemoteForPr(deps.exec, target.repoDir, target.prUrl)
      if (!remote.ok) return { outcome: 'rejected', output: { detail: remote.detail } }
      log(`Pushing ${sha.slice(0, 12)} to ${target.branch}`)
      const pushed = await pushBranch(deps.exec, { repoDir: target.repoDir, branch: target.branch, baseBranch: target.baseBranch, remote: remote.pushTarget, sourceSha: sha })
      if (pushed.state === 'local-only') {
        // A non-fast-forward means the PR branch moved: merge it, never force.
        const fetch = await run(['fetch', '--no-tags', 'origin', `+refs/heads/${target.branch}:refs/remotes/origin/${target.branch}`], cwd)
        if (fetch.code === 0 && !(await isAncestor(`refs/remotes/origin/${target.branch}`, cwd))) return { outcome: 'diverged', output: { sha, detail: pushed.reason } }
        return { outcome: 'rejected', output: { sha, detail: pushed.reason ?? 'the push was refused' } }
      }
      return { outcome: 'pushed', output: { sha, previous: before, committed: commit.committed } }
    })
  })

  const checks = withTarget(async (target, { request, signal, log }) => {
    const started = now()
    const limit = Math.min(timing.timeoutMs, typeof request.timeoutMs === 'number' && request.timeoutMs > 0 ? request.timeoutMs : timing.timeoutMs)
    const expected = await head(target.worktreePath)
    if (!expected) return failed('The PR worktree HEAD could not be verified')
    let interval = timing.pollMinMs, headMismatches = 0
    log(`Waiting for the checks of ${expected.slice(0, 12)}`)
    for (;;) {
      const view = await gh(['pr', 'view', target.prUrl, '--json', 'state,mergeable,mergeStateStatus,headRefOid,isCrossRepository,statusCheckRollup'], target.repoDir)
      if (view.code !== 0) return failed(`gh pr view failed: ${firstLine(view) || `exit ${view.code}`}`)
      let parsed: PrCheckView
      try { parsed = JSON.parse(view.stdout) as PrCheckView } catch { return failed('gh pr view returned malformed JSON') }
      const state = String(parsed.state ?? '').toUpperCase()
      if (state === 'CLOSED' || state === 'MERGED') return { outcome: 'closed', output: { state } }
      if (parsed.isCrossRepository === true) return failed('The pull request comes from a fork')
      if (String(parsed.mergeable ?? '').toUpperCase() === 'CONFLICTING' || String(parsed.mergeStateStatus ?? '').toUpperCase() === 'DIRTY') {
        return { outcome: 'conflict', output: { mergeStateStatus: parsed.mergeStateStatus ?? null } }
      }
      const remoteHead = typeof parsed.headRefOid === 'string' ? parsed.headRefOid.toLowerCase() : ''
      if (remoteHead && remoteHead !== expected) {
        // GitHub may lag a push; a persistent difference means someone else pushed.
        if (++headMismatches >= 3) return { outcome: 'conflict', output: { detail: 'The PR head moved on GitHub', headRefOid: remoteHead } }
      } else {
        const summary = summarizeChecks(parsed.statusCheckRollup)
        const elapsed = now() - started
        if (summary.total === 0) {
          if (elapsed >= timing.initialDelayMs) return { outcome: 'none', output: { sha: expected } }
        } else if (summary.pending === 0) {
          if (!summary.failures.length) return { outcome: 'green', output: { sha: expected, checks: summary.total } }
          log(`${summary.failures.length} check(s) failed`)
          return { outcome: 'red', output: { sha: expected, checks: summary.total, failures: await failureEvidence(summary.failures, target.repoDir) } }
        }
      }
      if (now() - started >= limit) return { outcome: 'timeout', output: { sha: expected, waitedMs: now() - started } }
      await sleep(Math.min(interval, Math.max(1, limit - (now() - started))), signal)
      interval = Math.min(timing.pollMaxMs, Math.round(interval * 1.5))
    }
  })

  const failureEvidence = async (failures: CheckFailure[], cwd: string): Promise<Array<Record<string, unknown>>> => {
    const out: Array<Record<string, unknown>> = []
    for (const failure of failures.slice(0, PR_CI_MAX_FAILED_JOBS)) {
      const entry: Record<string, unknown> = { name: failure.name, conclusion: failure.conclusion, ...(failure.url ? { url: failure.url } : {}), ...(failure.summary ? { summary: redactCiText(failure.summary).slice(0, 2000) } : {}) }
      if (failure.runId) {
        const logs = await gh(['run', 'view', failure.runId, ...(failure.jobId ? ['--job', failure.jobId] : []), '--log-failed'], cwd)
        if (logs.code === 0 && logs.stdout.trim()) entry.log = boundLog(redactCiText(logs.stdout))
        else entry.logUnavailable = firstLine(logs) || 'no failed-step log'
      } else entry.external = true
      out.push(entry)
    }
    if (failures.length > PR_CI_MAX_FAILED_JOBS) out.push({ omitted: failures.length - PR_CI_MAX_FAILED_JOBS })
    return out
  }

  const rerunFailed = withTarget(async (target, { log }) => {
    const view = await gh(['pr', 'view', target.prUrl, '--json', 'statusCheckRollup'], target.repoDir)
    if (view.code !== 0) return failed(`gh pr view failed: ${firstLine(view) || `exit ${view.code}`}`)
    let parsed: PrCheckView
    try { parsed = JSON.parse(view.stdout) as PrCheckView } catch { return failed('gh pr view returned malformed JSON') }
    const runs = [...new Set(summarizeChecks(parsed.statusCheckRollup).failures.map(failure => failure.runId).filter((id): id is string => !!id))]
    if (!runs.length) return { outcome: 'ok', output: { rerun: [] } }
    const rerun: string[] = []
    for (const id of runs.slice(0, PR_CI_MAX_FAILED_JOBS)) {
      const result = await gh(['run', 'rerun', id, '--failed'], target.repoDir)
      if (result.code === 0) rerun.push(id)
      else log(`Could not re-run ${id}: ${firstLine(result)}`)
    }
    return rerun.length ? { outcome: 'ok', output: { rerun } } : failed('GitHub refused to re-run the failed checks')
  })

  return { 'pr.update-base': updateBase, 'pr.sync': sync, 'pr.checks': checks, 'pr.rerun-failed': rerunFailed }
}

function invocationRunMarker(target: PrCiTarget): string { return target.runId }

interface PrCheckView {
  state?: unknown
  mergeable?: unknown
  mergeStateStatus?: unknown
  headRefOid?: unknown
  isCrossRepository?: unknown
  statusCheckRollup?: unknown
}
export interface CheckFailure { name: string; conclusion: string; url?: string; summary?: string; runId?: string; jobId?: string }

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])
const PENDING_STATES = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED'])

/** Classify `statusCheckRollup` (CheckRun and StatusContext entries) without trusting its text. */
export function summarizeChecks(rollup: unknown): { total: number; pending: number; failures: CheckFailure[] } {
  const items = Array.isArray(rollup) ? rollup.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : []
  let pending = 0
  const failures: CheckFailure[] = []
  for (const item of items) {
    const context = item.__typename === 'StatusContext' || (item.state !== undefined && item.conclusion === undefined)
    const name = String(item.name ?? item.context ?? 'check').slice(0, 200)
    const url = typeof (item.detailsUrl ?? item.targetUrl) === 'string' ? String(item.detailsUrl ?? item.targetUrl).slice(0, 500) : undefined
    if (context) {
      const state = String(item.state ?? '').toUpperCase()
      if (PENDING_STATES.has(state) || !state) pending++
      else if (FAILED_CONCLUSIONS.has(state)) failures.push({ name, conclusion: state, ...(url ? { url } : {}), ...(typeof item.description === 'string' ? { summary: item.description } : {}) })
      continue
    }
    const status = String(item.status ?? '').toUpperCase()
    const conclusion = String(item.conclusion ?? '').toUpperCase()
    if (status !== 'COMPLETED' && (PENDING_STATES.has(status) || !conclusion)) { pending++; continue }
    if (FAILED_CONCLUSIONS.has(conclusion)) {
      const match = url ? /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(url) : null
      failures.push({ name, conclusion, ...(url ? { url } : {}), ...(match ? { runId: match[1], ...(match[2] ? { jobId: match[2] } : {}) } : {}) })
    }
  }
  return { total: items.length, pending, failures }
}
