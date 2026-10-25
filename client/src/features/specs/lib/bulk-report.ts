import { toast } from 'sonner'

type T = (key: string, options?: Record<string, unknown>) => string

export type BulkKind = 'moved' | 'labeled' | 'prioritized' | 'railed' | 'deleted'

/**
 * One toast for a whole bulk operation.
 *
 * - Everything worked and an Undo toast already says so: stay quiet.
 * - Everything worked with nothing to undo (Jira moves, rail moves): one success toast.
 * - Partly failed: one warning with the counts (the Undo toast, if any, covers the rest).
 * - Nothing worked: one error.
 */
export function reportBulk(t: T, kind: BulkKind, result: { ok: number; failed: number; undoable?: boolean }): void {
  const { ok, failed, undoable = false } = result
  if (failed === 0) {
    if (ok > 0 && !undoable) toast.success(t(`bulk.result.${kind}`, { count: ok }))
    return
  }
  if (ok === 0) {
    toast.error(t('bulk.failedAll', { count: failed }))
    return
  }
  toast.warning(t('bulk.partial', { ok, failed, total: ok + failed }))
}
