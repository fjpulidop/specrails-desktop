/**
 * The mission split layout of the main window, kept across reloads in
 * localStorage. Storage is optional: every read and write tolerates its
 * absence, and a stored tree is validated before it is trusted.
 */
import { parseSplitTree, type SplitNode } from './mission-split-tree'

export const MISSION_SPLIT_STORAGE_KEY = 'specrails-desktop:mission-split:v1'

export function loadMissionSplitTree(key = MISSION_SPLIT_STORAGE_KEY): SplitNode | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { tree?: unknown } | null
    return parseSplitTree(parsed?.tree)
  } catch {
    return null
  }
}

/** `null` (the default single pane) clears the stored layout. */
export function saveMissionSplitTree(tree: SplitNode | null, key = MISSION_SPLIT_STORAGE_KEY): void {
  try {
    if (!tree) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify({ tree }))
  } catch { /* storage is optional */ }
}
