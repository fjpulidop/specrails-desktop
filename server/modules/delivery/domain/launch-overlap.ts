/**
 * Conflict-aware launches (pure): which files a spec is likely to touch, and
 * which other rails of the same repository are likely to touch the same ones.
 *
 * Parallel rails on one repository merge back one after the other: two that
 * edit the same file conflict or need a rebase at merge time. A launch now
 * says so up front, from the files the specs name and the files the running
 * rails have actually written, so the person can integrate them in order (or
 * stack one on the other) instead of finding out at merge.
 */

const EXTENSIONS = 'c|cc|cpp|cs|css|dart|ex|exs|go|gradle|h|hpp|html|java|js|json|jsx|kt|lua|md|mdx|mjs|cjs|php|py|rb|rs|scss|sh|sql|svelte|swift|toml|ts|tsx|txt|vue|xml|ya?ml'
const PATH = new RegExp(`(?:^|[\\s\`'"(\\[])((?:[\\w.@-]+/)*[\\w.@-]+\\.(?:${EXTENSIONS}))(?=$|[\\s\`'"),.:;\\]])`, 'gi')

/** Repository-relative file paths a spec's text names (`src/cart.js`, `README.md`). Pure. */
export function mentionedPaths(text: string): string[] {
  const out = new Set<string>()
  for (const match of String(text ?? '').matchAll(PATH)) {
    const value = match[1]!.replace(/^\.\//, '')
    if (value.startsWith('/') || value.split('/').includes('..') || /^\d+(\.\d+)+$/.test(value)) continue
    out.add(value)
  }
  return [...out].sort()
}

/** A path written by an agent inside a run worktree, relative to that worktree (null outside it). Pure. */
export function worktreeRelative(file: string, worktree: string): string | null {
  const root = worktree.replace(/[\\/]+$/, '')
  if (!file.startsWith(root + '/') && !file.startsWith(root + '\\')) return null
  const relative = file.slice(root.length + 1).replace(/\\/g, '/')
  return relative && !relative.split('/').includes('..') ? relative : null
}

export interface OverlapPeer {
  railIndex: number
  /** `running`: a rail working now; `pending`: a delivery waiting for its merge. */
  state: 'running' | 'pending'
  title: string | null
  paths: readonly string[]
}

export interface LaunchOverlap { railIndex: number; state: OverlapPeer['state']; title: string | null; files: string[] }

/** Generated or shared files every change may touch: never a sign of a real conflict. */
const IGNORED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|CHANGELOG\.md)$|^openspec\//

/** The other rails a launch will likely collide with, by shared files (sorted by rail). Pure. */
export function predictOverlaps(paths: readonly string[], peers: readonly OverlapPeer[]): LaunchOverlap[] {
  const mine = new Set(paths.filter((p) => !IGNORED.test(p)))
  if (!mine.size) return []
  const out: LaunchOverlap[] = []
  for (const peer of peers) {
    const files = [...new Set(peer.paths)].filter((p) => mine.has(p)).sort()
    if (files.length) out.push({ railIndex: peer.railIndex, state: peer.state, title: peer.title, files })
  }
  return out.sort((a, b) => a.railIndex - b.railIndex)
}

/** The run-log line of a launch's overlaps (null when none). Pure. */
export function overlapLogLine(overlaps: readonly LaunchOverlap[]): string | null {
  if (!overlaps.length) return null
  const parts = overlaps.map((o) => `rail ${o.railIndex + 1}${o.title ? ` ("${o.title}")` : ''}, ${o.state === 'running' ? 'running' : 'waiting to merge'}: ${o.files.slice(0, 5).join(', ')}${o.files.length > 5 ? ` +${o.files.length - 5}` : ''}`)
  return `⚠ Likely overlap with ${parts.join('; ')}. Merge these one after the other; the later one may need a rebase and a new verification.`
}
