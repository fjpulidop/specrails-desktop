/**
 * What a Core workflow run's next AI step is expected to cost, for the per-run soft cap.
 *
 * A turn already started cannot be stopped, so the cap is enforced BEFORE a step starts,
 * against what that step is expected to cost. Looking only at the run's own earlier turns
 * misses the first heavy step (a $0.49 Developer after a $0.05 Architect took a $0.40 cap to
 * $0.54), so the estimate of a step is, in order:
 *
 *   1. `run`     — its largest earlier turn in this run (a revisit: fixer, retry);
 *   2. `history` — the median of its turns in this project's recent runs on the same
 *                  provider and model (Core reports each physical turn with its node);
 *   3. `default` — a rate-card estimate of a typical turn of its kind on its model.
 *
 * The next step comes from the graph Core described (`runtime-graph`: nodes and edges): the
 * AI nodes reachable from a node through non-AI nodes (conditions, verification, archive).
 * When the workflow can branch to more than one, the most expensive one is assumed.
 */
import type { DbInstance } from '../../../db'
import { estimateCostUsd, resolvePriceEntry } from '../../accounting/runtime/pricing'
import type { NextStepEstimate } from '../../execution'
import type { LoopGraph } from './loop-graph'

/** Node kinds whose step is a provider turn (the runtime graph names each node's kind). */
export const AI_NODE_KINDS: ReadonlySet<string> = new Set(['role-turn', 'prompt', 'implementation', 'implementation-step', 'derive-change', 'agent'])

/** The part of a workflow graph the cap needs: AI nodes, their labels, and who follows whom. */
export interface TurnGraph {
  nodes: Map<string, { kind: string; label: string }>
  successors: Map<string, string[]>
  /** Where the workflow starts (no incoming edge, or the start node's targets). */
  entry: string[]
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null

function build(nodes: Array<{ path: string; kind: string; label: string }>, edges: Array<{ from: string; to: string }>, entry?: string[]): TurnGraph | null {
  if (!nodes.length || !edges.length) return null
  const graph: TurnGraph = { nodes: new Map(nodes.map(node => [node.path, { kind: node.kind, label: node.label }])), successors: new Map(), entry: [] }
  const incoming = new Set<string>()
  for (const edge of edges) {
    if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) continue
    graph.successors.set(edge.from, [...(graph.successors.get(edge.from) ?? []), edge.to])
    incoming.add(edge.to)
  }
  // A runtime graph names no start node: the nodes nothing leads to, else (the workflow can loop
  // back to its first step) every AI node, so a first step is never under-estimated.
  const roots = nodes.map(node => node.path).filter(path => !incoming.has(path))
  graph.entry = entry ?? (roots.length ? roots : nodes.filter(node => AI_NODE_KINDS.has(node.kind)).map(node => node.path))
  return graph
}

/** The graph a `runtime-graph` event describes; null when it carries no edges (an older Core). */
export function turnGraphFromRuntime(event: unknown): TurnGraph | null {
  if (!object(event) || !Array.isArray(event.nodes) || !Array.isArray(event.edges)) return null
  const nodes = event.nodes.flatMap(node => object(node) && text(node.path) ? [{ path: String(node.path), kind: String(node.kind ?? ''), label: text(node.label) ?? String(node.path) }] : [])
  const edges = event.edges.flatMap(edge => object(edge) && text(edge.from) && text(edge.to) ? [{ from: String(edge.from), to: String(edge.to) }] : [])
  return build(nodes, edges)
}

/** The top-level graph of a loop definition (before Core describes it): its ids are Core's node paths. */
export function turnGraphFromLoop(graph: LoopGraph | undefined): TurnGraph | null {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return null
  const start = graph.nodes.find(node => node.type === 'start')
  const nodes = graph.nodes.map(node => ({ path: node.id, kind: node.type === 'core' ? String(node.data?.kind ?? '') : node.type, label: text(node.data?.label) ?? node.id }))
  const edges = graph.edges.map(edge => ({ from: edge.source, to: edge.target }))
  return build(nodes, edges, start ? graph.edges.filter(edge => edge.source === start.id).map(edge => edge.target) : undefined)
}

export const isAiNode = (graph: TurnGraph, path: string): boolean => AI_NODE_KINDS.has(graph.nodes.get(path)?.kind ?? '')

/**
 * The AI nodes the workflow can run next after `from` (null: from its start), through any
 * number of non-AI nodes. An AI node is a stop: what comes after it is its own next step.
 */
