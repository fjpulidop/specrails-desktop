import type { DbInstance } from '../../../../db'
import { getPrDelivery, type RailPrDeliveryRow } from '../rail-pr-store'
import path from 'node:path'
import { PR_CI_LOOP_ID } from './pr-ci-target'
import { ciFixActiveRepositories, ciFixAllowed } from '../../domain/decision-policy'

/**
 * The optional "Watch and fix the PR's CI" offer (pr-ci-loop): a system row in
 * the mission conversation that launched the delivery. It never starts on its
 * own, carries no attention (no bell, no dot in the mission list) and is keyed
 * per delivery generation, so a dismissal holds for that generation only.
 *
 *   offered → started { runId } → green | no-ci | needs-attention { reason }
 *   offered → dismissed
 */
export type PrCiOfferState = 'offered' | 'started' | 'dismissed' | 'green' | 'no-ci' | 'needs-attention'
export interface PrCiOfferRow {
  kind: 'pr-ci-offer'
  projectId: string
  prDeliveryId: string
  prNumber: number | null
  prUrl: string
  /** Multi-repository generations: every watched PR, one per repository (the first is `prUrl`). */
  prs?: Array<{ repository: string; prNumber: number | null; prUrl: string }>
  railIndex: number
  state: PrCiOfferState
  /** The CI loop run (started and terminal states). */
  runId?: string
  /** The continuation generation the loop runs as. */
  runDeliveryId?: string
  /** needs-attention: why the loop stopped, in plain language. */
  reason?: string
  /** Terminal: commits the loop pushed to the PR. */
  pushes?: number
  /** Terminal: CI fix rounds the loop used. */
  rounds?: number
  at: string
}

export interface PrCiOfferHost {
  upsertSystemRow(conversationId: string, row: Record<string, unknown> & { kind: string }, dedupeKey: string): string | null
  getSystemRow(conversationId: string, dedupeKey: string): Record<string, unknown> | null
}

export const prCiOfferKey = (deliveryId: string): string => `pr-ci-offer:${deliveryId}`

type OfferRow = Pick<RailPrDeliveryRow, 'decision' | 'pr_url' | 'pr_number' | 'branch' | 'origin_conversation_id' | 'loop_id' | 'execution_manifest'>
type RepositoryRow = Pick<RailPrDeliveryRow, 'decision' | 'pr_url' | 'pr_number' | 'branch' | 'delivery_sha' | 'operation' | 'repository_path'>

/** Repository deliveries of a multi-repository generation (child rows), oldest first. */
export function readRepositoryDeliveries(db: DbInstance, parentId: string): RailPrDeliveryRow[] {
  return db.prepare('SELECT * FROM rail_pr_deliveries WHERE parent_delivery_id = ? ORDER BY rowid').all(parentId) as RailPrDeliveryRow[]
}

/** Pure: may this delivery generation be offered the CI loop? A multi-repository one needs every repository under review to have its PR. */
export function prCiOfferEligible(row: OfferRow, repositories: readonly RepositoryRow[] | null = null): boolean {
  if (row.decision !== 'pr_draft' && row.decision !== 'pr_ready') return false
  if (!row.origin_conversation_id || row.loop_id === PR_CI_LOOP_ID) return false
  if (!row.execution_manifest) return !!row.pr_url && !!row.branch
  return !!repositories && ciFixAllowed({ decision: row.decision, delivery_outcome: 'ready', implementation_outcome: 'succeeded', status_code: null, is_continuation: 0, pr_url: null, branch: null, operation: null, repositories })
}

/** The PRs an offer shows: the row's own, or one per repository still under review. */
export function offerPrs(row: OfferRow, repositories: readonly RepositoryRow[] | null): Array<{ repository: string; prNumber: number | null; prUrl: string }> {
  if (!row.execution_manifest) return row.pr_url ? [{ repository: '', prNumber: row.pr_number, prUrl: row.pr_url }] : []
  return ciFixActiveRepositories(repositories ?? []).filter(child => child.pr_url)
    .map(child => ({ repository: path.basename(child.repository_path ?? ''), prNumber: child.pr_number, prUrl: child.pr_url! }))
}

const TERMINAL: ReadonlySet<PrCiOfferState> = new Set(['green', 'no-ci', 'needs-attention'])

/** Host-task results the loop recorded (`host_task_finished` events), oldest first. */
export function readHostTaskOutcomes(db: DbInstance, runId: string): Array<{ task: string; outcome: string }> {
  try {
    const rows = db.prepare("SELECT payload FROM events WHERE job_id = ? AND event_type = 'host_task_finished' ORDER BY seq").all(runId) as Array<{ payload: string }>
    return rows.flatMap(row => {
      try {
        const value = JSON.parse(row.payload) as { task?: unknown; outcome?: unknown }
        return typeof value.task === 'string' && typeof value.outcome === 'string' ? [{ task: value.task, outcome: value.outcome }] : []
      } catch { return [] }
    })
  } catch { return [] }
}

