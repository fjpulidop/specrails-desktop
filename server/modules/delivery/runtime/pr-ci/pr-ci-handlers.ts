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
import { formatConventionalSubject } from '../pr-naming'
import type { HostTaskHandler, HostTaskInvocation, HostTaskResult } from '../../../agent-runtime/runtime/host-task-dispatcher'
import { hostTaskDelay } from '../../../agent-runtime/runtime/host-task-dispatcher'
import { isExactOpenPr, observePrLifecycle, verifyPushRemoteForPr } from '../pr-lifecycle'
import { pushBranch, type Exec, type ExecResult } from '../pr-publisher'
import { activeOpenSpecChangesAt, commitWorktreeAndVerify, type GitRunner } from '../../../../worktree-manager'

/** The PR a pr-ci run works on, resolved from Desktop's own delivery records (never from definition input). */
export interface PrCiTarget {
  deliveryId: string
  runId: string
  /** Shown to the fixer and in multi-repository results. */
  repositoryName: string
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
  /** Every PR of the run: one for a single repository, one per repository with a PR otherwise. */
  resolveTargets(runId: string): PrCiTarget[]
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

  /** A multi-repository run works on one PR per repository; every handler acts on all of them. */
  const withTargets = (handler: (targets: PrCiTarget[], invocation: HostTaskInvocation) => Promise<HostTaskResult>): HostTaskHandler => async invocation => {
    const targets = deps.resolveTargets(invocation.runId)
    if (!targets.length) return failed('The pull request this run works on could not be resolved from its delivery')
    return handler(targets, invocation)
  }
  const multi = (targets: PrCiTarget[]) => targets.length > 1
  const label = (targets: PrCiTarget[], target: PrCiTarget, text: string) => multi(targets) ? `${target.repositoryName}: ${text}` : text
  const tagged = (targets: PrCiTarget[], target: PrCiTarget) => multi(targets) ? { repository: target.repositoryName, prNumber: target.prNumber } : {}

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

  type BaseOne = { outcome: 'clean' | 'merged' | 'closed' | 'failed' | 'conflicts'; paths?: string[]; base: string; state?: string; detail?: string }
  const updateBaseOne = (target: PrCiTarget, reason: string, runId: string, log: (line: string) => void): Promise<BaseOne> => deps.withRepositoryLock(target.repoDir, async () => {
    const cwd = target.worktreePath
    const pr = await observe(target)
    if (pr.kind === 'closed') return { outcome: 'closed', state: pr.state, base: target.baseBranch }
    if (pr.kind === 'refused') return { outcome: 'failed', detail: pr.detail, base: target.baseBranch }
    // Replay after a restart: a merge this task already prepared is reported again, never redone.
    if (await mergeInProgress(cwd)) {
      const conflicts = await conflictedPaths(cwd)
      return conflicts.length ? { outcome: 'conflicts', paths: conflicts, base: target.baseBranch } : { outcome: 'merged', base: target.baseBranch }
    }
    if (await trackedDirty(cwd)) return { outcome: 'failed', detail: 'The PR worktree has uncommitted changes; refusing to merge over them', base: target.baseBranch }
    log(`Fetching ${target.baseBranch} and ${target.branch} from origin`)
    const fetch = await run(['fetch', '--no-tags', 'origin', `+refs/heads/${target.baseBranch}:refs/remotes/origin/${target.baseBranch}`, `+refs/heads/${target.branch}:refs/remotes/origin/${target.branch}`], cwd)
    if (fetch.code !== 0) return { outcome: 'failed', detail: `git fetch failed: ${firstLine(fetch) || `exit ${fetch.code}`}`, base: target.baseBranch }
    let changed = false
    // 1. Someone else pushed to the PR branch: integrate it first, by merge.
    const remoteHead = `refs/remotes/origin/${target.branch}`
    if (!(await isAncestor(remoteHead, cwd))) {
      log(`The PR branch moved on GitHub; merging origin/${target.branch}`)
      const merged = await prepareMerge(remoteHead, cwd)
      if ('error' in merged) return { outcome: 'failed', detail: merged.error, base: target.branch }
      if ('conflicts' in merged) return { outcome: 'conflicts', paths: merged.conflicts, base: target.branch }
      if (merged.merged) {
        const subject = formatConventionalSubject({ type: 'chore', change: `merge origin/${target.branch}`, ref: '' })
        const commit = await commitWorktreeAndVerify(deps.git, cwd, `${subject}\n\nRun: ${runId.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')}`, target.overlayExcludes)
        if (!commit.clean) return { outcome: 'failed', detail: `Could not record the merge of origin/${target.branch}: ${commit.error ?? 'worktree not clean'}`, base: target.branch }
        changed = true
      }
    }
    // 2. The base: merge it only when the PR is behind AND the caller needs it:
    // GitHub reported a conflict, or checks are red (the base may already carry
    // their fix). A PR that is merely behind with passing checks stays untouched.
    const baseRef = `refs/remotes/origin/${target.baseBranch}`
    if (!(await isAncestor(baseRef, cwd))) {
      const merged = await prepareMerge(baseRef, cwd)
      if ('error' in merged) return { outcome: 'failed', detail: merged.error, base: target.baseBranch }
      if ('conflicts' in merged) {
        log(`Conflicts with ${target.baseBranch} in ${merged.conflicts.length} file(s)`)
        return { outcome: 'conflicts', paths: merged.conflicts, base: target.baseBranch }
      }
      if (merged.merged && (reason === 'conflict' || reason === 'red')) {
        log(`Merged ${target.baseBranch} without conflicts`)
        return { outcome: 'merged', base: target.baseBranch }
      }
      if (merged.merged) await run(['merge', '--abort'], cwd)
    }
    return changed ? { outcome: 'merged', base: target.branch } : { outcome: 'clean', base: target.baseBranch }
  })

