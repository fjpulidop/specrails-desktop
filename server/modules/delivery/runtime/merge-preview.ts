/**
 * Merge preview of a project's pending deliveries (domain/merge-preview.ts):
 * for each active delivery, every branch is merged in memory against the
 * CURRENT base (`origin/<base>` as last fetched, else the local branch) with
 * `merge-tree` (merge-preview-git.ts), the base's lead is counted, and every
 * pair of pending deliveries on the same base is merged against each other to
 * find siblings that would collide at merge-back.
 *
 * Nothing here fetches, checks out or locks: it reads refs and commits. Pair
 * results are cached by sha inside merge-preview-git, so a refresh after
 * `rail.pr_state` or a job event only spends Git time on what changed. The
 * last result per delivery is kept (bounded) so read-only surfaces (the live
 * board) can show it without computing.
 */
import { listActivePrDeliveries, toPrDeliverySnapshot, type PrDeliverySnapshot } from './rail-pr-store'
import { getProjectRepositories } from '../../../project-repositories'
import {
  commitsAhead, previewPairMerge, readBranchRefs, resolveCommit, MAX_CONFLICT_FILES,
  defaultMergePreviewExec, type MergePreviewExec, type PairMerge,
} from './merge-preview-git'
import {
  summarizeMergePreview, worstStatus,
  type DeliveryMergePreview, type MergePreviewSummary, type SiblingConflict,
} from '../domain/merge-preview'

/** Decisions whose branch may still be merged (a building one previews its commits so far). */
const PREVIEWED_DECISIONS = new Set(['building', 'on_review', 'pr_draft', 'pr_ready', 'pr_failed'])

export interface MergePreviewProject {
  project: { id: string; path: string } & Parameters<typeof getProjectRepositories>[0]
  db: Parameters<typeof listActivePrDeliveries>[0]
}

interface Candidate {
  snap: PrDeliverySnapshot
  repoDir: string
  baseRef: string
  baseSha: string | null
  heads: string[]
}

const lastByDelivery = new Map<string, MergePreviewSummary>()
const LAST_LIMIT = 2000

function lastKey(projectId: string, deliveryId: string): string {
  return `${projectId}\0${deliveryId}`
}

/** Last computed summary of a delivery's preview, without computing (null when none yet). */
export function peekMergePreview(projectId: string, deliveryId: string): MergePreviewSummary | null {
  return lastByDelivery.get(lastKey(projectId, deliveryId)) ?? null
}

/** Test-only. */
export function __resetMergePreviewSummaries(): void {
  lastByDelivery.clear()
}

/** A ref's commit: from the refresh's one `for-each-ref` listing when it has one, else `rev-parse`. */
async function refCommit(repoDir: string, ref: string, refs: ReadonlyMap<string, string> | null, exec: MergePreviewExec): Promise<string | null> {
  if (refs && ref.startsWith('refs/')) return refs.get(ref) ?? null
  return resolveCommit(repoDir, ref, exec)
}

async function candidateOf(snap: PrDeliverySnapshot, primaryPath: string, exec: MergePreviewExec, refs: ReadonlyMap<string, string> | null = null): Promise<Candidate> {
  const repoDir = primaryPath
  const remote = await refCommit(repoDir, `refs/remotes/origin/${snap.baseBranch}`, refs, exec)
  const baseRef = remote ? `origin/${snap.baseBranch}` : snap.baseBranch
  const baseSha = remote ?? await refCommit(repoDir, `refs/heads/${snap.baseBranch}`, refs, exec) ?? await resolveCommit(repoDir, snap.baseBranch, exec)
  const heads: string[] = []
  // Primary-repository branches only: a multi-repository group's members are
  // separate deliveries with their own repositories (not previewed here).
  for (const unit of snap.units.filter((u) => !u.repositoryId)) {
    const head = unit.finalSha && /^[0-9a-f]{40,64}$/i.test(unit.finalSha)
      ? unit.finalSha
      : await refCommit(repoDir, `refs/heads/${unit.branch}`, refs, exec)
    if (head) heads.push(head)
  }
  if (heads.length === 0 && snap.deliverySha) heads.push(snap.deliverySha)
  return { snap, repoDir, baseRef, baseSha, heads: [...new Set(heads)] }
}

function mergeFiles(results: PairMerge[]): { files: string[]; count: number } {
  const files = [...new Set(results.flatMap((r) => r.files))]
  // Each pair caps its list; the union is a lower bound of the real count.
  const count = Math.max(files.length, ...results.map((r) => r.fileCount))
  return { files: files.slice(0, MAX_CONFLICT_FILES), count }
}

/**
 * Previews of every active delivery of one project (optionally only those
 * listed in `only`, while siblings are still computed against all of them).
 */