export function nextAiNodes(graph: TurnGraph, from: string | null): string[] {
  const found = new Set<string>(), seen = new Set<string>()
  const queue = [...(from === null ? graph.entry : graph.successors.get(from) ?? [])]
  while (queue.length) {
    const path = queue.shift()!
    if (seen.has(path)) continue
    seen.add(path)
    if (isAiNode(graph, path)) { found.add(path); continue }
    queue.push(...(graph.successors.get(path) ?? []))
  }
  return [...found]
}

/** The graph Core described for a run (stored with its events); null before Core described it. */
export function readRunTurnGraph(db: DbInstance, runId: string): TurnGraph | null {
  try {
    const row = db.prepare("SELECT payload FROM events WHERE job_id=? AND event_type='runtime-graph' ORDER BY seq DESC LIMIT 1").get(runId) as { payload: string } | undefined
    return row ? turnGraphFromRuntime(JSON.parse(row.payload)) : null
  } catch { return null }
}

/** Core already described the run's graph (even one without edges). */
export function runTurnGraphStored(db: DbInstance, runId: string): boolean {
  try { return !!db.prepare("SELECT 1 FROM events WHERE job_id=? AND event_type='runtime-graph' LIMIT 1").get(runId) } catch { return false }
}

/** One physical attempt of an AI node: its invocations summed. */
export interface NodeTurn { nodePath: string; provider: string; model: string | null; usd: number }

/**
 * A run's AI turns by node, in order, with their recorded cost (provider-reported, or the
 * rate-card estimate Desktop recorded for a CLI that reports none). A multi-ticket turn is
 * recorded split per ticket and summed back here.
 */
export function readRunNodeTurns(db: DbInstance, runId: string): NodeTurn[] {
  const events = db.prepare(`SELECT json_extract(payload,'$.nodePath') AS nodePath, json_extract(payload,'$.attemptId') AS attemptId,
      json_extract(payload,'$.payload.invocationId') AS invocationId, json_extract(payload,'$.payload.provider') AS provider, json_extract(payload,'$.payload.model') AS model
    FROM events WHERE job_id=? AND event_type='runtime-efficiency-event' AND json_extract(payload,'$.kind')='role-context' ORDER BY seq`).all(runId) as Array<{ nodePath: string | null; attemptId: string | null; invocationId: string | null; provider: string | null; model: string | null }>
  if (!events.length) return []
  const costs = new Map<string, number>()
  for (const row of db.prepare('SELECT id, total_cost_usd AS cost FROM ai_invocations WHERE loop_run_id=? AND total_cost_usd IS NOT NULL').all(runId) as Array<{ id: string; cost: number }>) {
    const key = row.id.replace(/:t\d+$/, '')
    costs.set(key, (costs.get(key) ?? 0) + row.cost)
  }
  const turns: NodeTurn[] = [], byAttempt = new Map<string, NodeTurn>()
  for (const event of events) {
    if (!event.nodePath || !event.invocationId || !event.provider) continue
    const cost = costs.get(`core:${runId}:${event.invocationId}`)
    if (cost === undefined) continue
    const key = event.attemptId ?? event.invocationId
    const prior = byAttempt.get(key)
    if (prior) { prior.usd += cost; continue }
    const turn = { nodePath: event.nodePath, provider: event.provider, model: event.model, usd: cost }
    byAttempt.set(key, turn); turns.push(turn)
  }
  return turns
}

const HISTORY_RUNS = 30
const HISTORY_TTL_MS = 60_000
const historyCache = new WeakMap<DbInstance, { at: number; samples: Map<string, number[]> }>()
const historyKey = (nodePath: string, provider: string, model: string | null): string => `${nodePath}\u0000${provider}\u0000${model ?? ''}`

/** The project's recent Core runs' AI turns by node, provider and model (cached briefly: it is read before steps). */
export function readNodeCostHistory(db: DbInstance, now = Date.now()): Map<string, number[]> {
  const cached = historyCache.get(db)
  if (cached && now - cached.at < HISTORY_TTL_MS) return cached.samples
  const samples = new Map<string, number[]>()
  try {
    const runs = db.prepare(`SELECT loop_run_id AS id, MAX(started_at) AS at FROM ai_invocations
      WHERE surface='loop' AND loop_run_id IS NOT NULL AND id LIKE 'core:%' GROUP BY loop_run_id ORDER BY at DESC LIMIT ?`).all(HISTORY_RUNS) as Array<{ id: string }>
    for (const run of runs) for (const turn of readRunNodeTurns(db, run.id)) {
      const key = historyKey(turn.nodePath, turn.provider, turn.model)
      samples.set(key, [...(samples.get(key) ?? []), turn.usd])
    }
  } catch { /* no history: defaults apply */ }
  historyCache.set(db, { at: now, samples })
  return samples
}

