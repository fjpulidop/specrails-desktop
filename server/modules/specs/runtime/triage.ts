// Spec triage — effectful coordinator (launch-triage, feedback-2026-10 annex D.2).
//
// Deterministic inputs first (ticket text, repo map, files touched by similar
// tickets via file_provenance, available loops, Flow availability), hashed;
// then ONE cheap structured-output call on the triage engine. The record lands
// in `metadata.triage` of the ticket store and is announced as `ticket_updated`.
//
// Triggers: one per-project service observes the project's ticket broadcasts
// and schedules a debounced scan; only draft/todo specs whose content changed
// since the project opened are triaged automatically. `triageNow` serves the
// on-demand "Recalculate" (forced). One triage runs at a time per project.

import { createHash, randomUUID } from 'crypto'
import type { DbInstance } from '../../../db'
import type { ProjectRow } from '../../../desktop-db'
import type { LocalTicket, WsMessage } from '../../../types'
import { getAdapter, hasAdapter } from '../../../providers'
import { pureOutputToolPolicy } from '../../../providers/runtime'
import { derivePrimaryProvider, isProviderEnabled } from '../../../provider-selection'
import { buildRepoMap } from '../../../repo-map'
import { isLoopsEnabled, isSpecTriageAutoEnabled } from '../../../feature-flags'
import { recordInvocation } from '../../accounting/runtime/ai-invocations'
import { resolvePriceEntry } from '../../accounting/runtime/pricing'
import { loadLoopRoleEngines } from '../../loops/runtime/loop-role-engines'
import { FACTORY_LOOPS } from '../../loops/runtime/loop-factory'
import { listLoops } from '../../loops/runtime/loops-store'
import { loopNeedsTicket } from '../../loops/runtime/loop-graph'
import { getModelsForProvider, getProviderDefault, isValidModelForProvider } from './spec-models'
import { isFlowHeldTicket, mutateStore, readStore, type Ticket, type TicketStore } from './ticket-store'
import {
  TRIAGE_LIMITS, TRIAGE_PROMPT_VERSION, buildTriageSystemPrompt, buildTriageUserPrompt, canonicalJson,
  isTicketTriage, parseTriageOutput, rankFiles, similarTicketIds, triageContentSignature, triageTicketText,
  type TicketTriage, type TriageInputs, type TriageLoopOption, type TriageRepoMap,
} from '../domain/triage'
import { runTriageModel, TriageModelError, type TriageModelRunner, type TriageModelUsage } from './triage-runner'

export const TRIAGE_DEBOUNCE_MS = 2_000
const REPO_MAP_TTL_MS = 60_000
const AUTO_STATUSES = new Set(['draft', 'todo'])

type TriageProject = Pick<ProjectRow, 'id' | 'slug' | 'path' | 'provider' | 'providers'>

// ─── Engine ───────────────────────────────────────────────────────────────────

export interface TriageEngine { provider: string; model: string }
export type TriageEngineResolution = { ok: true; engine: TriageEngine } | { ok: false; reason: string }

/**
 * Cheapest catalog model of a provider by the local pricing table (input-weighted:
 * a triage reads ~20× more than it writes). Unpriced catalogs (local engines)
 * fall back to the provider default.
 */
export function cheapestModelForProvider(provider: string): string {
  let best: { model: string; score: number } | null = null
  for (const option of getModelsForProvider(provider)) {
    const price = resolvePriceEntry(provider, option.value)
    if (!price) continue
    const score = price.inputPer1M + price.outputPer1M / 20
    if (!best || score < best.score) best = { model: option.value, score }
  }
  return best?.model ?? getProviderDefault(provider)
}

/** The `triage` role engine when configured and usable, else the primary provider's cheapest model. */
export function resolveTriageEngine(project: TriageProject): TriageEngineResolution {
  const stored = loadLoopRoleEngines(project).triage
  let provider = derivePrimaryProvider(project)
  let model: string | undefined
  if (stored && isProviderEnabled(project, stored.provider) && hasAdapter(stored.provider)) {
    provider = stored.provider
    model = stored.model && isValidModelForProvider(stored.model, provider) ? stored.model : undefined
  }
  if (!isProviderEnabled(project, provider)) return { ok: false, reason: `provider_not_detected:${provider}` }
  if (!hasAdapter(provider)) return { ok: false, reason: `provider_not_registered:${provider}` }
  if (!pureOutputToolPolicy(getAdapter(provider))) return { ok: false, reason: `provider_tool_policy_unsupported:${provider}` }
  const resolved = model ?? cheapestModelForProvider(provider)
  if (!resolved) return { ok: false, reason: `no_model:${provider}` }
  return { ok: true, engine: { provider, model: resolved } }
}

