// ─── Background merge watch ─────────────────────────────────────────────────
// A pull request is usually merged on GitHub, outside Specrails. Without this
// watch the delivery stays `pr_draft`/`pr_ready` until someone presses
// "Verify PR" (or the optional CI watch happens to see it), so the board, the
// mission card and an Intent's closing card never learn the work landed.
//
// Cost is bounded on purpose:
// - only deliveries whose PR is out for review are watched (not missions):
//   with none open a tick is one SQLite query and no GitHub call;
// - each delivery is checked less often as its PR ages (3 min → 2 h);
// - the due PRs of one repository are read in ONE GraphQL call (state only),
//   chunked, instead of one `gh pr view` per PR.
// Only a terminal PR (MERGED or CLOSED) is acted on, and then through the very
// same `poll-merge` decision the "Verify PR" button runs (same repository
// lock, process admission and CAS, full lifecycle evidence), so an open PR —
// even one someone pushed to — is never touched by the watch.

import type { DbInstance } from '../../../db'
import type { WsMessage } from '../../../types'
import type { JiraSyncManager } from '../../../jira/jira-sync-manager'
import { captureProcessAdmission } from '../../../process-admission'
import { withRepoLock } from '../../../repo-lock'
import { defaultGitRunner } from '../../../worktree-manager'
import { defaultExec, type Exec } from './pr-publisher'
import { executePrDecision } from './rail-pr-decision'
import { getPrDelivery, listActivePrDeliveries, type RailPrDeliveryRow } from './rail-pr-store'

/** Tick period; a delivery is only observed when its own back-off is due. */
export const PR_MERGE_WATCH_INTERVAL_MS = 3 * 60_000
const FIRST_TICK_MS = 30_000
/** PRs per GraphQL call (aliases in one query). */
const CHUNK = 50

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** How long to wait between observations of one PR, by the PR's age. */
export function checkIntervalMs(ageMs: number): number {
  if (ageMs < HOUR) return 3 * MINUTE
  if (ageMs < 24 * HOUR) return 10 * MINUTE
  if (ageMs < 7 * 24 * HOUR) return 30 * MINUTE
  return 2 * HOUR
}

export interface PrMergeWatchDeps {
  db: DbInstance
  project: { id: string; slug: string; path: string }
  broadcast: (message: WsMessage) => void
  jiraSyncManager?: JiraSyncManager | null
  exec?: Exec
  /** Test seams: the decision and the lock the button uses, and the clock. */
  execute?: typeof executePrDecision
  lock?: <T>(path: string, fn: () => Promise<T>) => Promise<T>
  admission?: () => { assertCurrent(): void }
  now?: () => number
  intervalMs?: number
  log?: (message: string) => void
}

/** Deliveries whose PR is out for review and that no decision holds right now.
 * Multi-repository generations are left to their own Verify (one PR per member). */
export function watchedDeliveries(rows: readonly RailPrDeliveryRow[]): RailPrDeliveryRow[] {
  return rows.filter((row) => (row.decision === 'pr_ready' || row.decision === 'pr_draft') && Boolean(row.pr_url) && !row.operation_token && !row.execution_manifest)
}

/** `https://github.com/<owner>/<repo>/pull/<n>` → its parts; null otherwise. */
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url)
  if (!match) return null
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) }
}

