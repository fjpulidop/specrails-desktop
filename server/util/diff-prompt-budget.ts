/**
 * Fit a unified diff into a prompt budget fairly.
 *
 * Cutting a multi-file diff at a character count lets the first large file
 * (a lockfile, a generated bundle, a snapshot) consume the whole budget and
 * hides every human-authored change after it. Instead the diff is split at
 * `diff --git` boundaries, each file receives an equal share, and the share a
 * small file does not need is redistributed to the files still wanting more.
 * Each clipped file ends on a line boundary (unless one very long line would
 * waste most of its share) with an explicit marker, and a summary line states
 * how many files were shortened or omitted, so the model never mistakes a
 * clipped diff for the whole change.
 *
 * Pure: no I/O. Budgets are UTF-16 code units (JavaScript string length).
 */

const FILE_BOUNDARY = '\ndiff --git '

export interface DiffBudgetResult {
  text: string
  /** Files whose section was shortened (but kept at least partly). */
  truncatedFiles: number
  /** Files that received no budget at all. */
  omittedFiles: number
  /** Total files found in the input. */
  totalFiles: number
}

/** Split at `diff --git` headers. Text before the first header stays with it. */
export function splitDiffIntoFileSections(diff: string): string[] {
  const sections: string[] = []
  let start = 0
  let next = diff.startsWith('diff --git ') ? diff.indexOf(FILE_BOUNDARY, 1) : diff.indexOf(FILE_BOUNDARY)
  while (next !== -1) {
    sections.push(diff.slice(start, next + 1))
    start = next + 1
    next = diff.indexOf(FILE_BOUNDARY, start)
  }
  sections.push(diff.slice(start))
  return sections.filter((section) => section.length > 0)
}

/**
 * Water-filling allocation: every active item gets an equal share of what is
 * left; items needing less keep only what they need and release the rest.
 * Returns per-item grants summing to at most `budget`.
 */
export function allocateBudgetFairly(sizes: readonly number[], budget: number): number[] {
  const alloc = sizes.map(() => 0)
  let active = sizes.map((_, i) => i).filter((i) => sizes[i] > 0)
  let remaining = Math.max(0, Math.floor(budget))
  while (active.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / active.length)
    if (share === 0) {
      // Fewer units than items: hand the last units out in order.
      for (const i of active) {
        if (remaining === 0) break
        alloc[i] += 1
        remaining -= 1
      }
      break
    }
    const stillActive: number[] = []
    for (const i of active) {
      const need = sizes[i] - alloc[i]
      const grant = Math.min(need, share)
      alloc[i] += grant
      remaining -= grant
      if (grant < need) stillActive.push(i)
    }
    active = stillActive
  }
  return alloc
}

function markerFor(omitted: number): string {
  return `\n…(diff truncated, ${omitted} characters omitted)\n`
}

/** Clip one section to `limit`, preferring a whole-line cut, with a marker. */
export function clipOnLineBoundary(section: string, limit: number): string {
  if (section.length <= limit) return section
  if (limit <= 0) return ''
  let marker = markerFor(section.length)
  if (marker.length >= limit) return marker.slice(0, limit)
  const target = limit - marker.length
  const lineBreak = section.lastIndexOf('\n', target)
  // Back up to the previous newline unless one very long line would discard
  // most of the allowance.
  const cut = lineBreak > target / 2 ? lineBreak : target
  marker = markerFor(section.length - cut)
  return `${section.slice(0, Math.min(cut, Math.max(0, limit - marker.length)))}${marker}`
}

/**
 * Fit `diff` into `budget` characters, sharing the budget fairly across files.
 * A diff that already fits is returned unchanged. The summary line (counted
 * inside the budget) says how many files were shortened or omitted.
 */
export function truncateDiffForPrompt(diff: string, budget: number): DiffBudgetResult {
  const sections = splitDiffIntoFileSections(diff)
  const totalFiles = sections.filter((section) => section.startsWith('diff --git ')).length || (diff ? 1 : 0)
  if (diff.length <= budget) return { text: diff, truncatedFiles: 0, omittedFiles: 0, totalFiles }
  const summaryFor = (truncated: number, omitted: number): string =>
    `\n…(diff shortened to fit: ${truncated} of ${totalFiles} file${totalFiles === 1 ? '' : 's'} truncated${omitted ? `, ${omitted} omitted` : ''})\n`
  // Reserve the worst-case summary so the result never exceeds the budget.
  const reserve = summaryFor(totalFiles, totalFiles).length
  const usable = Math.max(0, budget - reserve)
  const grants = allocateBudgetFairly(sections.map((section) => section.length), usable)
  let truncatedFiles = 0
  let omittedFiles = 0
  const parts = sections.map((section, i) => {
    if (grants[i] >= section.length) return section
    if (grants[i] === 0 || grants[i] < markerFor(section.length).length) {
      omittedFiles++
      return ''
    }
    truncatedFiles++
    return clipOnLineBoundary(section, grants[i])
  })
  const text = `${parts.join('')}${summaryFor(truncatedFiles, omittedFiles)}`
  return { text: text.length <= budget ? text : text.slice(0, budget), truncatedFiles, omittedFiles, totalFiles }
}
