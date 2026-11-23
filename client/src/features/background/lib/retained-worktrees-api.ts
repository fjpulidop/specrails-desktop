import { API_ORIGIN } from '../../../lib/origin'
import { requestJson } from '../../../lib/api-response'

/** Why a retained worktree waits for the person (server `RetainedWorktreeReason`). */
export type RetainedWorktreeReason =
  | 'run-active' | 'intent-owned' | 'git-unknown' | 'uncommitted-changes' | 'ignored-files'
  | 'recently-active' | 'unpushed-commits' | 'branch-unknown' | 'open-delivery'

export interface RetainedWorktreeEvaluation {
  label: 'nothing-to-lose' | 'waiting-for-you'
  reasons: RetainedWorktreeReason[]
  removable: boolean
  removeBlocker: RetainedWorktreeReason | null
  branchDeletable: boolean
}

export interface RetainedWorktree {
  id: string
  kind: 'rail' | 'intent'
  projectId: string
  projectName: string
  railIndex: number | null
  ticketId: number | null
  ticketTitle: string | null
  runId: string | null
  branch: string | null
  worktreePath: string
  state: string
  pr: { url: string | null; number: number | null; decision: string; deliveryState: string } | null
  lastActivityAt: string | null
  idleDays: number | null
  head: string | null
  trackedChanges: number | null
  untrackedFiles: number | null
  ignoredAtRisk: string[]
  ignoredAtRiskCount: number | null
  unpushedCommits: number | null
  evaluation: RetainedWorktreeEvaluation
}

/** `GET /api/worktrees/retained`: retained run worktrees of every project. */
export interface RetainedWorktreesSnapshot {
  generatedAt: string
  projects: Array<{ projectId: string; projectName: string; error?: string }>
  items: RetainedWorktree[]
}

export type RetainedSize =
  | { status: 'scanning' }
  | { status: 'done'; bytes: number; scannedAt: number }
  | { status: 'failed'; scannedAt: number }

export interface RetainedItemRef { projectId: string; id: string }

export interface RetainedRemovalResult extends RetainedItemRef {
  status: 'removed' | 'kept' | 'not-found'
  /** A reason above, `changed` (HEAD moved since confirmation) or `release` (see warnings). */
  reason: string | null
  branchDeleted: boolean
  warnings: string[]
}

const BASE = `${API_ORIGIN}/api/worktrees/retained`

export async function getRetainedWorktrees(signal?: AbortSignal): Promise<RetainedWorktreesSnapshot> {
  const body = await requestJson<RetainedWorktreesSnapshot | null>(BASE, { signal })
  if (!body || !Array.isArray(body.items) || !Array.isArray(body.projects)) throw new Error('Invalid retained worktrees snapshot')
  return body
}

export async function getRetainedSizes(items: RetainedItemRef[], signal?: AbortSignal): Promise<Array<RetainedItemRef & { size: RetainedSize | null }>> {
  const body = await requestJson<{ items?: Array<RetainedItemRef & { size: RetainedSize | null }> } | null>(`${BASE}/sizes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }), signal,
  })
  return Array.isArray(body?.items) ? body!.items : []
}

export async function removeRetainedWorktrees(items: Array<RetainedItemRef & { head: string; deleteBranch: boolean }>): Promise<RetainedRemovalResult[]> {
  const body = await requestJson<{ results?: RetainedRemovalResult[] } | null>(`${BASE}/remove`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }),
  })
  return Array.isArray(body?.results) ? body!.results : []
}
