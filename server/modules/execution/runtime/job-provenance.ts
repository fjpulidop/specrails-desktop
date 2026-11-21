// Code-Explorer provenance recording at job settle (shared by the one-shot exit
// and interactive settle paths). Ordering invariant: the settle diff claims the
// worktree's capture slot synchronously, so the next job's pre-spawn snapshot of
// the same tree waits until this diff has read it (finish diff before the next
// snapshot).
import type { WsMessage } from '../../../types'
import type { DbInstance } from '../../../db'
import { isCodeExplorerEnabled } from '../../../feature-flags'
import {
  captureProvenance,
  recordProvenanceForJob,
  broadcastProvenanceUpdated,
  type WorkingTreeSnapshot,
} from '../../code/runtime/file-provenance'
import { extractTicketIdsFromCommand } from '../../specs/runtime/ticket-store'

export interface JobProvenanceHost {
  db: DbInstance | null
  projectId: string | null
  /** False once the manager was disposed or its connection swapped/closed. */
  isCurrent(db: DbInstance): boolean
  broadcast: (msg: WsMessage) => void
  /** Tracks in-flight captures for tests/shutdown (`whenProvenanceSettled`). */
  pending: Set<Promise<void>>
}

/**
 * Diffs the REPO working tree against the pre-spawn snapshot and inserts one
 * `file_provenance` row per touched path, broadcasting each. Gated by
 * SPECRAILS_CODE_EXPLORER (re-checked at each completion so the flag can be
 * flipped off mid-session without leaving partial writes). Best-effort.
 *
 * The git capture is async: this call claims the worktree's capture slot
 * synchronously (before the settle path drains the queue), so the next
 * job's pre-spawn snapshot of the same tree — and therefore its spawn —
 * waits until this diff has read the tree. Rows are written when the
 * capture resolves; the returned promise is tracked for tests/shutdown.
 */
export function recordJobProvenance(
  host: JobProvenanceHost,
  jobId: string,
  command: string,
  provenanceRepoDir: string | undefined,
  snapshot: WorkingTreeSnapshot | undefined,
): void {
  if (!isCodeExplorerEnabled() || !provenanceRepoDir || !host.projectId || !host.db) return
  const db = host.db
  const projectId = host.projectId
  const ticketIds = extractTicketIdsFromCommand(command)
  const capture = captureProvenance(provenanceRepoDir, snapshot ?? { ref: '', untracked: [], headSha: '' })
  const pending = capture.then(({ diff, patches }) => {
    // A disposed manager (or swapped/closed DB) drops the late write.
    if (!host.isCurrent(db)) return
    try {
      if (diff.length > 50) {
        console.warn(`[provenance.large_job] job=${jobId} files=${diff.length}`)
      }
      const rows = recordProvenanceForJob(
        db,
        projectId,
        jobId,
        ticketIds[0] ?? null,
        diff,
        Date.now(),
        patches,
      )
      for (const row of rows) {
        broadcastProvenanceUpdated(host.broadcast, projectId, row)
      }
    } catch (err) {
      console.warn(`[queue-manager] provenance recording failed: ${(err as Error).message}`)
    }
  })
  host.pending.add(pending)
  void pending.finally(() => host.pending.delete(pending))
}