// ─── Inputs ───────────────────────────────────────────────────────────────────

export function hashTriageInputs(inputs: TriageInputs): string {
  return 'sha256:' + createHash('sha256').update(canonicalJson(inputs), 'utf8').digest('hex')
}

/** Loops a triage may recommend: the rail built-ins the primary engine can run, plus published spec-driven custom loops. */
export function listTriageLoops(db: DbInstance, primaryProvider: string): TriageLoopOption[] {
  const loopsOn = isLoopsEnabled()
  const freestyle = hasAdapter(primaryProvider) && getAdapter(primaryProvider).capabilities.freestyle === true
  const out: TriageLoopOption[] = FACTORY_LOOPS
    .filter((f) => (f.id !== 'factory:freestyle' || freestyle) && (f.id !== 'factory:sdd-quick-openspec' || loopsOn))
    .map((f) => ({ id: f.id, name: f.name, description: f.description.slice(0, 240) }))
  if (loopsOn) {
    try {
      for (const loop of listLoops(db)) {
        if (loop.builtinId || loop.status !== 'published' || !loopNeedsTicket(loop.graph)) continue
        out.push({ id: loop.id, name: loop.name.slice(0, 80), description: (loop.description ?? '').slice(0, 240) })
      }
    } catch { /* loops table unavailable: built-ins only */ }
  }
  return out
}

function filesTouchedByTickets(db: DbInstance, ticketIds: number[]): string[] {
  if (ticketIds.length === 0) return []
  try {
    const rows = db.prepare(
      `SELECT file_path FROM file_provenance WHERE ticket_id IN (${ticketIds.map(() => '?').join(',')}) AND kind != 'deleted'`,
    ).all(...ticketIds) as Array<{ file_path: string }>
    return rankFiles(rows.map((r) => r.file_path))
  } catch { return [] }
}

function toTriageRepoMap(projectPath: string): TriageRepoMap | null {
  try {
    const map = buildRepoMap(projectPath)
    return {
      readmeExcerpt: map.readmeExcerpt ? map.readmeExcerpt.slice(0, TRIAGE_LIMITS.readme) : null,
      services: map.services.map(({ dir, name, ecosystem, sizeBucket }) => ({ dir, name, ecosystem, sizeBucket })),
    }
  } catch { return null }
}

/** Specs a trigger may consider at all (on demand or automatically). */
export function triageApplicability(ticket: Ticket): 'ok' | 'cancelled' | 'epic' | 'flow' {
  if (ticket.status === 'cancelled') return 'cancelled'
  if (ticket.is_epic) return 'epic'
  if (isFlowHeldTicket(ticket)) return 'flow'
  return 'ok'
}

// ─── Service ──────────────────────────────────────────────────────────────────

export interface SpecTriageDeps {
  project: TriageProject
  db: DbInstance
  ticketsPath: () => string
  broadcast: (msg: WsMessage) => void
  /** Suppress the ticket-watcher echo of our own write. */
  notifyDesktopWrite?: (revision: number) => void
  flowAvailable?: () => Promise<boolean>
  // Test seams.
  resolveEngine?: () => TriageEngineResolution
  runModel?: TriageModelRunner
  repoMap?: () => TriageRepoMap | null
  loops?: () => TriageLoopOption[]
  autoEnabled?: () => boolean
  now?: () => Date
  debounceMs?: number
}

export type TriageOutcome =
  | { kind: 'not_found' }
  | { kind: 'not_applicable'; reason: 'cancelled' | 'epic' | 'flow' }
  | { kind: 'unchanged'; triage: TicketTriage }
  | { kind: 'stored'; triage: TicketTriage }
  | { kind: 'queued' }
  | { kind: 'disposed' }

export class SpecTriageService {
  private readonly seen = new Map<number, string>()
  private readonly pending = new Set<number>()
  private chain: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly abort = new AbortController()
  private disposed = false
  private repoMapCache: { at: number; value: TriageRepoMap | null } | null = null

