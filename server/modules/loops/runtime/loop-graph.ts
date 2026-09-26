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

export type LoopNodeType = 'start' | 'ai-step' | 'shell' | 'decider' | 'condition' | 'core' | 'end'

export const CORE_NODE_KINDS = ['prompt', 'role-turn', 'decider', 'condition', 'verify', 'shell',
  'openspec-validate', 'openspec-archive', 'approval', 'question', 'gate', 'map', 'join',
  'component', 'implementation', 'end'] as const
export type CoreNodeKind = typeof CORE_NODE_KINDS[number]
export interface CorePieceShape { kind: string; outcomes: readonly string[] }

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
  data?: Record<string, unknown> & {
    kind?: CoreNodeKind
    params?: Record<string, unknown>
    retry?: { maxAttempts?: number; backoffMs?: number; retryOn?: string[] }
    /** One in-run retry; cross-phase targets may only repair artifacts. */
    failureRecovery?: { target: string; maxRetries: number; artifactOnly?: boolean }
    /** Shell steps in a multi-repository execution must name a selected repository. */
    repositoryId?: string
    /** Explicit host operation. The prompt remains only for legacy transports. */
    operation?: 'core-implementation'
  }
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
  /** Core piece outcome; validated again against the effective params by Core. */
  label?: string
}

export interface LoopGraphConfig {
  /** Hard upper bound on iterations regardless of the Decider's verdict. */
  maxIterations: number
  /** Wall-clock timeout for the whole run, in minutes. 0 ⇒ no run deadline
   *  (the iteration cap / cost cap remain the runaway guards). */
  timeoutMinutes: number
  /** Per-AI-step wall-clock timeout, in minutes. Undefined ⇒ the engine default
   *  (15 min); 0 ⇒ no per-step timeout. Factory pipeline loops
   *  (implement/batch/freestyle) disable both because a single step runs the
   *  whole architect→developer→reviewer pipeline and a legit implement can
   *  outlast any fixed budget. */
  aiStepTimeoutMinutes?: number
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
  journal?: 'ledger-only' | 'implementation'
  change?: 'new' | 'existing' | 'none'
  maxTransitions?: number
  maxTokens?: number
  policies?: { failFast?: number; noProgress?: number; historyMaxChars?: number; concurrency?: number }
}

export interface LoopGraph {
  nodes: LoopNode[]
  edges: LoopEdge[]
  config: LoopGraphConfig
  /** Reusable nested canvases; Core validates depth, cycles and parameter schemas. */
  inputs?: string[]
  outputs?: string[]
  components?: Record<string, LoopGraph>
}

export function isDefinitionGraph(graph: LoopGraph): boolean {
  return graph.nodes.some(node => node.type === 'core')
}

export function assertDefinitionGraph(graph: LoopGraph): void {
  if (!isDefinitionGraph(graph) || graph.nodes.some(node => !['start', 'core', 'end'].includes(node.type))) {
    throw new Error('A Core workflow must contain Core pieces and cannot mix Desktop execution steps.')
  }
}

/** A named shell target must never silently fall back to another checkout. */
export function assertLoopShellRepositoryScope(graph: LoopGraph, repositoryIds: readonly string[]): void {
  for (const node of graph.nodes) {
    const target = node.type === 'shell' ? node.data?.repositoryId : undefined
    if (target !== undefined && (typeof target !== 'string' || !repositoryIds.includes(target))) {
      throw new Error(`Shell step ${node.id} targets a repository outside this launch`)
    }
  }
}

/** Recovery is bounded and may only repeat a phase or repair artifacts before revalidation. */
export function assertLoopFailureRecovery(graph: LoopGraph): void {
  for (const node of graph.nodes) {
    const recovery = node.data?.failureRecovery
    if (recovery === undefined) continue
    const target = graph.nodes.find((candidate) => candidate.id === recovery?.target)
    if (!recovery || node.data?.stopOnFailure !== true ||
      !['ai-step', 'shell'].includes(node.type) ||
      recovery.maxRetries !== 1 ||
      (recovery.artifactOnly !== undefined && typeof recovery.artifactOnly !== 'boolean') ||
      !target || (target.id !== node.id &&
        !(node.type === 'shell' && target.type === 'ai-step' && recovery.artifactOnly === true)) ||
      (recovery.artifactOnly === true && (target?.type !== 'ai-step' || target.data?.operation === 'core-implementation' || target.data?.stopOnFailure !== true))) {
      throw new Error(`Invalid failure recovery for step ${node.id}: use one retry of this phase or an AI artifact repair.`)
    }
  }
}

