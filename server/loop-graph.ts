/**
 * Loop graph model + validation — the pure core shared by the canvas builder
 * (`loop-builder-canvas`) and the publish gate (`loops-store.publishLoop`).
 *
 * A loop is a directed graph of typed nodes connected by edges. Cycles are
 * allowed (a loop routes back to an earlier node); the run is bounded by the
 * graph's `config.maxIterations` + `timeoutMinutes`. This module has NO I/O and
 * NO provider knowledge — it only describes and validates the shape, so it is
 * trivially unit-testable and reused verbatim by both the store and the engine.
 */

export type LoopNodeType = 'start' | 'ai-step' | 'shell' | 'decider' | 'condition' | 'end'

/** Boolean join carried on an edge leaving a `condition` node. */
export type LoopJoin = 'AND' | 'OR'

/** Which Decider verdict routes down an edge leaving a `decider` node.
 *  'continue' = goal NOT met → loop back; 'stop' = goal met → exit. */
export type LoopBranch = 'continue' | 'stop'

export interface LoopNode {
  id: string
  type: LoopNodeType
  /** Canvas position (used by the builder; ignored by the engine). */
  position: { x: number; y: number }
  /** Node-type-specific config (prompt/model/effort, command, goal, …). */
  data?: Record<string, unknown>
}

export interface LoopEdge {
  id: string
  source: string
  target: string
  /** Set on edges leaving a `condition` node: AND = sequence, OR = fallback. */
  join?: LoopJoin
  /** Set on edges leaving a `decider` node — which verdict routes here. Maps to
   *  the React Flow `sourceHandle` on the canvas. Absent on legacy graphs (the
   *  engine then falls back to the successor-node-type heuristic). */
  branch?: LoopBranch
}

export interface LoopGraphConfig {
  /** Hard upper bound on iterations regardless of the Decider's verdict. */
  maxIterations: number
  /** Wall-clock timeout for the whole run, in minutes. */
  timeoutMinutes: number
  /** Optional cost cap (USD) for the whole run. Enforced BETWEEN steps (per-step
   *  cost is only known when a step's process exits), so the loop stops before
   *  the next step once the accumulated cost crosses this — may overshoot by one
   *  step. For non-Claude providers the per-step cost is an estimate. Undefined or
   *  ≤ 0 ⇒ no cap. */
  maxCostUsd?: number
  /** The builder's saved auto-arrange decision for this loop. 'manual' (or
   *  unset) = the user hand-placed the nodes. The engine ignores this; it only
   *  drives the canvas layout when the loop is re-opened in the builder. */
  layout?: 'vertical' | 'horizontal' | 'grid' | 'manual'
}

export interface LoopGraph {
  nodes: LoopNode[]
  edges: LoopEdge[]
  config: LoopGraphConfig
}

export type GraphValidationCode =
  | 'NO_START'
  | 'MULTIPLE_START'
  | 'NO_END'
  | 'ORPHAN_NODE'
  | 'DANGLING_EDGE'
  | 'INVALID_CONFIG'

export interface GraphValidationError {
  code: GraphValidationCode
  message: string
  /** The offending node (ORPHAN_NODE / MULTIPLE_START) when applicable. */
  nodeId?: string
  /** The offending edge (DANGLING_EDGE) when applicable. */
  edgeId?: string
}

export interface GraphValidationResult {
  valid: boolean
  errors: GraphValidationError[]
}

/** A minimal, structurally-valid empty graph (used to seed a new Draft). */
export function emptyLoopGraph(): LoopGraph {
  return { nodes: [], edges: [], config: { maxIterations: 10, timeoutMinutes: 30 } }
}

/**
 * Validate a loop graph against the publish-time rules:
 *  - exactly one `start` node,
 *  - at least one `end` node (the explicit exit),
 *  - every edge references existing nodes (no dangling edges),
 *  - every node is reachable from `start` (no orphan / disconnected nodes),
 *  - a sane config (maxIterations ≥ 1, timeoutMinutes ≥ 1).
 *
 * Returns all errors found (not just the first) so the builder can highlight
 * every problem at once.
 */
