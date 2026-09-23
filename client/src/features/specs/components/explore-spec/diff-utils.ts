import { diffWords } from 'diff'

/**
 * A single piece of a word-level diff between two strings.
 * - `added: true` → segment exists only in the proposed text
 * - `removed: true` → segment exists only in the baseline text
 * - neither flag → segment is unchanged
 *
 * See openspec/changes/power-up-explore-review-diff/design.md D3+D4.
 */
export interface DiffSegment {
  value: string
  added?: boolean
  removed?: boolean
}

/**
 * Word-level diff suitable for prose fields like `title` and `description`.
 * Thin wrapper around the existing `diff` package's `diffWords` so the
 * Review overlay and the legacy `AiEditDiffView` stay aligned over time.
 */
export function wordDiff(baseline: string, proposed: string): DiffSegment[] {
  const parts = diffWords(baseline, proposed)
  return parts.map((p) => ({
    value: p.value,
    ...(p.added ? { added: true } : {}),
    ...(p.removed ? { removed: true } : {}),
  }))
}

export type ArrayDiffStatus = 'added' | 'removed' | 'unchanged'

export interface ArrayDiffEntry<T> {
  value: T
  status: ArrayDiffStatus
}

export interface ArrayDiffResult<T> {
  /** Items present in `proposed` and not in `baseline`. Order follows `proposed`. */
  added: T[]
  /** Items present in `baseline` and not in `proposed`. Order follows `baseline`. */
  removed: T[]
  /** Items present in both. Order follows `proposed`. */
  unchanged: T[]
  /**
   * Single sequence in proposed order (unchanged + added interleaved as they
   * appear in `proposed`), followed by `removed` in baseline order. Useful
   * for rendering a single visual list that respects the proposed sequence.
   */
  ordered: ArrayDiffEntry<T>[]
}

/**
 * Set-based diff for arrays like `labels` and `acceptanceCriteria`. Order of
 * `unchanged` and `added` follows the proposed array; `removed` follows the
 * baseline array. Duplicates inside either input are de-duplicated using the
 * equality comparator.
 */
export function arrayDiff<T>(
  baseline: T[],
  proposed: T[],
  eq: (a: T, b: T) => boolean = (a, b) => a === b,
): ArrayDiffResult<T> {
  const inBaseline = (item: T): boolean => baseline.some((b) => eq(b, item))
  const inProposed = (item: T): boolean => proposed.some((p) => eq(p, item))

  const ordered: ArrayDiffEntry<T>[] = []
  const seenAdded: T[] = []
  const seenUnchanged: T[] = []
  for (const p of proposed) {
    if (ordered.some((e) => eq(e.value, p))) continue
    if (inBaseline(p)) {
      seenUnchanged.push(p)
      ordered.push({ value: p, status: 'unchanged' })
    } else {
      seenAdded.push(p)
      ordered.push({ value: p, status: 'added' })
    }
  }

  const seenRemoved: T[] = []
  for (const b of baseline) {
    if (seenRemoved.some((x) => eq(x, b))) continue
    if (!inProposed(b)) {
      seenRemoved.push(b)
      ordered.push({ value: b, status: 'removed' })
    }
  }

  return { added: seenAdded, removed: seenRemoved, unchanged: seenUnchanged, ordered }
}
