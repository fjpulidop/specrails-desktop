import treeKill from 'tree-kill'
import type { ChildProcess } from 'child_process'

/**
 * Registry of fire-and-forget child processes that are NOT owned by a long-lived
 * manager (QueueManager / ChatManager / SetupManager track their own). The Quick
 * spec-generation spawn in particular keeps only a closure handle + a watchdog,
 * so `ProjectRegistry.removeProject()` / `shutdown()` could not terminate it —
 * it survived project removal (burning AI-CLI spend) until the watchdog fired.
 *
 * Children registered here are tree-killed when their project is removed or the
 * app shuts down. Self-cleaning: each child is auto-unregistered on `close`.
 */
const byProject = new Map<string, Set<ChildProcess>>()

/** Track a child under a projectId; auto-removes itself on close. */
export function trackTransientChild(projectId: string, child: ChildProcess): void {
  let set = byProject.get(projectId)
  if (!set) {
    set = new Set()
    byProject.set(projectId, set)
  }
  set.add(child)
  const drop = (): void => {
    const s = byProject.get(projectId)
    if (s) {
      s.delete(child)
      if (s.size === 0) byProject.delete(projectId)
    }
  }
  child.once('close', drop)
  child.once('error', drop)
}

/** SIGTERM the whole subtree of every tracked child for a project, then forget. */
export function killTransientChildren(projectId: string): void {
  const set = byProject.get(projectId)
  if (!set) return
  for (const child of set) {
    if (child.pid) {
      try { treeKill(child.pid, 'SIGTERM') } catch { /* best-effort */ }
    }
  }
  byProject.delete(projectId)
}