  const updateBase = withTargets(async (targets, { request, runId, log }) => {
    const reason = typeof request.input.reason === 'string' ? request.input.reason : 'start'
    const results: Array<{ target: PrCiTarget; result: BaseOne }> = []
    for (const target of targets) {
      const result = await updateBaseOne(target, reason, runId, line => log(label(targets, target, line)))
      if (result.outcome === 'failed') return failed(label(targets, target, result.detail ?? 'The base branch could not be synced'))
      if (result.outcome === 'closed') return { outcome: 'closed', output: { state: result.state, ...tagged(targets, target) } }
      results.push({ target, result })
    }
    const conflicts = results.filter(entry => entry.result.outcome === 'conflicts')
    if (conflicts.length) {
      return { outcome: 'conflicts', output: multi(targets)
        ? { repositories: conflicts.map(({ target, result }) => ({ repository: target.repositoryName, worktree: target.worktreePath, base: result.base, paths: result.paths ?? [] })) }
        : { paths: conflicts[0].result.paths ?? [], base: conflicts[0].result.base } }
    }
    const merged = results.filter(entry => entry.result.outcome === 'merged')
    if (merged.length) return { outcome: 'merged', output: multi(targets) ? { repositories: merged.map(({ target, result }) => ({ repository: target.repositoryName, base: result.base })) } : { base: merged[0].result.base } }
    return { outcome: 'clean', output: multi(targets) ? { repositories: results.map(({ target }) => target.repositoryName) } : { base: results[0].result.base } }
  })

  const sync = withTargets(async (targets, { request, runId, log }) => {
    // Core attests verification (requiresVerified on the node); never push otherwise.
    if (!request.candidate.verified) return { outcome: 'rejected', output: { detail: 'The candidate is not verified; nothing was pushed' } }
    // Every PR must still be open before ANY of them receives a push.
    for (const target of targets) {
      const pr = await observe(target)
      if (pr.kind === 'closed') return { outcome: 'closed', output: { state: pr.state, ...tagged(targets, target) } }
      if (pr.kind === 'refused') return { outcome: 'rejected', output: { detail: label(targets, target, pr.detail) } }
    }
    const summary = typeof request.input.summary === 'string' && request.input.summary.trim() ? request.input.summary.trim().replace(/^(feat|fix|chore|docs)!?:\s*/i, '') : 'Fix CI'
    const pushes: Array<Record<string, unknown>> = []
    for (const target of targets) {
      const outcome = await deps.withRepositoryLock(target.repoDir, async (): Promise<HostTaskResult | Record<string, unknown>> => {
        const cwd = target.worktreePath
        const before = await head(cwd)
        if (!before) return failed(label(targets, target, 'The PR worktree HEAD could not be verified'))
        const allowed = [...new Set([...(await activeOpenSpecChangesAt(deps.git, cwd, 'HEAD')), ...(await activeOpenSpecChangesAt(deps.git, cwd, `refs/remotes/origin/${target.baseBranch}`))])]
        const subject = formatConventionalSubject({ type: await mergeInProgress(cwd) ? 'chore' : 'fix', change: summary, ref: '' })
        const commit = await commitWorktreeAndVerify(deps.git, cwd, `${subject}\n\nRun: ${runId.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')}`, target.overlayExcludes, before, allowed.length ? { allowedActiveChanges: allowed } : {})
        if (!commit.clean) return { outcome: 'rejected', output: { detail: label(targets, target, `The verified change could not be committed safely: ${commit.error ?? commit.dirty.slice(0, 5).join(', ')}`) } }
        const sha = await head(cwd)
        if (!sha) return failed(label(targets, target, 'The committed HEAD could not be verified'))
        const remote = await verifyPushRemoteForPr(deps.exec, target.repoDir, target.prUrl)
        if (!remote.ok) return { outcome: 'rejected', output: { detail: label(targets, target, remote.detail) } }
        log(label(targets, target, `Pushing ${sha.slice(0, 12)} to ${target.branch}`))
        const pushed = await pushBranch(deps.exec, { repoDir: target.repoDir, branch: target.branch, baseBranch: target.baseBranch, remote: remote.pushTarget, sourceSha: sha })
        if (pushed.state === 'local-only') {
          // A non-fast-forward means the PR branch moved: merge it, never force.
          const fetch = await run(['fetch', '--no-tags', 'origin', `+refs/heads/${target.branch}:refs/remotes/origin/${target.branch}`], cwd)
          if (fetch.code === 0 && !(await isAncestor(`refs/remotes/origin/${target.branch}`, cwd))) return { outcome: 'diverged', output: { sha, detail: label(targets, target, pushed.reason ?? 'the PR branch moved'), ...tagged(targets, target) } }
          return { outcome: 'rejected', output: { sha, detail: label(targets, target, pushed.reason ?? 'the push was refused') } }
        }
        return { sha, previous: before, committed: commit.committed, ...tagged(targets, target) }
      })
      if (typeof outcome.outcome === 'string') return outcome as HostTaskResult
      pushes.push(outcome as Record<string, unknown>)
    }
    return { outcome: 'pushed', output: multi(targets) ? { pushes } : pushes[0] }
  })