/** One GraphQL call: the state of each PR number of one repository. */
async function readStates(exec: Exec, dir: string, owner: string, repo: string, numbers: number[]): Promise<Map<number, string> | null> {
  const fields = numbers.map((number) => `p${number}: pullRequest(number: ${number}) { state }`).join(' ')
  const query = `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${fields} } }`
  // `-f` sends owner/repo as strings (`-F` would coerce a repo named `123`).
  const result = await exec.run('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`], dir)
  // A deleted PR makes GraphQL answer partially (with errors): read what came.
  let parsed: { data?: { repository?: Record<string, { state?: unknown } | null> | null } }
  try { parsed = JSON.parse(result.stdout) as typeof parsed } catch { return null }
  const repository = parsed.data?.repository
  if (!repository) return null
  const states = new Map<number, string>()
  for (const number of numbers) {
    const state = repository[`p${number}`]?.state
    if (typeof state === 'string') states.set(number, state.toUpperCase())
  }
  return states
}

export interface PrMergeWatchState {
  /** Last observation per delivery id (epoch ms). */
  checkedAt: Map<string, number>
}

/**
 * One pass: observe the due open PRs (one call per repository) and settle the
 * terminal ones exactly as "Verify PR" would. Returns how many were settled.
 * Never throws.
 */
export async function pollPrMerges(deps: PrMergeWatchDeps, state: PrMergeWatchState = { checkedAt: new Map() }): Promise<number> {
  const exec = deps.exec ?? defaultExec
  const execute = deps.execute ?? executePrDecision
  const lock = deps.lock ?? withRepoLock
  const log = deps.log ?? ((message: string) => console.warn(message))
  const now = (deps.now ?? Date.now)()
  let watched: RailPrDeliveryRow[]
  try { watched = watchedDeliveries(listActivePrDeliveries(deps.db)) } catch { return 0 }
  // Forget deliveries that left review (settled, discarded, superseded).
  const live = new Set(watched.map((row) => row.id))
  for (const id of state.checkedAt.keys()) if (!live.has(id)) state.checkedAt.delete(id)

  const groups = new Map<string, { owner: string; repo: string; dir: string; rows: Array<{ row: RailPrDeliveryRow; number: number }> }>()
  for (const row of watched) {
    const pr = parsePrUrl(row.pr_url!)
    if (!pr) continue
    const since = Date.parse(row.published_at ?? row.decided_at ?? row.created_at ?? '') || now
    const last = state.checkedAt.get(row.id)
    if (last !== undefined && now - last < checkIntervalMs(now - since)) continue
    const key = `${pr.owner}/${pr.repo}`.toLowerCase()
    const group = groups.get(key) ?? { owner: pr.owner, repo: pr.repo, dir: row.repository_path || deps.project.path, rows: [] }
    group.rows.push({ row, number: pr.number })
    groups.set(key, group)
  }

  let settled = 0
  for (const group of groups.values()) {
    for (let index = 0; index < group.rows.length; index += CHUNK) {
      const chunk = group.rows.slice(index, index + CHUNK)
      let states: Map<number, string> | null = null
      try { states = await readStates(exec, group.dir, group.owner, group.repo, chunk.map((entry) => entry.number)) } catch { states = null }
      if (!states) continue // gh missing or offline: retry next tick, no back-off recorded
      for (const { row, number } of chunk) {
        state.checkedAt.set(row.id, now)
        const prState = states.get(number)
        if (prState !== 'MERGED' && prState !== 'CLOSED') continue
        try {
          // Re-read: a decision may have started (or settled it) while gh ran.
          const current = getPrDelivery(deps.db, row.id)
          if (!current || current.decision !== row.decision || current.operation_token) continue
          const admission = (deps.admission ?? (() => captureProcessAdmission(deps.project.id)))()
          const result = await lock(deps.project.path, () => {
            admission.assertCurrent()
            return execute({
              db: deps.db,
              project: deps.project,
              git: defaultGitRunner,
              exec,
              broadcast: deps.broadcast,
              jiraSyncManager: deps.jiraSyncManager ?? undefined,
              assertAdmission: () => admission.assertCurrent(),
            } as Parameters<typeof executePrDecision>[0], { prDeliveryId: row.id, action: 'poll-merge', expectedDecision: row.decision })
          })
          if (result.status < 300) settled++
        } catch (error) {
          log(`[pr-merge-watch] ${deps.project.slug}: ${row.id} not settled: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }
  return settled
}

/** Start the per-project watch; ticks never overlap. */
export function startPrMergeWatch(deps: PrMergeWatchDeps): { stop(): void; tick(): Promise<number> } {
  const state: PrMergeWatchState = { checkedAt: new Map() }
  let running: Promise<number> | null = null
  let stopped = false
  const tick = (): Promise<number> => {
    if (stopped) return Promise.resolve(0)
    if (running) return running
    running = pollPrMerges(deps, state).finally(() => { running = null })
    return running
  }
  const run = (): void => { void tick() }
  const first = setTimeout(run, FIRST_TICK_MS)
  const timer = setInterval(run, deps.intervalMs ?? PR_MERGE_WATCH_INTERVAL_MS)
  first.unref?.()
  timer.unref?.()
  return { stop: () => { stopped = true; clearTimeout(first); clearInterval(timer) }, tick }
}
