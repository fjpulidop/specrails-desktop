/**
 * "Mark file viewed" for the Changes tab. A mark belongs to one viewer (it lives
 * in this browser's localStorage), one delivery and one file, and records the
 * file's content hash: when the file's diff changes (a new revision, a moved
 * base) the mark no longer matches and the file reads as unviewed again.
 */
import type { ChangedFile } from './changes-model'

export type ViewedMap = Record<string, string>

const keyFor = (projectId: string, deliveryId: string): string => `specrails-desktop:review-viewed:${projectId}:${deliveryId}`

export function readViewed(projectId: string, deliveryId: string): ViewedMap {
  try {
    const raw = localStorage.getItem(keyFor(projectId, deliveryId))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

function writeViewed(projectId: string, deliveryId: string, map: ViewedMap): void {
  try { localStorage.setItem(keyFor(projectId, deliveryId), JSON.stringify(map)) } catch { /* private mode etc. */ }
}

export function isViewed(map: ViewedMap, file: Pick<ChangedFile, 'path' | 'hash'>): boolean {
  return map[file.path] === file.hash
}

/** Marked once, but the file's diff changed since. */
export function changedSinceViewed(map: ViewedMap, file: Pick<ChangedFile, 'path' | 'hash'>): boolean {
  return file.path in map && map[file.path] !== file.hash
}

export function countViewed(map: ViewedMap, files: readonly ChangedFile[]): number {
  return files.reduce((n, file) => n + (isViewed(map, file) ? 1 : 0), 0)
}

/** Toggle one file; returns the new map (also persisted). */
export function toggleViewed(projectId: string, deliveryId: string, map: ViewedMap, file: ChangedFile): ViewedMap {
  const next = { ...map }
  if (isViewed(map, file)) delete next[file.path]
  else next[file.path] = file.hash
  writeViewed(projectId, deliveryId, next)
  return next
}

const DIFF_MODE_KEY = 'specrails-desktop:review-diff-mode'
export function readDiffMode(): 'unified' | 'split' {
  try { return localStorage.getItem(DIFF_MODE_KEY) === 'split' ? 'split' : 'unified' } catch { return 'unified' }
}
export function writeDiffMode(mode: 'unified' | 'split'): void {
  try { localStorage.setItem(DIFF_MODE_KEY, mode) } catch { /* private mode etc. */ }
}
