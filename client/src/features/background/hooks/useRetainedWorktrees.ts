import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getRetainedSizes, getRetainedWorktrees, removeRetainedWorktrees,
  type RetainedRemovalResult, type RetainedSize, type RetainedWorktree, type RetainedWorktreesSnapshot,
} from '../lib/retained-worktrees-api'
import { retainedKey } from '../lib/retained-worktrees-model'

/** Disk scans run on the server; re-ask while any is still scanning. */
export const RETAINED_SIZE_POLL_MS = 1500

/**
 * Retained run worktrees across projects, read only while the Storage pane is
 * shown. The Git evidence comes with the list; disk sizes are scanned lazily
 * on the server and polled until every one is known.
 */
export function useRetainedWorktrees(active: boolean) {
  const [snapshot, setSnapshot] = useState<RetainedWorktreesSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sizes, setSizes] = useState<Map<string, RetainedSize>>(() => new Map())
  const controller = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setLoading(true)
    try {
      const next = await getRetainedWorktrees(current.signal)
      if (current.signal.aborted) return
      setSnapshot(next)
      setError(null)
    } catch (err) {
      if (!current.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!current.signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    void refresh()
    return () => { controller.current?.abort() }
  }, [active, refresh])

  // Sizes: ask for every listed worktree, then only for the ones still scanning.
  const items = snapshot?.items
  useEffect(() => {
    if (!active || !items || items.length === 0) return
    let cancelled = false
    let timer: number | undefined
    const sizeController = new AbortController()
    let pending: RetainedWorktree[] = items
    const poll = async () => {
      try {
        const answers = await getRetainedSizes(pending.map(item => ({ projectId: item.projectId, id: item.id })), sizeController.signal)
        if (cancelled) return
        setSizes(previous => {
          const next = new Map(previous)
          for (const answer of answers) if (answer.size) next.set(retainedKey(answer), answer.size)
          return next
        })
        const scanning = new Set(answers.filter(answer => answer.size?.status === 'scanning').map(retainedKey))
        pending = pending.filter(item => scanning.has(retainedKey(item)))
      } catch {
        if (cancelled) return
      }
      if (pending.length > 0) timer = window.setTimeout(() => { void poll() }, RETAINED_SIZE_POLL_MS)
    }
    void poll()
    return () => { cancelled = true; sizeController.abort(); if (timer !== undefined) window.clearTimeout(timer) }
  }, [active, items])

  const remove = useCallback(async (selected: RetainedWorktree[], deleteBranches: boolean): Promise<RetainedRemovalResult[]> => {
    const results = await removeRetainedWorktrees(selected.filter(item => item.head).map(item => ({
      projectId: item.projectId, id: item.id, head: item.head!, deleteBranch: deleteBranches && item.evaluation.branchDeletable,
    })))
    await refresh()
    return results
  }, [refresh])

  return { snapshot, error, loading, sizes, refresh, remove }
}