  constructor(private readonly deps: SpecTriageDeps) {}

  /** Seed the content signatures: specs present at startup are not auto-triaged. */
  start(): void {
    try {
      for (const ticket of Object.values(readStore(this.deps.ticketsPath()).tickets)) {
        this.seen.set(ticket.id, triageContentSignature(ticket))
      }
    } catch { /* no store yet: every later spec is new */ }
  }

  /** Broadcast tap: any ticket message schedules one debounced scan. */
  observe(msg: WsMessage): void {
    if (this.disposed) return
    if (msg.type !== 'ticket_created' && msg.type !== 'ticket_updated') return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.scan() }, this.deps.debounceMs ?? TRIAGE_DEBOUNCE_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** Compare signatures and queue the specs created or edited since last seen. */
  scan(): void {
    if (this.disposed || !(this.deps.autoEnabled ?? isSpecTriageAutoEnabled)()) return
    let store: TicketStore
    try { store = readStore(this.deps.ticketsPath()) } catch { return }
    for (const ticket of Object.values(store.tickets)) {
      const signature = triageContentSignature(ticket)
      const previous = this.seen.get(ticket.id)
      this.seen.set(ticket.id, signature)
      if (previous === signature) continue
      if (!AUTO_STATUSES.has(ticket.status) || triageApplicability(ticket) !== 'ok') continue
      this.enqueue(ticket.id, false)
    }
  }

  /** On-demand triage. `force` ignores an unchanged inputsHash (Recalculate). */
  triageNow(ticketId: number, opts: { force?: boolean } = {}): Promise<TriageOutcome> {
    return this.enqueue(ticketId, opts.force === true)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.abort.abort()
  }

  private enqueue(ticketId: number, force: boolean): Promise<TriageOutcome> {
    if (!force) {
      if (this.pending.has(ticketId)) return Promise.resolve({ kind: 'queued' })
      this.pending.add(ticketId)
    }
    const run = this.chain.then(async () => {
      this.pending.delete(ticketId)
      if (this.disposed) return { kind: 'disposed' } as const
      return this.run(ticketId, force)
    })
    this.chain = run.catch((err) => { console.error(`[triage] spec #${ticketId} failed:`, err) })
    return run
  }

  private repoMap(): TriageRepoMap | null {
    if (this.deps.repoMap) return this.deps.repoMap()
    const now = Date.now()
    if (!this.repoMapCache || now - this.repoMapCache.at > REPO_MAP_TTL_MS) {
      this.repoMapCache = { at: now, value: toTriageRepoMap(this.deps.project.path) }
    }
    return this.repoMapCache.value
  }

  private async collectInputs(ticket: Ticket, store: TicketStore, engine: TriageEngineResolution): Promise<{ inputs: TriageInputs; loops: TriageLoopOption[] }> {
    const others = Object.values(store.tickets).filter((t) => !t.is_epic)
    const similar = similarTicketIds({ id: ticket.id, title: ticket.title, labels: ticket.labels ?? [] }, others.map((t) => ({ id: t.id, title: t.title, labels: t.labels ?? [] })))
    const loops = this.deps.loops?.() ?? listTriageLoops(this.deps.db, derivePrimaryProvider(this.deps.project))
    let flowAvailable = false
    try { flowAvailable = (await this.deps.flowAvailable?.()) === true } catch { flowAvailable = false }
    const inputs: TriageInputs = {
      promptVersion: TRIAGE_PROMPT_VERSION,
      ticket: triageTicketText(ticket),
      repoMap: this.repoMap(),
      similarFiles: filesTouchedByTickets(this.deps.db, similar),
      loops: loops.map(({ id, name, description }) => ({ id, name, description })),
      flowAvailable,
      engine: engine.ok ? `${engine.engine.provider}:${engine.engine.model}` : null,
    }
    return { inputs, loops }
  }

