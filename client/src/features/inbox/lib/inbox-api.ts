import { API_ORIGIN } from '../../../lib/origin'
import { readInboxSnapshot, type InboxItem, type InboxSnapshot } from './inbox-model'
import { jiraApi } from '../../integrations/lib/jira-api'
import { readDailyBudgetRejection, type DailyBudgetInfo } from '../../../lib/daily-budget'
import type { RunCapChoice } from '../../../lib/run-cap'

/** Desktop-level read-model: every project, read through its own state. */
export async function fetchInbox(signal?: AbortSignal): Promise<InboxSnapshot> {
  const res = await fetch(`${API_ORIGIN}/api/inbox`, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return readInboxSnapshot(await res.json())
}

export type InboxActionOutcome =
  | { kind: 'ok' }
  | { kind: 'over-budget'; budget: DailyBudgetInfo }
  | { kind: 'failed'; detail: string }

const projectBase = (projectId: string): string => `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}`

/**
 * Resume a paused or interrupted run: the very route the run card's Resume
 * uses (`POST /loop-runs/:id/resume`), addressed to the ITEM's project (the
 * inbox is app-wide, never the active project).
 */
export async function resumeInboxRun(item: InboxItem, choice?: RunCapChoice): Promise<InboxActionOutcome> {
  try {
    const res = await fetch(`${projectBase(item.projectId)}/loop-runs/${encodeURIComponent(item.subjectId)}/resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(choice ?? {}),
    })
    if (res.ok) return { kind: 'ok' }
    const body: unknown = await res.json().catch(() => null)
    const budget = readDailyBudgetRejection(body)
    if (budget) return { kind: 'over-budget', budget }
    return { kind: 'failed', detail: (body as { error?: string } | null)?.error ?? `HTTP ${res.status}` }
  } catch (err) {
    return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) }
  }
}

/** Re-queue a dead-lettered Jira op: the Jira outbox panel's Retry. */
export async function retryInboxJira(item: InboxItem): Promise<InboxActionOutcome> {
  try {
    await jiraApi.retryOutbox(Number(item.subjectId), projectBase(item.projectId))
    return { kind: 'ok' }
  } catch (err) {
    return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) }
  }
}