export type GraphValidationCode =
  | 'NO_START'
  | 'MULTIPLE_START'
  | 'NO_END'
  | 'ORPHAN_NODE'
  | 'DANGLING_EDGE'
  | 'INVALID_CONFIG'
  | 'INVALID_NODE'
  | 'DUPLICATE_NODE'
  | 'DUPLICATE_EDGE'
  | 'INVALID_BRANCH'
  | 'UNSUPPORTED_BRANCHING'
  | 'DEAD_END'
  | 'MIXED_ENGINES'

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
 *  - a sane config (maxIterations ≥ 1, timeoutMinutes ≥ 0 — 0 = no timeout).
 *
 * Returns all errors found (not just the first) so the builder can highlight
 * every problem at once.
 */
export function validateLoopGraph(graph: LoopGraph, catalog?: readonly CorePieceShape[]): GraphValidationResult {
  const errors: GraphValidationError[] = []

  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return { valid: false, errors: [{ code: 'INVALID_CONFIG', message: 'A loop graph must contain nodes and edges arrays.' }] }
  }
  const nodes = graph.nodes
  const edges = graph.edges
  const kinds = new Set<LoopNodeType>(['start', 'ai-step', 'shell', 'decider', 'condition', 'core', 'end'])
  if (nodes.some((node) => !node || typeof node.id !== 'string' || !node.id.trim() || !kinds.has(node.type))) {
    return { valid: false, errors: [{ code: 'INVALID_NODE', message: 'Every node needs a non-empty id and a supported node type.' }] }
  }
  if (edges.some((edge) => !edge || typeof edge.id !== 'string' || !edge.id.trim() || typeof edge.source !== 'string' || typeof edge.target !== 'string')) {
    return { valid: false, errors: [{ code: 'DANGLING_EDGE', message: 'Every edge needs a non-empty id, source and target.' }] }
  }
  const definition = isDefinitionGraph(graph)
  if (definition && nodes.some(node => !['start', 'core', 'end'].includes(node.type))) {
    errors.push({ code: 'MIXED_ENGINES', message: 'Core workflows cannot mix Core pieces with Desktop execution steps.' })
  }
  for (const node of nodes) {
    if (definition && (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(node.id) || ['START', 'END', '__start__', '__end__', 'next'].includes(node.id))) {
      errors.push({ code: 'INVALID_NODE', nodeId: node.id, message: 'Core node IDs must be safe, non-reserved identifiers.' })
    }
    if (node.type === 'core' && (!CORE_NODE_KINDS.includes(node.data?.kind as CoreNodeKind) || !node.data?.params ||
      typeof node.data.params !== 'object' || Array.isArray(node.data.params))) {
      errors.push({ code: 'INVALID_NODE', nodeId: node.id, message: 'A Core piece needs a supported kind and an object of parameters.' })
    }
  }
  for (const [items, code] of [[nodes, 'DUPLICATE_NODE'], [edges, 'DUPLICATE_EDGE']] as const) {
    const ids = new Set<string>()
    for (const item of items) {
      if (ids.has(item.id)) errors.push({ code, message: `Duplicate ${code === 'DUPLICATE_NODE' ? 'node' : 'edge'} id "${item.id}".` })
      ids.add(item.id)
    }
  }

  for (const node of nodes) {
    if (node.type === 'shell' && node.data?.repositoryId !== undefined &&
      (typeof node.data.repositoryId !== 'string' || !node.data.repositoryId.trim())) {
      errors.push({ code: 'INVALID_NODE', nodeId: node.id, message: 'A shell repositoryId must be a non-empty registered repository id.' })
    }
  }

  try { assertLoopFailureRecovery(graph) } catch (error) {
    errors.push({ code: 'INVALID_NODE', message: (error as Error).message })
  }

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
  if (!nodes.some((n) => n.type === 'end' || n.type === 'core' && n.data?.kind === 'end')) {
    errors.push({ code: 'NO_END', message: 'The loop must have at least one End node.' })
  }

  // ── Config sanity ─────────────────────────────────────────────────────────────
  const cfg = graph.config
  if (
    !cfg ||
    !Number.isInteger(cfg.maxIterations) ||
    cfg.maxIterations < 1 ||
    typeof cfg.timeoutMinutes !== 'number' ||
    !Number.isFinite(cfg.timeoutMinutes) ||
    cfg.timeoutMinutes < 0 ||
    (cfg.aiStepTimeoutMinutes !== undefined && (!Number.isFinite(cfg.aiStepTimeoutMinutes) || cfg.aiStepTimeoutMinutes < 0)) ||
    (cfg.maxCostUsd !== undefined && !Number.isFinite(cfg.maxCostUsd)) ||
    (cfg.maxTransitions !== undefined && (!Number.isInteger(cfg.maxTransitions) || cfg.maxTransitions < 1 || cfg.maxTransitions > 10000)) ||
    (cfg.maxTokens !== undefined && (!Number.isInteger(cfg.maxTokens) || cfg.maxTokens < 1))
  ) {
    errors.push({
      code: 'INVALID_CONFIG',
      message: 'maxIterations must be ≥ 1; timeouts must be finite and ≥ 0 (0 = no timeout); maxCostUsd must be finite.',
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

  // The executor follows one successor at a time. Publishing a branching AI,
  // shell or condition node would silently skip all but its first branch.
  for (const node of nodes) {
    const out = edges.filter((edge) => edge.source === node.id)
    if (node.type === 'end' || node.type === 'core' && node.data?.kind === 'end') {
      if (out.length) errors.push({ code: 'INVALID_BRANCH', nodeId: node.id, message: 'End nodes cannot have outgoing edges.' })
    } else if (node.type === 'core') {
      const descriptor = catalog?.find(piece => piece.kind === node.data?.kind)
      if (catalog && !descriptor) errors.push({ code: 'INVALID_NODE', nodeId: node.id, message: 'The installed Core does not advertise this piece.' })
      if (!out.length) errors.push({ code: 'DEAD_END', nodeId: node.id, message: 'A Core piece needs labeled outcome edges.' })
      const labels = new Set<string>()
      for (const edge of out) {
        if (typeof edge.label !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(edge.label) || labels.has(edge.label) ||
          (descriptor && !descriptor.outcomes.includes(edge.label))) {
          errors.push({ code: 'INVALID_BRANCH', nodeId: node.id, edgeId: edge.id, message: 'Core outcome edges need unique labels advertised by the piece.' })
        }
        if (edge.label) labels.add(edge.label)
      }
    } else if (node.type === 'decider') {
      const labeled = out.some((edge) => edge.branch !== undefined)
      const validBranches = labeled
        ? out.length === 2 && out.filter((edge) => edge.branch === 'continue').length === 1 && out.filter((edge) => edge.branch === 'stop').length === 1
        : out.length === 2 && out.filter((edge) => nodes.find((candidate) => candidate.id === edge.target)?.type === 'end').length === 1
      if (!validBranches) errors.push({ code: 'INVALID_BRANCH', nodeId: node.id, message: 'A Decider needs exactly one continue branch and one stop branch.' })
      const cont = out.find((edge) => edge.branch === 'continue')
      if (cont && nodes.find((candidate) => candidate.id === cont.target)?.type === 'end') {
        errors.push({ code: 'INVALID_BRANCH', nodeId: node.id, message: 'The continue branch must lead to another step, not End.' })
      }
    } else if (!out.length) {
      errors.push({ code: 'DEAD_END', nodeId: node.id, message: `Node "${node.id}" needs a next step or an End.` })
    } else if (out.length !== 1) {
      errors.push({ code: 'UNSUPPORTED_BRANCHING', nodeId: node.id, message: `Node "${node.id}" has multiple successors; use sequential steps or a Decider with explicit branches.` })
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
  acceptanceCriteria?: string[]
  repositoryIds?: string[]
  id?: number
  /** All ticket ids this run targets (for `{{spec.ids}}` → `#1 #2 #3`). */
  ticketIds?: number[]
  /** Exact specs covered by an all-ticket run, for independent verification. */
  tickets?: Array<{ id: number; title?: string; description?: string; repositoryIds?: string[]; acceptanceCriteria?: string[] }>
  title?: string
  description?: string
  status?: string
  priority?: string | null
  labels?: string[]
  jira_key?: string | null
  jira_url?: string | null
  openspecChangeName?: string
  metadata?: { openspecChangeName?: unknown } & Record<string, unknown>
}

/** Whether a loop "needs a ticket/spec" — it references a `{{spec.*}}` token or a
 *  ticket-consuming command (`{{cmd:implement|batch|freestyle}}`). Ticket-needing
 *  loops belong on a rail (the rail provides the spec). Ticket-LESS loops are
 *  standalone (repo-wide CI watch, lint, audit…) and run from the Loops page's
 *  "Run" action, NOT a rail — launching one on a rail would just re-run the same
 *  spec-less loop once per ticket. Mirrors the client's `loop-ticket-need.ts`. */
const SPEC_TOKEN_RE = /\{\{\s*spec\./
const TICKET_CMD_RE = /\{\{\s*cmd:(implement|batch|freestyle)\b/
export function loopNeedsTicket(graph: LoopGraph | undefined): boolean {
  if (!graph) return false
  for (const node of graph.nodes) {
    if (node.type === 'core' && node.data?.kind === 'implementation') return true
    const text = [node.data?.prompt, node.data?.command, node.data?.goal,
      node.type === 'core' ? JSON.stringify(node.data?.params) : undefined]
      .filter((v) => typeof v === 'string')
      .join('\n')
    if (SPEC_TOKEN_RE.test(text) || TICKET_CMD_RE.test(text)) return true
  }
  if (Object.values(graph.components ?? {}).some(component => loopNeedsTicket(component))) return true
  return false
}

export function interpolateSpec(text: string, spec?: LoopSpec): string {
  return text.replace(/\{\{\s*spec\.(\w+)\s*\}\}/g, (_match, key: string) => {
    if (key === 'scope') {
      if (!spec) return ''
      const changeName = typeof spec.openspecChangeName === 'string' ? spec.openspecChangeName.trim()
        : typeof spec.metadata?.openspecChangeName === 'string' ? spec.metadata.openspecChangeName.trim() : undefined
      // Explicit task data, not arbitrary metadata or injected template code.
      // Preserve all batch descriptions so later fresh verification/repair
      // sessions do not have to reconstruct acceptance scope from short logs.
      const scope = JSON.stringify({
        id: spec.id,
        ticketIds: spec.ticketIds,
        title: spec.title,
        description: spec.description,
        acceptanceCriteria: spec.acceptanceCriteria,
        repositoryIds: spec.repositoryIds,
        openspecChangeName: changeName || undefined,
        tickets: spec.tickets?.map(ticket => ({ id: ticket.id, title: ticket.title, description: ticket.description, acceptanceCriteria: ticket.acceptanceCriteria, repositoryIds: ticket.repositoryIds })),
      }, null, 2)
      if (scope === '{}') return ''
      // Constants/run-vars expand after spec data. Escape their delimiters
      // inside JSON strings, along with the surrounding data block delimiter.
      return scope.replace(/\{\{/g, '\\u007b\\u007b').replace(/\}\}/g, '\\u007d\\u007d').replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    }
    // `{{spec.ids}}` → all rail ticket ids as `#1 #2 #3` (used by implement/batch).
    if (key === 'ids') {
      const ids = spec?.ticketIds ?? (spec?.id != null ? [spec.id] : [])
      return ids.map((id) => `#${id}`).join(' ')
    }
    if (key === 'openspecChangeName') {
      const direct = typeof spec?.openspecChangeName === 'string' ? spec.openspecChangeName.trim() : ''
      const fromMetadata = typeof spec?.metadata?.openspecChangeName === 'string' ? spec.metadata.openspecChangeName.trim() : ''
      return direct || fromMetadata
    }
    if (!['id', 'title', 'description', 'status', 'priority', 'labels', 'jira_key', 'jira_url'].includes(key)) return ''
    const value = spec ? (spec as Record<string, unknown>)[key] : undefined
    if (value == null) return ''
    if (Array.isArray(value)) return value.join(', ')
    return String(value)
  })
}
