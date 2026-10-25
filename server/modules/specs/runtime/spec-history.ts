/**
 * Spec lifecycle: the read side. Collects everything the project database and
 * the ticket know about ONE spec and projects it into timeline entries plus
 * the raw facts the hand-off export needs. Read-only; nothing here writes, and
 * nothing outlives the call (no cache), so one project can never see another's
 * rows: the caller passes that project's own connection.
 *
 * Sources: the ticket itself (created / last edited / comments / addenda), the
 * AI invocation ledger (missions and AI edits that touched the spec, plus every
 * job or loop run attributed to it), loop runs and jobs with their phases and
 * failure diagnosis, the agent actions audit, PR deliveries and the reviewer's
 * settle evidence (verdict, findings and where they apply).
 *
 * The ticket store keeps no revision history, so a plain edit of the description
 * is known only as "last edited at": the timeline never invents what changed.
 */
import type { DbInstance } from '../../../db'
import { readSettleEvidence, type DeliveryRuntimeEvidence } from '../../delivery/runtime/delivery-evidence'
import { readJobDiagnosis } from '../../recovery/adapters/sqlite'
import { redactProse } from '../../audit'
import { readSpecAddenda } from './spec-addenda-core'
import type { Ticket } from './ticket-store'
import {
  foldCost,
  formatLocation,
  oneLine,
  sortTimeline,
  utc,
  TIMELINE_MAX_ITEMS,
  type CostRow,
  type TimelineActor,
  type TimelineEntry,
  type TimelineSubItem,
  type TimelineTone,
} from '../domain/timeline'

/** Hard bounds so a pathological history cannot blow up one request. */
const MAX_INVOCATIONS = 2000
const MAX_RUNS = 200
const MAX_DELIVERIES = 50

export interface InvocationFact {
  id: string
  surface: string
  refId: string | null
  conversationId: string | null
  loopRunId: string | null
  provider: string | null
  model: string | null
  status: string
  startedAt: string
  costUsd: number | null
  estimated: boolean
  turns: number | null
}

export interface DeliveryFact {
  id: string
  loopName: string
  decision: string
  statusCode: string | null
  statusDetail: string | null
  branch: string | null
  baseBranch: string
  prUrl: string | null
  prNumber: number | null
  prState: string
  originConversationId: string | null
  createdAt: string
  onReviewAt: string | null
  publishedAt: string | null
  mergedAt: string | null
  decidedAt: string | null
  updatedAt: string
  ticketIds: number[]
  /** Reviewer evidence for THIS spec, when settle harvested any. */
  review: ReviewFact | null
}

export interface ReviewFact {
  harvestedAt: string
  approved: boolean | null
  score: number | null
  summary: string | null
  issues: string[]
  findings: Array<{ text: string; location: string | null }>
  sentinel: string | null
  sentinelDetail: string | null
}

export interface SpecHistory {
  entries: TimelineEntry[]
  invocations: InvocationFact[]
  deliveries: DeliveryFact[]
  /** Ids of the jobs / runs attributed to the spec. */
  runIds: string[]
}

interface RunRow {
  id: string
  loop_name: string | null
  provider: string | null
  model: string | null
  status: string
  final_outcome: string | null
  started_at: string
  finished_at: string | null
  source: 'run' | 'job'
  command: string | null
}

const SPEC_AI_SURFACES = new Set(['ai-edit', 'quick-spec', 'smash', 'triage', 'spec-launcher'])
const MISSION_SURFACES = new Set(['explore-spec', 'chat-sidebar', 'flow'])

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