export async function computeMergePreviews(
  target: MergePreviewProject,
  options: { only?: ReadonlySet<string>; exec?: MergePreviewExec; now?: () => Date } = {},
): Promise<DeliveryMergePreview[]> {
  const exec = options.exec ?? defaultMergePreviewExec
  const now = (options.now ?? (() => new Date()))().toISOString()
  const snaps = listActivePrDeliveries(target.db).map(toPrDeliverySnapshot)
    .filter((snap) => PREVIEWED_DECISIONS.has(snap.decision) && !snap.executionManifest)
  const primary = getProjectRepositories(target.project).find((repo) => repo.isPrimary)?.path ?? target.project.path
  // One ref listing per refresh: an unchanged project then costs one Git call
  // (pair merges and base leads are cached by commit sha).
  const refs = snaps.length ? await readBranchRefs(primary, exec).catch(() => null) : null
  const candidates = await Promise.all(snaps.map((snap) => candidateOf(snap, primary, exec, refs)))

  // Sibling pairs: pending deliveries on the same base, each pair merged once.
  const siblingsOf = new Map<string, SiblingConflict[]>()
  const pairs: Array<Promise<void>> = []
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!, b = candidates[j]!
      if (a.snap.baseBranch !== b.snap.baseBranch || !a.heads.length || !b.heads.length) continue
      if (options.only && !options.only.has(a.snap.id) && !options.only.has(b.snap.id)) continue
      pairs.push((async () => {
        const results = await Promise.all(a.heads.flatMap((ha) => b.heads.map((hb) => previewPairMerge(a.repoDir, ha, hb, exec))))
        const conflicting = results.filter((r) => r.status === 'conflicts')
        if (!conflicting.length) return
        const { files, count } = mergeFiles(conflicting)
        const push = (owner: Candidate, other: Candidate): void => {
          const list = siblingsOf.get(owner.snap.id) ?? []
          list.push({ deliveryId: other.snap.id, railIndex: other.snap.railIndex, files, fileCount: count })
          siblingsOf.set(owner.snap.id, list)
        }
        push(a, b)
        push(b, a)
      })())
    }
  }

  const previews = await Promise.all(candidates
    .filter((c) => !options.only || options.only.has(c.snap.id))
    .map(async (c): Promise<DeliveryMergePreview> => {
      const base: Omit<DeliveryMergePreview, 'status' | 'conflictFiles' | 'conflictFileCount' | 'baseAdvancedBy' | 'reason'> = {
        deliveryId: c.snap.id, railIndex: c.snap.railIndex, baseRef: c.baseRef, baseSha: c.baseSha, siblings: [], computedAt: now,
      }
      if (!c.baseSha) return { ...base, status: 'unknown', conflictFiles: [], conflictFileCount: 0, baseAdvancedBy: null, reason: 'base_unresolved' }
      if (!c.heads.length) return { ...base, status: 'unknown', conflictFiles: [], conflictFileCount: 0, baseAdvancedBy: null, reason: 'no_commits' }
      const [merges, ahead] = await Promise.all([
        Promise.all(c.heads.map((head) => previewPairMerge(c.repoDir, c.baseSha!, head, exec))),
        Promise.all(c.heads.map((head) => commitsAhead(c.repoDir, head, c.baseSha!, exec))),
      ])
      const conflicting = merges.filter((m) => m.status === 'conflicts')
      const { files, count } = mergeFiles(conflicting)
      const known = ahead.filter((n): n is number => n !== null)
      const status = worstStatus(merges.map((m) => m.status))
      return {
        ...base,
        status,
        conflictFiles: files,
        conflictFileCount: count,
        baseAdvancedBy: known.length ? Math.max(...known) : null,
        reason: status === 'unknown' ? merges.find((m) => m.error)?.error ?? null : null,
      }
    }))
  await Promise.all(pairs)
  for (const preview of previews) {
    preview.siblings = (siblingsOf.get(preview.deliveryId) ?? []).sort((x, y) => x.railIndex - y.railIndex)
    lastByDelivery.set(lastKey(target.project.id, preview.deliveryId), summarizeMergePreview(preview))
    if (lastByDelivery.size > LAST_LIMIT) lastByDelivery.delete(lastByDelivery.keys().next().value as string)
  }
  return previews
}

// ─── background warm (live board) ─────────────────────────────────────────────
const WARM_INTERVAL_MS = 10_000
const warming = new Map<string, { at: number; running: boolean }>()

/**
 * Recompute a project's previews in the background, at most once per
 * {@link WARM_INTERVAL_MS}; calls `onChanged` when a summary changed, so a
 * read-only surface can refresh. Never throws.
 */
export function warmMergePreviews(target: MergePreviewProject, onChanged: () => void, now: () => number = Date.now): void {
  const state = warming.get(target.project.id)
  if (state && (state.running || now() - state.at < WARM_INTERVAL_MS)) return
  warming.set(target.project.id, { at: now(), running: true })
  const before = new Map([...lastByDelivery].filter(([key]) => key.startsWith(`${target.project.id}\0`)).map(([key, value]) => [key, JSON.stringify(value)]))
  void computeMergePreviews(target)
    .then((previews) => {
      const changed = previews.some((p) => before.get(lastKey(target.project.id, p.deliveryId)) !== JSON.stringify(summarizeMergePreview(p)))
      if (changed) onChanged()
    })
    .catch((err) => console.warn(`[merge-preview] background refresh failed for ${target.project.id}: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => { warming.set(target.project.id, { at: now(), running: false }) })
}

/** Test-only. */
export function __resetMergePreviewWarming(): void {
  warming.clear()
}