  private async run(ticketId: number, force: boolean): Promise<TriageOutcome> {
    let store: TicketStore
    try { store = readStore(this.deps.ticketsPath()) } catch { return { kind: 'not_found' } }
    const ticket = store.tickets[String(ticketId)]
    if (!ticket) return { kind: 'not_found' }
    const applicability = triageApplicability(ticket)
    if (applicability !== 'ok') return { kind: 'not_applicable', reason: applicability }

    const engine = (this.deps.resolveEngine ?? (() => resolveTriageEngine(this.deps.project)))()
    const { inputs, loops } = await this.collectInputs(ticket, store, engine)
    const inputsHash = hashTriageInputs(inputs)
    const existing = ticket.metadata?.triage
    if (!force && isTicketTriage(existing) && existing.inputsHash === inputsHash) return { kind: 'unchanged', triage: existing }

    const computedAt = () => (this.deps.now?.() ?? new Date()).toISOString()
    let record: TicketTriage
    if (!engine.ok) {
      record = { status: 'unavailable', reason: engine.reason, inputsHash, computedAt: computedAt() }
    } else {
      record = await this.callModel(ticket.id, engine.engine, inputs, loops, inputsHash, computedAt)
    }
    if (this.disposed) return { kind: 'disposed' }
    const written = this.write(ticket.id, record)
    return written ? { kind: 'stored', triage: record } : { kind: 'not_found' }
  }

  private async callModel(ticketId: number, engine: TriageEngine, inputs: TriageInputs, loops: TriageLoopOption[], inputsHash: string, computedAt: () => string): Promise<TicketTriage> {
    const startedAt = computedAt()
    const runModel = this.deps.runModel ?? runTriageModel
    let usage: TriageModelUsage | undefined
    let record: TicketTriage
    let status: 'success' | 'failed' | 'aborted' = 'success'
    try {
      const result = await runModel({
        projectId: this.deps.project.id,
        project: this.deps.project,
        provider: engine.provider,
        model: engine.model,
        systemPrompt: buildTriageSystemPrompt(),
        userPrompt: buildTriageUserPrompt(inputs),
        signal: this.abort.signal,
      })
      usage = result
      const parsed = parseTriageOutput(result.text, { loops, flowAvailable: inputs.flowAvailable })
      if (parsed.ok) {
        record = { status: 'ready', ...parsed.value, inputsHash, model: result.model, costUsd: result.costUsd, computedAt: computedAt() }
      } else {
        status = 'failed'
        record = { status: 'failed', error: `invalid_output:${parsed.error}`, inputsHash, model: result.model, costUsd: result.costUsd, computedAt: computedAt() }
      }
    } catch (err) {
      usage = err instanceof TriageModelError ? err.partial : undefined
      status = this.abort.signal.aborted ? 'aborted' : 'failed'
      record = {
        status: 'failed',
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        inputsHash,
        model: usage?.model ?? engine.model,
        costUsd: usage?.costUsd ?? null,
        computedAt: computedAt(),
      }
    }
    try {
      recordInvocation(this.deps.db, {
        id: randomUUID(),
        project_id: this.deps.project.id,
        provider: usage?.provider ?? engine.provider,
        surface: 'triage',
        surface_ref_id: null,
        ticket_id: ticketId,
        status,
        started_at: startedAt,
        finished_at: computedAt(),
        model: usage?.model ?? engine.model,
        total_cost_usd: usage?.costUsd ?? undefined,
        total_cost_usd_estimated: usage?.costEstimated === true,
        tokens_in: usage?.tokensIn ?? undefined,
        tokens_out: usage?.tokensOut ?? undefined,
        tokens_cache_read: usage?.tokensCacheRead,
        tokens_cache_create: usage?.tokensCacheCreate,
        duration_ms: usage?.durationMs,
        num_turns: 1,
      })
    } catch (err) {
      console.error('[triage] recordInvocation failed:', err)
    }
    return record
  }

  /** Persist without touching `updated_at` (triage is not a user edit). */
  private write(ticketId: number, record: TicketTriage): boolean {
    let saved: Ticket | undefined
    let revision = 0
    try {
      const store = mutateStore(this.deps.ticketsPath(), (s) => {
        const ticket = s.tickets[String(ticketId)]
        if (!ticket) return
        ticket.metadata = { ...(ticket.metadata ?? {}), triage: record }
        saved = ticket
      })
      revision = store.revision
    } catch (err) {
      console.error(`[triage] write for spec #${ticketId} failed:`, err)
      return false
    }
    if (!saved) return false
    this.deps.notifyDesktopWrite?.(revision)
    this.deps.broadcast({
      type: 'ticket_updated',
      ticket: saved as unknown as LocalTicket,
      projectId: this.deps.project.id,
      timestamp: (this.deps.now?.() ?? new Date()).toISOString(),
    } as WsMessage)
    return true
  }
}