/** `job-1#t7` and `job-1:merge:step` rows belong to job `job-1`. */
export function baseRunId(refId: string | null): string | null {
  if (!refId) return null
  return refId.replace(/#t\d+$/, '').replace(/:merge:.*$/, '') || null
}

export function actorOf(createdBy: string | null | undefined, provider: string | null = null): TimelineActor {
  const by = (createdBy ?? '').trim()
  if (by === 'mcp') return { type: 'mcp', label: 'mcp', provider }
  if (by === 'user' || by === 'manual' || by === '') return { type: 'user', label: 'user', provider: null }
  if (by === 'agent' || by.startsWith('sr') || by.startsWith('specrails')) return { type: 'agent', label: by.replace(/^(?:specrails:|sr:|sr-)/, '') || 'agent', provider }
  return { type: 'system', label: by, provider }
}

/** Markdown to plain prose, so a summary never shows `**Tracker:**` or `## Heading` literally. */
function plain(text: string | null | undefined): string | null | undefined {
  if (typeof text !== 'string') return text
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*[-*#>]+\s*/gm, '')
    .replace(/\s+/g, ' ')
}

function clean(text: string | null | undefined, max = 240): string | null {
  const flat = oneLine(plain(text), max)
  return flat === null ? null : redactProse(flat)
}

function runTone(status: string, outcome: string | null): TimelineTone {
  if (status === 'running' || status === 'queued' || status === 'paused') return 'neutral'
  if (outcome === 'failed' || outcome === 'blocked' || outcome === 'stalled' || status === 'failed' || status === 'canceled' || status === 'aborted') return 'failure'
  return 'ok'
}

export function collectSpecHistory(db: DbInstance, ticket: Pick<Ticket, 'id' | 'title' | 'description' | 'status' | 'created_at' | 'updated_at' | 'created_by' | 'source' | 'origin_conversation_id' | 'comments' | 'addenda'>): SpecHistory {
  const ticketId = ticket.id
  const entries: TimelineEntry[] = []
  const specLink = { place: 'spec', id: String(ticketId) } as const

  // ─── Ticket: creation, last edit, comments ────────────────────────────────
  entries.push({
    id: 'spec:created', at: utc(ticket.created_at), kind: 'spec_edit', event: 'spec.created',
    params: { source: ticket.source }, title: 'Spec created', summary: clean(ticket.title),
    actor: actorOf(ticket.created_by), tone: 'neutral', provider: null,
    link: ticket.origin_conversation_id ? { place: 'mission', id: ticket.origin_conversation_id } : specLink,
  })
  const updatedMs = Date.parse(utc(ticket.updated_at))
  if (Number.isFinite(updatedMs) && updatedMs - Date.parse(utc(ticket.created_at)) > 1000) {
    entries.push({
      id: 'spec:updated', at: utc(ticket.updated_at), kind: 'spec_edit', event: 'spec.updated',
      params: { status: ticket.status }, title: 'Spec last edited', summary: null,
      actor: null, tone: 'neutral', provider: null, link: specLink,
    })
  }
  for (const comment of ticket.comments ?? []) {
    entries.push({
      id: `spec:comment:${comment.id}`, at: utc(comment.created_at), kind: 'spec_edit', event: 'spec.comment',
      params: {}, title: 'Comment', summary: clean(comment.body, 400), actor: actorOf(comment.created_by),
      tone: 'neutral', provider: null, link: specLink,
    })
  }

  // ─── Addenda ───────────────────────────────────────────────────────────────
  for (const addendum of readSpecAddenda(ticket.addenda)) {
    entries.push({
      id: `addendum:${addendum.id}:created`, at: utc(addendum.created_at), kind: 'addendum', event: 'addendum.created',
      params: { addendumKind: addendum.kind }, title: clean(addendum.title, 200) ?? addendum.kind,
      summary: clean(addendum.body, 400), actor: actorOf(addendum.created_by), tone: 'neutral', provider: null,
      link: addendum.origin_conversation_id ? { place: 'mission', id: addendum.origin_conversation_id } : specLink,
    })
    if (addendum.status !== 'open') {
      entries.push({
        id: `addendum:${addendum.id}:${addendum.status}`, at: utc(addendum.applied_at ?? addendum.updated_at), kind: 'addendum',
        event: `addendum.${addendum.status}`, params: { addendumKind: addendum.kind }, title: clean(addendum.title, 200) ?? addendum.kind,
        summary: null, actor: null, tone: addendum.status === 'applied' ? 'ok' : 'neutral', provider: null,
        link: addendum.run_id ? { place: 'job', id: addendum.run_id } : specLink,
      })
    }
  }

  // ─── Invocation ledger: the spine for cost, missions, AI edits and runs ───
  const invocationRows = db.prepare(`
    SELECT id, surface, surface_ref_id, conversation_id, loop_run_id, provider, model, status, started_at,
           total_cost_usd, total_cost_usd_estimated, num_turns
    FROM ai_invocations WHERE ticket_id = ? ORDER BY started_at DESC LIMIT ${MAX_INVOCATIONS}
  `).all(ticketId) as Array<{
    id: string; surface: string; surface_ref_id: string | null; conversation_id: string | null; loop_run_id: string | null
    provider: string | null; model: string | null; status: string; started_at: string
    total_cost_usd: number | null; total_cost_usd_estimated: number; num_turns: number | null
  }>
  const invocations: InvocationFact[] = invocationRows.map((row) => ({
    id: row.id, surface: row.surface, refId: row.surface_ref_id, conversationId: row.conversation_id, loopRunId: row.loop_run_id,
    provider: row.provider, model: row.model, status: row.status, startedAt: utc(row.started_at),
    costUsd: row.total_cost_usd, estimated: row.total_cost_usd_estimated === 1, turns: row.num_turns,
  }))
  const costOf = (rows: readonly InvocationFact[]) => foldCost(rows.map((r): CostRow => ({ provider: r.provider, costUsd: r.costUsd, estimated: r.estimated, turns: r.turns })))
  const providerOf = (rows: readonly InvocationFact[]): string | null => {
    const set = new Set(rows.map((r) => r.provider).filter((p): p is string => !!p))
    return set.size === 1 ? [...set][0]! : null
  }

  // AI edits and generation touching the spec: one entry each (low volume).
  for (const inv of invocations) {
    if (!SPEC_AI_SURFACES.has(inv.surface)) continue
    const cost = costOf([inv])
    entries.push({
      id: `ai:${inv.id}`, at: inv.startedAt, kind: 'spec_edit', event: `spec.ai.${inv.surface}`,
      params: { surface: inv.surface, status: inv.status }, title: `AI ${inv.surface}`, summary: null,
      actor: { type: 'agent', label: inv.surface, provider: inv.provider }, tone: inv.status === 'failed' ? 'failure' : 'neutral',
      provider: inv.provider, ...cost, link: specLink,
    })
  }

  // Mission turns: grouped per conversation.
  const byConversation = new Map<string, InvocationFact[]>()
  for (const inv of invocations) {
    if (!inv.conversationId || !MISSION_SURFACES.has(inv.surface)) continue
    const list = byConversation.get(inv.conversationId) ?? []
    list.push(inv)
    byConversation.set(inv.conversationId, list)
  }
  const conversationIds = [...byConversation.keys()]
  const titles = new Map<string, string | null>()
  for (const ids of chunk(conversationIds, 500)) {
    const rows = db.prepare(`SELECT id, title FROM chat_conversations WHERE id IN (${placeholders(ids.length)})`).all(...ids) as Array<{ id: string; title: string | null }>
    for (const row of rows) titles.set(row.id, row.title)
  }
  for (const [conversationId, rows] of byConversation) {
    if (!titles.has(conversationId)) continue // conversation was deleted: nothing to link to, nothing to show
    const sorted = [...rows].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    const items: TimelineSubItem[] = sorted.slice(0, TIMELINE_MAX_ITEMS).map((inv) => ({
      at: inv.startedAt, label: inv.surface, detail: inv.model, ...(inv.status === 'failed' ? { tone: 'failure' as const } : {}),
    }))
    entries.push({
      id: `mission:${conversationId}`, at: sorted[0]!.startedAt, kind: 'mission_turn', event: 'mission.turns',
      params: { turns: rows.length }, title: clean(titles.get(conversationId) ?? null, 160) ?? 'Mission', summary: null,
      actor: { type: 'agent', label: 'mission', provider: providerOf(rows) }, tone: 'neutral', provider: providerOf(rows),
      ...costOf(rows), link: { place: 'mission', id: conversationId }, count: rows.length, items,
    })
  }

  // ─── Deliveries (needed to find runs too) ─────────────────────────────────
  const deliveryRows = db.prepare(`
    SELECT * FROM rail_pr_deliveries
    WHERE parent_delivery_id IS NULL
      AND EXISTS (SELECT 1 FROM json_each(rail_pr_deliveries.ticket_ids) WHERE value = ?)
    ORDER BY created_at DESC LIMIT ${MAX_DELIVERIES}
  `).all(ticketId) as Array<Record<string, unknown>>
  const deliveries: DeliveryFact[] = deliveryRows.map((row) => {
    const evidence = readSettleEvidence(row.settle_evidence as string | null)
    const unit = evidence?.units.find((u) => u.ticketId === ticketId) ?? null
    return {
      id: String(row.id), loopName: String(row.loop_name ?? ''), decision: String(row.decision), statusCode: (row.status_code as string | null) ?? null,
      statusDetail: (row.status_detail as string | null) ?? null, branch: (row.branch as string | null) ?? null, baseBranch: String(row.base_branch ?? ''),
      prUrl: (row.pr_url as string | null) ?? null, prNumber: (row.pr_number as number | null) ?? null, prState: String(row.pr_state ?? 'none'),
      originConversationId: (row.origin_conversation_id as string | null) ?? null, createdAt: utc(String(row.created_at)),
      onReviewAt: utc((row.on_review_at as string | null) ?? null), publishedAt: utc((row.published_at as string | null) ?? null),
      mergedAt: utc((row.merged_at as string | null) ?? null), decidedAt: utc((row.decided_at as string | null) ?? null), updatedAt: utc(String(row.updated_at)),
      ticketIds: parseJson<number[]>(row.ticket_ids as string, []),
      review: unit && evidence ? reviewFact(unit.runtime ?? null, unit.sentinel, unit.sentinelDetail, utc(evidence.harvestedAt)) : null,
    }
  })
  const deliveryRunIds = deliveryRows.flatMap((row) => parseJson<unknown[]>(row.run_ids as string, []).filter((v): v is string => typeof v === 'string'))

  // ─── Runs and jobs ────────────────────────────────────────────────────────
  const runIdSet = new Set<string>()
  for (const inv of invocations) {
    if (inv.surface === 'job') { const id = baseRunId(inv.refId); if (id) runIdSet.add(id) }
    if (inv.loopRunId) runIdSet.add(inv.loopRunId)
  }
  for (const id of deliveryRunIds) runIdSet.add(id)
  const loopRunMatches = db.prepare(`
    SELECT id FROM loop_runs
    WHERE ticket_id = ? OR EXISTS (SELECT 1 FROM json_each(COALESCE(loop_runs.ticket_ids_json, '[]')) WHERE value = ?)
    ORDER BY started_at DESC LIMIT ${MAX_RUNS}
  `).all(ticketId, ticketId) as Array<{ id: string }>
  for (const row of loopRunMatches) runIdSet.add(row.id)

  const runs: RunRow[] = []
  for (const ids of chunk([...runIdSet], 400)) {
    const marks = placeholders(ids.length)
    const loopRows = db.prepare(`SELECT id, loop_name, provider, model, status, final_outcome, started_at, finished_at FROM loop_runs WHERE id IN (${marks})`).all(...ids) as Array<Omit<RunRow, 'source' | 'command'>>
    for (const row of loopRows) runs.push({ ...row, started_at: utc(row.started_at), finished_at: utc(row.finished_at), source: 'run', command: null })
    const seen = new Set(loopRows.map((r) => r.id))
    const rest = ids.filter((id) => !seen.has(id))
    if (rest.length > 0) {
      const jobRows = db.prepare(`SELECT id, command, provider, model, status, started_at, finished_at FROM jobs WHERE id IN (${placeholders(rest.length)})`).all(...rest) as Array<{ id: string; command: string; provider: string | null; model: string | null; status: string; started_at: string; finished_at: string | null }>
      for (const row of jobRows) runs.push({ id: row.id, loop_name: null, provider: row.provider, model: row.model, status: row.status, final_outcome: null, started_at: utc(row.started_at), finished_at: utc(row.finished_at), source: 'job', command: row.command })
    }
  }
  runs.sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
  const shownRuns = runs.slice(0, MAX_RUNS)
  const runIds = shownRuns.map((r) => r.id)

  const invocationsOfRun = (id: string) => invocations.filter((inv) => baseRunId(inv.refId) === id || inv.loopRunId === id)
  for (const run of shownRuns) {
    const mine = invocationsOfRun(run.id)
    const tone = runTone(run.status, run.final_outcome)
    const diagnosis = tone === 'failure' ? safeDiagnosis(db, run.id, run.status) : null
    const duration = run.finished_at ? Math.max(0, Date.parse(run.finished_at) - Date.parse(run.started_at)) : null
    entries.push({
      id: `job:${run.id}`, at: run.started_at, kind: 'job', event: 'job.run',
      params: { status: run.status, outcome: run.final_outcome, durationMs: Number.isFinite(duration as number) ? duration : null, failureKind: diagnosis?.kind ?? null },
      title: clean(run.loop_name ?? run.command ?? run.id, 160) ?? run.id,
      summary: clean(diagnosis?.detail ?? null),
      actor: { type: 'agent', label: run.loop_name ? 'loop' : 'job', provider: run.provider ?? providerOf(mine) },
      tone, provider: run.provider ?? providerOf(mine), ...costOf(mine), link: { place: 'job', id: run.id },
    })
  }

  // Phases: grouped per job.
  if (runIds.length > 0) {
    const phaseRows: Array<{ job_id: string; phase: string; state: string; updated_at: string }> = []
    for (const ids of chunk(runIds, 400)) {
      phaseRows.push(...db.prepare(`SELECT job_id, phase, state, updated_at FROM job_phases WHERE job_id IN (${placeholders(ids.length)})`).all(...ids) as typeof phaseRows)
    }
    const byJob = new Map<string, typeof phaseRows>()
    for (const row of phaseRows) { const l = byJob.get(row.job_id) ?? []; l.push(row); byJob.set(row.job_id, l) }
    for (const [jobId, rows] of byJob) {
      rows.sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1))
      const failed = rows.filter((r) => r.state === 'failed' || r.state === 'error').length
      entries.push({
        id: `phases:${jobId}`, at: utc(rows[rows.length - 1]!.updated_at), kind: 'phase', event: 'phase.group',
        params: { count: rows.length, failed }, title: `${rows.length} phases`, summary: clean(rows.map((r) => r.phase).join(' → '), 200),
        actor: null, tone: failed > 0 ? 'failure' : 'neutral', provider: null, link: { place: 'job', id: jobId }, count: rows.length,
        items: rows.slice(0, TIMELINE_MAX_ITEMS).map((r) => ({ at: utc(r.updated_at), label: r.phase, detail: r.state, ...(r.state === 'failed' || r.state === 'error' ? { tone: 'failure' as const } : {}) })),
      })
    }

    // Agent actions audit: grouped per run.
    const actionRows: Array<{ run_id: string; job_id: string | null; role: string; kind: string; target: string; ts: string }> = []
    for (const ids of chunk(runIds, 200)) {
      const marks = placeholders(ids.length)
      actionRows.push(...db.prepare(`SELECT run_id, job_id, role, kind, target, ts FROM agent_actions WHERE run_id IN (${marks}) OR job_id IN (${marks}) ORDER BY ts DESC LIMIT 5000`).all(...ids, ...ids) as typeof actionRows)
    }
    const known = new Set(runIds)
    const byRun = new Map<string, typeof actionRows>()
    for (const row of actionRows) {
      const key = known.has(row.run_id) ? row.run_id : row.job_id && known.has(row.job_id) ? row.job_id : null
      if (!key) continue
      const l = byRun.get(key) ?? []
      l.push(row)
      byRun.set(key, l)
    }
    for (const [runId, rows] of byRun) {
      const counts: Record<string, number> = { read: 0, write: 0, exec: 0, mcp: 0, network: 0 }
      for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1
      // Reads dominate and say little: details lead with what changed or ran.
      const notable = rows.filter((r) => r.kind !== 'read')
      const roles = [...new Set(rows.map((r) => r.role))]
      entries.push({
        id: `audit:${runId}`, at: utc(rows.reduce((max, r) => (r.ts > max ? r.ts : max), rows[0]!.ts)), kind: 'audit', event: 'audit.group',
        params: { count: rows.length, ...counts }, title: `${rows.length} agent actions`, summary: null,
        actor: roles.length === 1 ? { type: 'agent', label: roles[0]!, provider: null } : null, tone: 'neutral', provider: null,
        link: { place: 'job', id: runId }, count: rows.length,
        items: notable.slice(0, TIMELINE_MAX_ITEMS).map((r) => ({ at: utc(r.ts), label: r.kind, detail: clean(r.target, 200), })),
      })
    }
  }

  // ─── PR events and review ─────────────────────────────────────────────────
  for (const d of deliveries) {
    const link = { place: 'review', id: d.id } as const
    const failed = d.decision === 'implementation_failed' || d.decision === 'pr_failed'
    entries.push({
      id: `pr:${d.id}:created`, at: d.createdAt, kind: 'pr_event', event: 'pr.delivery_started', params: { loop: d.loopName },
      title: 'Delivery started', summary: clean(d.loopName), actor: null, tone: 'neutral', provider: null, link,
    })
    if (d.onReviewAt) {
      entries.push({ id: `pr:${d.id}:review`, at: d.onReviewAt, kind: 'pr_event', event: 'pr.ready_for_review', params: {}, title: 'Ready for review', summary: null, actor: null, tone: 'review', provider: null, link })
    }
    if (d.publishedAt) {
      entries.push({
        id: `pr:${d.id}:published`, at: d.publishedAt, kind: 'pr_event', event: 'pr.published', params: { prNumber: d.prNumber },
        title: d.prNumber ? `PR #${d.prNumber}` : 'PR published', summary: clean(d.branch), actor: null, tone: 'ok', provider: null, link, url: d.prUrl,
      })
    }
    if (d.mergedAt) {
      entries.push({ id: `pr:${d.id}:merged`, at: d.mergedAt, kind: 'pr_event', event: 'pr.merged', params: { prNumber: d.prNumber }, title: 'Merged', summary: null, actor: null, tone: 'ok', provider: null, link, url: d.prUrl })
    } else if (d.decidedAt && (failed || d.decision === 'discarded' || d.decision === 'superseded')) {
      entries.push({
        id: `pr:${d.id}:closed`, at: d.decidedAt, kind: 'pr_event', event: `pr.${failed ? 'failed' : d.decision}`, params: { decision: d.decision },
        title: failed ? 'Delivery failed' : d.decision, summary: clean(d.statusDetail), actor: null, tone: failed ? 'failure' : 'neutral', provider: null, link,
      })
    }
    if (d.review) {
      const r = d.review
      const verdict = r.approved === true ? 'approved' : r.approved === false ? 'changes_requested' : r.sentinel === 'fail' ? 'failed' : 'recorded'
      entries.push({
        id: `review:${d.id}`, at: r.harvestedAt, kind: 'review', event: 'review.verdict',
        params: { verdict, findings: r.findings.length, score: r.score },
        title: `Review: ${verdict}`, summary: clean(r.summary ?? r.sentinelDetail, 400),
        actor: { type: 'agent', label: 'reviewer', provider: null }, tone: r.approved === true && r.findings.length === 0 ? 'ok' : 'review', provider: null,
        link, count: r.findings.length || undefined,
        items: r.findings.slice(0, TIMELINE_MAX_ITEMS).map((f) => ({ at: null, label: f.text, detail: f.location, tone: 'review' as const })),
      })
    }
  }

  return { entries: sortTimeline(entries), invocations, deliveries, runIds }
}