  type CheckState = { kind: 'closed'; state: string } | { kind: 'conflict'; detail?: string; mergeStateStatus?: unknown } | { kind: 'moved'; headRefOid: string }
    | { kind: 'pending' } | { kind: 'none' } | { kind: 'done'; total: number; failures: CheckFailure[] } | { kind: 'failed'; detail: string }
  const checkOne = async (target: PrCiTarget, expected: string): Promise<CheckState> => {
    const view = await gh(['pr', 'view', target.prUrl, '--json', 'state,mergeable,mergeStateStatus,headRefOid,isCrossRepository,statusCheckRollup'], target.repoDir)
    if (view.code !== 0) return { kind: 'failed', detail: `gh pr view failed: ${firstLine(view) || `exit ${view.code}`}` }
    let parsed: PrCheckView
    try { parsed = JSON.parse(view.stdout) as PrCheckView } catch { return { kind: 'failed', detail: 'gh pr view returned malformed JSON' } }
    const state = String(parsed.state ?? '').toUpperCase()
    if (state === 'CLOSED' || state === 'MERGED') return { kind: 'closed', state }
    if (parsed.isCrossRepository === true) return { kind: 'failed', detail: 'The pull request comes from a fork' }
    if (String(parsed.mergeable ?? '').toUpperCase() === 'CONFLICTING' || String(parsed.mergeStateStatus ?? '').toUpperCase() === 'DIRTY') {
      return { kind: 'conflict', mergeStateStatus: parsed.mergeStateStatus ?? null }
    }
    const remoteHead = typeof parsed.headRefOid === 'string' ? parsed.headRefOid.toLowerCase() : ''
    // GitHub may lag a push; a persistent difference means someone else pushed.
    if (remoteHead && remoteHead !== expected) return { kind: 'moved', headRefOid: remoteHead }
    const summary = summarizeChecks(parsed.statusCheckRollup)
    if (summary.total === 0) return { kind: 'none' }
    if (summary.pending > 0) return { kind: 'pending' }
    return { kind: 'done', total: summary.total, failures: summary.failures }
  }