/** Pure: the offer's terminal state from the CI loop generation's settled row and its host-task history. */
export function prCiTerminalState(row: Pick<RailPrDeliveryRow, 'decision' | 'implementation_outcome' | 'status_detail'>, outcomes: ReadonlyArray<{ task: string; outcome: string }>): Pick<PrCiOfferRow, 'state' | 'reason' | 'pushes' | 'rounds'> {
  const pushes = outcomes.filter(entry => entry.task === 'pr.sync' && entry.outcome === 'pushed').length
  const rounds = outcomes.filter(entry => entry.task === 'pr.checks' && entry.outcome === 'red').length
  const lastChecks = [...outcomes].reverse().find(entry => entry.task === 'pr.checks')?.outcome
  const succeeded = row.implementation_outcome === 'succeeded' && (row.decision === 'pr_draft' || row.decision === 'pr_ready' || row.decision === 'merged')
  if (succeeded && lastChecks === 'green') return { state: 'green', pushes, rounds }
  if (succeeded && lastChecks === 'none') return { state: 'no-ci', pushes, rounds }
  const reason = (row.status_detail ?? '').trim() || 'The CI loop stopped before the checks turned green.'
  return { state: 'needs-attention', reason: reason.slice(0, 600), pushes, rounds }
}

/**
 * Offer, or refresh, the CI loop for one delivery. Idempotent, never throws:
 *  - an eligible generation without a row gets `offered` (only with the capability);
 *  - a CI loop generation updates the row of the generation it replaced.
 */
export function projectPrCiOffer(db: DbInstance, projectId: string, host: PrCiOfferHost | null, deliveryId: string, options: { capable: boolean; now?: () => number }): void {
  if (!host) return
  try {
    const row = getPrDelivery(db, deliveryId)
    if (!row) return
    const at = new Date(options.now?.() ?? Date.now()).toISOString()
    if (row.loop_id === PR_CI_LOOP_ID) {
      const offered = row.supersedes_delivery_id ? getPrDelivery(db, row.supersedes_delivery_id) : undefined
      const conversationId = offered?.origin_conversation_id ?? row.origin_conversation_id
      if (!offered || !conversationId) return
      const key = prCiOfferKey(offered.id)
      const previous = host.getSystemRow(conversationId, key) as Partial<PrCiOfferRow> | null
      const runId = (() => { try { return (JSON.parse(row.run_ids) as unknown[]).find((id): id is string => typeof id === 'string') } catch { return undefined } })()
      const shown = offerPrs(offered, offered.execution_manifest ? readRepositoryDeliveries(db, offered.id) : null)
      const keep = previous && typeof previous.prUrl === 'string' ? { prUrl: previous.prUrl, prNumber: previous.prNumber ?? null, ...(previous.prs ? { prs: previous.prs } : {}) } : null
      const base: Omit<PrCiOfferRow, 'state' | 'at'> = { kind: 'pr-ci-offer', projectId, prDeliveryId: offered.id, railIndex: offered.rail_index,
        ...(keep ?? { prNumber: shown[0]?.prNumber ?? offered.pr_number, prUrl: shown[0]?.prUrl ?? offered.pr_url ?? row.pr_url ?? '', ...(shown.length > 1 ? { prs: shown } : {}) }),
        ...(runId ? { runId } : {}), runDeliveryId: row.id }
      const next: PrCiOfferRow = row.decision === 'building'
        ? { ...base, state: 'started', at }
        : { ...base, ...prCiTerminalState(row, runId ? readHostTaskOutcomes(db, runId) : []), at }
      if (previous?.state && TERMINAL.has(previous.state as PrCiOfferState) && previous.runDeliveryId === row.id && next.state === 'started') return
      host.upsertSystemRow(conversationId, { ...next }, key)
      return
    }
    const repositories = row.execution_manifest ? readRepositoryDeliveries(db, row.id) : null
    if (!options.capable || !prCiOfferEligible(row, repositories)) return
    const conversationId = row.origin_conversation_id!
    const key = prCiOfferKey(row.id)
    if (host.getSystemRow(conversationId, key)) return
    const prs = offerPrs(row, repositories)
    if (!prs.length) return
    const offer: PrCiOfferRow = { kind: 'pr-ci-offer', projectId, prDeliveryId: row.id, prNumber: prs[0].prNumber, prUrl: prs[0].prUrl, ...(prs.length > 1 ? { prs } : {}), railIndex: row.rail_index, state: 'offered', at }
    host.upsertSystemRow(conversationId, { ...offer }, key)
  } catch (error) {
    console.error(`[pr-ci] offer projection failed for ${deliveryId}:`, error)
  }
}

/** "Not now": persist the dismissal on the generation's row. Returns false when nothing was offered. */
export function dismissPrCiOffer(db: DbInstance, host: PrCiOfferHost | null, deliveryId: string, now: () => number = Date.now): boolean {
  const row = getPrDelivery(db, deliveryId)
  if (!host || !row?.origin_conversation_id) return false
  const key = prCiOfferKey(row.id)
  const previous = host.getSystemRow(row.origin_conversation_id, key) as Partial<PrCiOfferRow> | null
  if (!previous || previous.state !== 'offered') return false
  const { dedupeKey: _dedupeKey, ...rest } = previous as Record<string, unknown>
  host.upsertSystemRow(row.origin_conversation_id, { ...rest, kind: 'pr-ci-offer', state: 'dismissed', at: new Date(now()).toISOString() }, key)
  return true
}
