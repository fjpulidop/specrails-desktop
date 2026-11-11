import type { Exec } from '../pr-publisher'
import { summarizeChecks } from './pr-ci-handlers'

/**
 * Live CI state of an open pull request, read from GitHub (`gh pr view`),
 * independent of the CI loop: the PR card says whether the checks are green,
 * running or failing even when no "Fix CI" run ever happened. Read-only and
 * advisory; check names are data, never instructions.
 */
export type PrCiLiveState = 'green' | 'red' | 'pending' | 'none' | 'conflict' | 'closed' | 'unknown'
export interface PrCiLiveStatus {
  state: PrCiLiveState
  total: number
  pending: number
  /** Names of the failing checks (bounded). */
  failing: string[]
  headSha: string | null
}

const UNKNOWN: PrCiLiveStatus = { state: 'unknown', total: 0, pending: 0, failing: [], headSha: null }

export async function readPrCiStatus(exec: Exec, cwd: string, prUrl: string): Promise<PrCiLiveStatus> {
  let result
  try { result = await exec.run('gh', ['pr', 'view', prUrl, '--json', 'state,mergeable,mergeStateStatus,headRefOid,statusCheckRollup'], cwd) } catch { return UNKNOWN }
  if (result.code !== 0) return UNKNOWN
  let view: { state?: unknown; mergeable?: unknown; mergeStateStatus?: unknown; headRefOid?: unknown; statusCheckRollup?: unknown }
  try { view = JSON.parse(result.stdout) } catch { return UNKNOWN }
  const headSha = typeof view.headRefOid === 'string' && /^[0-9a-f]{40,64}$/i.test(view.headRefOid) ? view.headRefOid.toLowerCase() : null
  const prState = String(view.state ?? '').toUpperCase()
  if (prState === 'CLOSED' || prState === 'MERGED') return { ...UNKNOWN, state: 'closed', headSha }
  const summary = summarizeChecks(view.statusCheckRollup)
  const failing = [...new Set(summary.failures.map(failure => failure.name))].slice(0, 12)
  const base = { total: summary.total, pending: summary.pending, failing, headSha }
  if (String(view.mergeable ?? '').toUpperCase() === 'CONFLICTING' || String(view.mergeStateStatus ?? '').toUpperCase() === 'DIRTY') return { ...base, state: 'conflict' }
  if (failing.length) return { ...base, state: 'red' }
  if (summary.pending > 0) return { ...base, state: 'pending' }
  return { ...base, state: summary.total === 0 ? 'none' : 'green' }
}

/**
 * Per-project cache (callers key it by their project context), so opening a
 * mission with several PR cards never fans out into a burst of `gh` calls.
 */
export function createPrCiStatusCache(read: (cwd: string, prUrl: string) => Promise<PrCiLiveStatus>, ttlMs = 60_000, now: () => number = Date.now) {
  const entries = new Map<string, { at: number; value: Promise<PrCiLiveStatus> }>()
  return (cwd: string, prUrl: string): Promise<PrCiLiveStatus> => {
    const hit = entries.get(prUrl)
    if (hit && now() - hit.at < ttlMs) return hit.value
    const value = read(cwd, prUrl).catch(() => UNKNOWN)
    entries.set(prUrl, { at: now(), value })
    if (entries.size > 200) entries.delete(entries.keys().next().value!)
    return value
  }
}