  const checks = withTargets(async (targets, { request, signal, log }) => {
    const started = now()
    const limit = Math.min(timing.timeoutMs, typeof request.timeoutMs === 'number' && request.timeoutMs > 0 ? request.timeoutMs : timing.timeoutMs)
    const expected = new Map<PrCiTarget, string>()
    for (const target of targets) {
      const sha = await head(target.worktreePath)
      if (!sha) return failed(label(targets, target, 'The PR worktree HEAD could not be verified'))
      expected.set(target, sha)
      log(label(targets, target, `Waiting for the checks of ${sha.slice(0, 12)}`))
    }
    const shas = () => multi(targets) ? { shas: targets.map(target => ({ repository: target.repositoryName, sha: expected.get(target)! })) } : { sha: expected.get(targets[0])! }
    const moves = new Map<PrCiTarget, number>()
    let interval = timing.pollMinMs
    for (;;) {
      const states: Array<{ target: PrCiTarget; state: CheckState }> = []
      for (const target of targets) states.push({ target, state: await checkOne(target, expected.get(target)!) })
      for (const { target, state } of states) {
        if (state.kind === 'failed') return failed(label(targets, target, state.detail))
        if (state.kind === 'closed') return { outcome: 'closed', output: { state: state.state, ...tagged(targets, target) } }
        if (state.kind === 'conflict') return { outcome: 'conflict', output: { mergeStateStatus: state.mergeStateStatus ?? null, ...tagged(targets, target) } }
        if (state.kind === 'moved') {
          const count = (moves.get(target) ?? 0) + 1
          moves.set(target, count)
          if (count >= 3) return { outcome: 'conflict', output: { detail: label(targets, target, 'The PR head moved on GitHub'), headRefOid: state.headRefOid, ...tagged(targets, target) } }
        }
      }
      const elapsed = now() - started
      const waiting = states.some(({ state }) => state.kind === 'pending' || state.kind === 'moved' || (state.kind === 'none' && elapsed < timing.initialDelayMs))
      if (!waiting) {
        const done = states.filter((entry): entry is { target: PrCiTarget; state: Extract<CheckState, { kind: 'done' }> } => entry.state.kind === 'done')
        if (!done.length) return { outcome: 'none', output: shas() }
        const total = done.reduce((sum, entry) => sum + entry.state.total, 0)
        const failures = done.flatMap(({ target, state }) => state.failures.map(failure => ({ failure, target })))
        if (!failures.length) return { outcome: 'green', output: { ...shas(), checks: total } }
        log(`${failures.length} check(s) failed`)
        return { outcome: 'red', output: { ...shas(), checks: total, failures: await failureEvidence(targets, failures) } }
      }
      if (now() - started >= limit) return { outcome: 'timeout', output: { ...shas(), waitedMs: now() - started } }
      await sleep(Math.min(interval, Math.max(1, limit - (now() - started))), signal)
      interval = Math.min(timing.pollMaxMs, Math.round(interval * 1.5))
    }
  })

  const failureEvidence = async (targets: PrCiTarget[], failures: Array<{ failure: CheckFailure; target: PrCiTarget }>): Promise<Array<Record<string, unknown>>> => {
    const out: Array<Record<string, unknown>> = []
    for (const { failure, target } of failures.slice(0, PR_CI_MAX_FAILED_JOBS)) {
      const entry: Record<string, unknown> = { ...tagged(targets, target), name: failure.name, conclusion: failure.conclusion, ...(failure.url ? { url: failure.url } : {}), ...(failure.summary ? { summary: redactCiText(failure.summary).slice(0, 2000) } : {}) }
      if (failure.runId) {
        const logs = await gh(['run', 'view', failure.runId, ...(failure.jobId ? ['--job', failure.jobId] : []), '--log-failed'], target.repoDir)
        if (logs.code === 0 && logs.stdout.trim()) entry.log = boundLog(redactCiText(logs.stdout))
        else entry.logUnavailable = firstLine(logs) || 'no failed-step log'
      } else entry.external = true
      out.push(entry)
    }
    if (failures.length > PR_CI_MAX_FAILED_JOBS) out.push({ omitted: failures.length - PR_CI_MAX_FAILED_JOBS })
    return out
  }

  const rerunFailed = withTargets(async (targets, { log }) => {
    const rerun: Array<{ target: PrCiTarget; id: string }> = []
    for (const target of targets) {
      const view = await gh(['pr', 'view', target.prUrl, '--json', 'statusCheckRollup'], target.repoDir)
      if (view.code !== 0) return failed(label(targets, target, `gh pr view failed: ${firstLine(view) || `exit ${view.code}`}`))
      let parsed: PrCheckView
      try { parsed = JSON.parse(view.stdout) as PrCheckView } catch { return failed(label(targets, target, 'gh pr view returned malformed JSON')) }
      for (const id of new Set(summarizeChecks(parsed.statusCheckRollup).failures.map(failure => failure.runId).filter((value): value is string => !!value))) rerun.push({ target, id })
    }
    if (!rerun.length) return { outcome: 'ok', output: { rerun: [] } }
    const done: string[] = []
    for (const { target, id } of rerun.slice(0, PR_CI_MAX_FAILED_JOBS)) {
      const result = await gh(['run', 'rerun', id, '--failed'], target.repoDir)
      if (result.code === 0) done.push(id)
      else log(label(targets, target, `Could not re-run ${id}: ${firstLine(result)}`))
    }
    return done.length ? { outcome: 'ok', output: { rerun: done } } : failed('GitHub refused to re-run the failed checks')
  })

  return { 'pr.update-base': updateBase, 'pr.sync': sync, 'pr.checks': checks, 'pr.rerun-failed': rerunFailed }
}

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
