import type { DbInstance } from '../../../db'
import { getLinkByIssueId, listOutbox } from '../../../jira/jira-db'
import { listActivePrDeliveries, readSpecSnapshot, type RailPrDeliveryRow } from '../../delivery/runtime/rail-pr-store'
import { readRunDiagnosis } from '../../recovery/adapters/sqlite'
import { inboxItemId, oneLine, toIso, type InboxItem } from '../domain'
import type { ProjectInboxSource } from '../ports'
import type { PresentedFailureDiagnosis } from '../../recovery'
import type { CapStatus } from '../../execution'

/** Finished runs older than this are history, not something that waits for the person. */
export const FAILED_RUN_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
const MAX_DEAD_JIRA_OPS = 20

export interface InboxProjectHandle {
  project: { id: string; name: string }
  db: DbInstance
  /** Every configured spend cap this project answers for (its own, plus the
   *  app-wide ones when this project is the one that speaks for them). */
  caps?: () => CapStatus[]
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
  rail_index: number | null
  failure_diagnosis: string | null
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

/** Provider limits and environment problems wait for the person; they are not defects of the change. */
function needsHost(diagnosis: PresentedFailureDiagnosis | null): boolean {
  return diagnosis?.confidence === 'high' && (diagnosis.kind === 'provider_limit' || diagnosis.kind === 'environment')
}

function deliveryDiagnosis(handle: InboxProjectHandle, row: RailPrDeliveryRow): PresentedFailureDiagnosis | null {
  const runIds = parseJsonArray(row.run_ids).filter((v): v is string => typeof v === 'string')
  for (const runId of [...runIds].reverse()) {
    try { const diagnosis = readRunDiagnosis(handle.db, runId); if (diagnosis) return diagnosis } catch { /* the delivery still shows without a diagnosis */ }
  }
  return null
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
    // A failed delivery is explained by its last run's diagnosis.
    const diagnosis = failed ? deliveryDiagnosis(handle, row) : null
    const kind = waiting ? 'review' : needsHost(diagnosis) ? 'blocked' : 'failed'
    out.push({
      id: inboxItemId(handle.project.id, kind, row.id),
      projectId: handle.project.id,
      projectName: handle.project.name,
      kind,
      title: deliveryTitle(row),
      detail: oneLine(row.status_detail) ?? (failed ? oneLine(diagnosis?.detail) ?? row.status_code : null),
      diagnosis,
      at: toIso((waiting ? row.on_review_at : null) ?? row.updated_at, nowIso),
      version: `${decision}:${row.status_code ?? ''}:${row.pr_state}`,
      action: 'open-review',
      subjectId: row.id,
      conversationId: row.origin_conversation_id,
      decision,
      ...(Number.isInteger(row.rail_index) ? { railIndex: row.rail_index } : {}),
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
    SELECT r.id, r.loop_name, r.status, r.final_outcome, r.restart_reason, r.started_at, r.finished_at, r.ticket_ids_json, r.rail_index, r.failure_diagnosis
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
      diagnosis: null as PresentedFailureDiagnosis | null,
      ...(typeof run.rail_index === 'number' ? { railIndex: run.rail_index } : {}),
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
    const diagnosis = readRunDiagnosis(handle.db, run.id)
    const kind = run.final_outcome === 'blocked' || needsHost(diagnosis) ? 'blocked' : 'failed'
    // The version moves with the cause, so a run re-diagnosed differently comes back.
    out.push({
      ...base, id: inboxItemId(handle.project.id, kind, run.id), kind, diagnosis,
      version: `${version}:${diagnosis?.kind ?? ''}:${diagnosis?.confidence ?? ''}`,
      detail: oneLine(diagnosis?.detail) ?? run.final_outcome, at: toIso(run.finished_at, nowIso), action: 'open-run',
    })
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
      diagnosis: null,
    }
  })
}

/**
 * A spend cap that is reached right now (daily, weekly or monthly; project or
 * app-wide). The item stays while the cap is exhausted and leaves on its own
 * once it is raised or the period rolls over; its version includes both, so a
 * dismissal never hides the next period's crossing.
 */
function capItems(handle: InboxProjectHandle, nowIso: string): InboxItem[] {
  const caps = handle.caps?.() ?? []
  return caps.filter((cap) => cap.exhausted).map((cap) => ({
    id: inboxItemId(handle.project.id, 'budget', `cap-${cap.scope}-${cap.period}`),
    projectId: handle.project.id,
    projectName: handle.project.name,
    kind: 'budget' as const,
    title: `${cap.scope === 'project' ? 'Project' : 'App-wide'} ${cap.period === 'day' ? 'daily' : cap.period === 'week' ? 'weekly' : 'monthly'} budget reached`,
    detail: null,
    at: nowIso,
    version: `cap:${cap.budgetUsd}:${cap.resetsAt}`,
    action: 'raise-cap' as const,
    subjectId: `${cap.scope}:${cap.period}`,
    conversationId: null,
    diagnosis: null,
    cap: { scope: cap.scope, period: cap.period, budgetUsd: cap.budgetUsd, spentUsd: cap.spentUsd, resetsAt: cap.resetsAt },
  }))
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
      guard('caps', () => capItems(handle, nowIso))
      return items
    },
  }
}