/** Forget the cached history (a run just recorded turns another estimate should see). */
export function invalidateNodeCostHistory(db: DbInstance): void { historyCache.delete(db) }

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * Typical token profiles of a Core turn, by kind of step: medians of the role turns Core
 * recorded across real projects (2026-11, Claude Sonnet; cache reads dominate a turn).
 * Planning and implementation turns read the repository at length; derivation less;
 * review and correction turns least.
 */
const PROFILES = {
  heavy: { fresh: 40, read: 1_000_000, write: 80_000, out: 12_000 },
  medium: { fresh: 20, read: 340_000, write: 33_000, out: 8_000 },
  light: { fresh: 10, read: 210_000, write: 54_000, out: 2_500 },
} as const

function stepClass(nodePath: string, kind: string, label: string): keyof typeof PROFILES {
  if (kind === 'implementation' || kind === 'implementation-step' || /develop|implement|architect|plan|apply|prepare/i.test(`${nodePath} ${label}`)) return 'heavy'
  if (kind === 'derive-change' || /derive/i.test(`${nodePath} ${label}`)) return 'medium'
  return 'light'
}

/** A rate-card estimate of a typical turn of this kind on this model; null for a model the rate card does not price. */
export function defaultTurnCostUsd(provider: string, model: string | null, step: { nodePath: string; kind: string; label: string }): number | null {
  if (!model) return null
  const entry = resolvePriceEntry(provider, model)
  if (!entry) return null
  const profile = PROFILES[stepClass(step.nodePath, step.kind, step.label)]
  const usage = entry.inputIncludesCacheReads === false
    ? { tokens_in: profile.fresh, tokens_cache_read: profile.read, tokens_cache_create: profile.write, tokens_out: profile.out }
    : { tokens_in: profile.fresh + profile.read + profile.write, tokens_cache_read: profile.read, tokens_cache_create: profile.write, tokens_out: profile.out }
  const cost = estimateCostUsd(provider, model, usage)
  return cost !== null && cost > 0 ? cost : null
}

export interface TurnEstimateInputs {
  graph: TurnGraph
  /** This run's AI turns so far. */
  turns: readonly NodeTurn[]
  history: Map<string, number[]>
  /** The provider/model a node's turn runs on (its role's route, else the run's). */
  route(nodePath: string): { provider: string; model: string | null }
}

/** An estimate reads as one: whole cents, or a tenth of a cent for a small model's turn. */
const roundEstimate = (usd: number): number => usd >= 0.1 ? Math.round(usd * 100) / 100 : Math.round(usd * 1000) / 1000

/** What one AI node's next turn is expected to cost; null when nothing can be said (an unpriced model, no history). */
export function estimateNodeTurn(input: TurnEstimateInputs, nodePath: string): NextStepEstimate | null {
  const node = input.graph.nodes.get(nodePath)
  const label = node?.label ?? nodePath
  const own = input.turns.filter(turn => turn.nodePath === nodePath)
  if (own.length) return { nodePath, label, usd: Math.max(...own.map(turn => turn.usd)), basis: 'run', samples: own.length }
  const route = input.route(nodePath)
  const past = input.history.get(historyKey(nodePath, route.provider, route.model)) ?? []
  if (past.length) return { nodePath, label, usd: roundEstimate(median(past)), basis: 'history', samples: past.length }
  const fallback = defaultTurnCostUsd(route.provider, route.model, { nodePath, kind: node?.kind ?? '', label })
  return fallback === null ? null : { nodePath, label, usd: roundEstimate(fallback), basis: 'default', samples: 0 }
}

/**
 * The most expensive AI step the workflow can run after `from` (null: from its start); null when
 * none follows or none can be estimated. A step the run already ran is a way back (a failed
 * check returns to the developer, a low-confidence plan to the architect): while the workflow
 * can also move forward to a step it has not run, the forward steps are what it expects.
 */
export function estimateNextStep(input: TurnEstimateInputs, from: string | null): NextStepEstimate | null {
  const candidates = nextAiNodes(input.graph, from)
  // `from` itself counts as run: it is running now or just ran (its own retry is a way back).
  const ran = new Set([...input.turns.map(turn => turn.nodePath), ...(from === null ? [] : [from])])
  const forward = candidates.filter(path => !ran.has(path))
  let best: NextStepEstimate | null = null
  for (const path of forward.length ? forward : candidates) {
    const estimate = estimateNodeTurn(input, path)
    if (estimate && (!best || estimate.usd > best.usd)) best = estimate
  }
  return best
}