export function validateLoopGraph(graph: LoopGraph): GraphValidationResult {
  const errors: GraphValidationError[] = []

  const nodes = graph.nodes ?? []
  const edges = graph.edges ?? []

  // ── Start cardinality ──────────────────────────────────────────────────────
  const starts = nodes.filter((n) => n.type === 'start')
  if (starts.length === 0) {
    errors.push({ code: 'NO_START', message: 'The loop must have a Start node.' })
  } else if (starts.length > 1) {
    for (const extra of starts.slice(1)) {
      errors.push({
        code: 'MULTIPLE_START',
        message: 'The loop must have exactly one Start node.',
        nodeId: extra.id,
      })
    }
  }

  // ── End presence ────────────────────────────────────────────────────────────
  if (!nodes.some((n) => n.type === 'end')) {
    errors.push({ code: 'NO_END', message: 'The loop must have at least one End node.' })
  }

  // ── Config sanity ─────────────────────────────────────────────────────────────
  const cfg = graph.config
  if (
    !cfg ||
    !Number.isInteger(cfg.maxIterations) ||
    cfg.maxIterations < 1 ||
    typeof cfg.timeoutMinutes !== 'number' ||
    cfg.timeoutMinutes < 1
  ) {
    errors.push({
      code: 'INVALID_CONFIG',
      message: 'maxIterations and timeoutMinutes must both be ≥ 1.',
    })
  }

  // ── Dangling edges ────────────────────────────────────────────────────────────
  const nodeIds = new Set(nodes.map((n) => n.id))
  for (const e of edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) {
      errors.push({
        code: 'DANGLING_EDGE',
        message: `Edge "${e.id}" references a node that does not exist.`,
        edgeId: e.id,
      })
    }
  }

  // ── Reachability from Start (orphan detection) ──────────────────────────────
  // Only meaningful with exactly one Start; otherwise the start-cardinality
  // errors above already explain the shape problem.
  if (starts.length === 1) {
    const adjacency = new Map<string, string[]>()
    for (const e of edges) {
      if (nodeIds.has(e.source) && nodeIds.has(e.target)) {
        const list = adjacency.get(e.source) ?? []
        list.push(e.target)
        adjacency.set(e.source, list)
      }
    }
    const visited = new Set<string>()
    const queue: string[] = [starts[0].id]
    visited.add(starts[0].id)
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) {
          visited.add(next)
          queue.push(next)
        }
      }
    }
    for (const n of nodes) {
      if (!visited.has(n.id)) {
        errors.push({
          code: 'ORPHAN_NODE',
          message: `Node "${n.id}" is not reachable from Start.`,
          nodeId: n.id,
        })
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

// ── Traversal helpers (used by the execution engine) ─────────────────────────

export function nodesById(graph: LoopGraph): Map<string, LoopNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]))
}

export function findStartNode(graph: LoopGraph): LoopNode | undefined {
  return graph.nodes.find((n) => n.type === 'start')
}

/** The nodes directly reachable from `nodeId` via an outgoing edge (in edge order). */
export function successors(graph: LoopGraph, nodeId: string): LoopNode[] {
  const byId = nodesById(graph)
  return graph.edges
    .filter((e) => e.source === nodeId)
    .map((e) => byId.get(e.target))
    .filter((n): n is LoopNode => n !== undefined)
}

/**
 * Replace `{{spec.title}}` / `{{spec.description}}` tokens in node text with the
 * rail's spec. Unknown `{{spec.*}}` tokens and missing fields collapse to an
 * empty string (never leaks the literal token to the model).
 */
/** The spec (local ticket) fields a loop prompt can reference via `{{spec.*}}`. */
export interface LoopSpec {
  id?: number
  /** All ticket ids this run targets (for `{{spec.ids}}` → `#1 #2 #3`). */
  ticketIds?: number[]
  title?: string
  description?: string
  status?: string
  priority?: string | null
  labels?: string[]
  jira_key?: string | null
  jira_url?: string | null
}

export function interpolateSpec(text: string, spec?: LoopSpec): string {
  return text.replace(/\{\{\s*spec\.(\w+)\s*\}\}/g, (_match, key: string) => {
    // `{{spec.ids}}` → all rail ticket ids as `#1 #2 #3` (used by implement/batch).
    if (key === 'ids') {
      const ids = spec?.ticketIds ?? (spec?.id != null ? [spec.id] : [])
      return ids.map((id) => `#${id}`).join(' ')
    }
    const value = spec ? (spec as Record<string, unknown>)[key] : undefined
    if (value == null) return ''
    if (Array.isArray(value)) return value.join(', ')
    return String(value)
  })
}