function safeDiagnosis(db: DbInstance, runId: string, status: string): { kind: string; detail: string | null } | null {
  try {
    const d = readJobDiagnosis(db, runId, status)
    return d ? { kind: d.kind, detail: d.detail } : null
  } catch {
    return null
  }
}

function reviewFact(runtime: DeliveryRuntimeEvidence | null, sentinel: string, sentinelDetail: string | null, harvestedAt: string): ReviewFact | null {
  const findingTexts = runtime?.findings ?? []
  const locations = new Map<number, string>()
  for (const loc of runtime?.findingLocations ?? []) {
    if (!locations.has(loc.finding)) { const text = formatLocation(loc); if (text) locations.set(loc.finding, text) }
  }
  const issues = runtime?.review?.issues ?? []
  const hasSignal = runtime?.review || findingTexts.length > 0 || sentinel !== 'absent'
  if (!hasSignal) return null
  return {
    harvestedAt,
    approved: runtime?.review?.approved ?? null,
    score: runtime?.review?.score ?? null,
    summary: runtime?.review?.summary ?? null,
    issues: issues.map((i) => redactProse(String(i))).slice(0, 20),
    findings: findingTexts.slice(0, 50).map((text, index) => ({ text: redactProse(oneLine(text, 300) ?? ''), location: locations.get(index) ?? null })),
    sentinel: sentinel === 'absent' ? null : sentinel,
    sentinelDetail: sentinelDetail ? redactProse(sentinelDetail) : null,
  }
}
