import type { DbInstance } from '../../../db'
import { getLinkByIssueId, listOutbox } from '../../../jira/jira-db'
import { listActivePrDeliveries, readSpecSnapshot, type RailPrDeliveryRow } from '../../delivery/runtime/rail-pr-store'
import { inboxItemId, oneLine, toIso, type InboxItem } from '../domain'
import type { ProjectInboxSource } from '../ports'

/** Finished runs older than this are history, not something that waits for the person. */
export const FAILED_RUN_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
const MAX_DEAD_JIRA_OPS = 20

export interface InboxProjectHandle {
  project: { id: string; name: string }
  db: DbInstance
}

interface RunRow {
  id: string
  loop_name: string | null
  status: 'paused' | 'completed'
  final_outcome: string | null
  restart_reason: string | null
  started_at: string
  finished_at: string | null
  ticket_ids_json: string | null
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function deliveryTitle(row: RailPrDeliveryRow): string {
  const specs = readSpecSnapshot(row.spec_snapshot) ?? []
  const first = specs.find((s) => s.title)?.title
  if (first) return specs.length > 1 ? `${first} +${specs.length - 1}` : first
  return row.loop_name || row.rail_key
}

function ticketLabel(raw: string | null): string {
  const ids = parseJsonArray(raw).filter((v): v is number => typeof v === 'number')
  if (ids.length === 0) return ''
  return ` · ${ids.slice(0, 3).map((id) => `#${id}`).join(', ')}${ids.length > 3 ? ` +${ids.length - 3}` : ''}`
}

/** Deliveries that wait for a decision or ended badly, mirroring the client's `deliveryAttention`. */
function deliveryItems(handle: InboxProjectHandle, rows: RailPrDeliveryRow[], nowIso: string): InboxItem[] {
  const out: InboxItem[] = []
  for (const row of rows) {
    const decision = row.decision
    const changesRequested = decision === 'implementation_failed' && row.status_code === 'review_changes_requested'
    const waiting = decision === 'on_review' || decision === 'pr_draft' || decision === 'pr_ready' || changesRequested
    const failed = !changesRequested && (decision === 'implementation_failed' || decision === 'pr_failed')
    if (!waiting && !failed) continue
    const kind = waiting ? 'review' : 'failed'
    out.push({
      id: inboxItemId(handle.project.id, kind, row.id),
      projectId: handle.project.id,
      projectName: handle.project.name,
      kind,
      title: deliveryTitle(row),
      detail: oneLine(row.status_detail) ?? (failed ? row.status_code : null),
      at: toIso((waiting ? row.on_review_at : null) ?? row.updated_at, nowIso),
      version: `${decision}:${row.status_code ?? ''}:${row.pr_state}`,
      action: 'open-review',
      subjectId: row.id,
      conversationId: row.origin_conversation_id,
    })
  }
  return out
}

/**
 * Runs that stopped on something the person must resolve: paused on a budget or
 * a human decision, interrupted by a restart, blocked, or ended badly (and not
 * superseded by a later run of the same loop on the same rail). Runs a
 * delivery already represents are left to the delivery.
 */
function runItems(handle: InboxProjectHandle, representedRunIds: ReadonlySet<string>, nowIso: string, nowMs: number): InboxItem[] {
  const since = new Date(nowMs - FAILED_RUN_WINDOW_MS).toISOString()
  const rows = handle.db.prepare(`
    SELECT r.id, r.loop_name, r.status, r.final_outcome, r.restart_reason, r.started_at, r.finished_at, r.ticket_ids_json
    FROM loop_runs r
    WHERE r.project_id = ?
      AND NOT EXISTS (SELECT 1 FROM definition_fork_operations f WHERE f.source_run_id = r.id AND f.adopted = 1)
      AND (
        (r.status = 'paused' AND COALESCE(r.restart_reason, '') != 'fork')
        OR (r.status = 'completed' AND r.final_outcome IN ('failed','blocked','stalled') AND r.finished_at >= ?
            AND NOT EXISTS (
              SELECT 1 FROM loop_runs n
              WHERE n.project_id = r.project_id AND n.loop_id = r.loop_id
                AND COALESCE(n.rail_index, -1) = COALESCE(r.rail_index, -1)
                AND n.started_at > r.started_at))
      )
    ORDER BY r.started_at DESC
    LIMIT 100
  `).all(handle.project.id, since) as RunRow[]
  const out: InboxItem[] = []
  for (const run of rows) {
    if (representedRunIds.has(run.id)) continue
    const title = `${run.loop_name || 'Run'}${ticketLabel(run.ticket_ids_json)}`
    const version = `${run.status}:${run.final_outcome ?? ''}:${run.restart_reason ?? ''}`
    const base = {
      projectId: handle.project.id,
      projectName: handle.project.name,
      title,
      version,
      subjectId: run.id,
      conversationId: null,
    }
    if (run.status === 'paused') {
      if (run.restart_reason === 'budget_paused') {
        out.push({ ...base, id: inboxItemId(handle.project.id, 'budget', run.id), kind: 'budget', detail: null, at: toIso(run.started_at, nowIso), action: 'resume-run' })
      } else if (run.restart_reason === 'restart') {
        out.push({ ...base, id: inboxItemId(handle.project.id, 'blocked', run.id), kind: 'blocked', detail: 'interrupted', at: toIso(run.started_at, nowIso), action: 'resume-run' })
      } else {
        out.push({ ...base, id: inboxItemId(handle.project.id, 'question', run.id), kind: 'question', detail: null, at: toIso(run.started_at, nowIso), action: 'open-run' })
      }
      continue
    }
    const kind = run.final_outcome === 'blocked' ? 'blocked' : 'failed'
    out.push({ ...base, id: inboxItemId(handle.project.id, kind, run.id), kind, detail: run.final_outcome, at: toIso(run.finished_at, nowIso), action: 'open-run' })
  }
  return out
}

function jiraItems(handle: InboxProjectHandle, nowIso: string): InboxItem[] {
  return listOutbox(handle.db, { state: 'dead', limit: MAX_DEAD_JIRA_OPS }).map((op) => {
    const key = getLinkByIssueId(handle.db, op.jiraIssueId)?.jiraKey ?? op.jiraIssueId
    return {
      id: inboxItemId(handle.project.id, 'jira', String(op.id)),
      projectId: handle.project.id,
      projectName: handle.project.name,
      kind: 'jira' as const,
      title: `${key} · ${op.opType}`,
      detail: oneLine(op.deadReason ?? op.lastError),
      at: toIso(op.updatedAt, nowIso),
      version: `dead:${op.attempts}:${op.updatedAt}`,
      action: 'retry-jira' as const,
      subjectId: String(op.id),
      conversationId: null,
    }
  })
}

/** Run ids that recent deliveries already account for (the delivery speaks for them). */
function representedRuns(db: DbInstance): Set<string> {
  const ids = new Set<string>()
  const rows = db.prepare(`SELECT run_ids FROM rail_pr_deliveries WHERE run_ids != '[]' ORDER BY created_at DESC LIMIT 500`).all() as Array<{ run_ids: string }>
  for (const row of rows) for (const id of parseJsonArray(row.run_ids)) if (typeof id === 'string') ids.add(id)
  return ids
}

/**
 * Bind the inbox sources to ONE project's own database. Each source is
 * isolated: a missing table or a corrupt row costs that source, not the rest.
 */
export function createProjectInboxSource(handle: InboxProjectHandle, now: () => number = Date.now): ProjectInboxSource {
  return {
    projectId: handle.project.id,
    projectName: handle.project.name,
    collect() {
      const nowMs = now()
      const nowIso = new Date(nowMs).toISOString()
      const items: InboxItem[] = []
      const guard = (label: string, fn: () => InboxItem[]): void => {
        try { items.push(...fn()) } catch (err) { console.warn(`[inbox] ${handle.project.id} ${label} unavailable:`, err instanceof Error ? err.message : err) }
      }
      let represented = new Set<string>()
      guard('deliveries', () => deliveryItems(handle, listActivePrDeliveries(handle.db), nowIso))
      try { represented = representedRuns(handle.db) } catch { /* runs then show without a delivery link */ }
      guard('runs', () => runItems(handle, represented, nowIso, nowMs))
      guard('jira', () => jiraItems(handle, nowIso))
      return items
    },
  }
}
