/**
 * Loops API client — talks to the GLOBAL (cross-project) loops endpoints at
 * `/api/loops*`. Unlike per-project resources, this does NOT use `getApiBase()`
 * (loops are a global library on the desktop router, not scoped to a project).
 */

export type LoopStatus = 'draft' | 'published'
export type LoopNodeType = 'start' | 'ai-step' | 'shell' | 'decider' | 'condition' | 'core' | 'end'
export type CoreNodeKind = 'prompt' | 'role-turn' | 'decider' | 'condition' | 'assign' | 'verify' | 'shell'
  | 'openspec-validate' | 'openspec-archive' | 'approval' | 'question' | 'gate' | 'map' | 'join'
  | 'component' | 'implementation' | 'end'
export type LoopJoin = 'AND' | 'OR'
/** Which Decider verdict routes down an edge: 'continue' = loop, 'stop' = exit. */
export type LoopBranch = 'continue' | 'stop'

export interface LoopNode {
  id: string
  type: LoopNodeType
  position: { x: number; y: number }
  data?: Record<string, unknown>
}

export interface LoopEdge {
  id: string
  source: string
  target: string
  join?: LoopJoin
  /** Set on edges leaving a `decider` (maps to React Flow `sourceHandle`). */
  branch?: LoopBranch
  label?: string
}

export interface LoopGraph {
  nodes: LoopNode[]
  edges: LoopEdge[]
  config: { maxIterations: number; timeoutMinutes: number; maxCostUsd?: number; maxTokens?: number; maxTransitions?: number;
    journal?: 'ledger-only' | 'implementation'; change?: 'new' | 'existing' | 'none'; reviewerStepId?: string; legacyDeciderRole?: string;
    policies?: { failFast?: number; noProgress?: number; historyMaxChars?: number; concurrency?: number };
    layout?: 'vertical' | 'horizontal' | 'grid' | 'manual' }
  inputs?: string[]
  outputs?: string[]
  components?: Record<string, LoopGraph>
}

export interface LoopDefinition {
  id: string
  name: string
  description: string | null
  status: LoopStatus
  graph: LoopGraph
  createdAt: string
  updatedAt: string
  hasLegacyGraph?: boolean
  /** Canonical factory id when this loop IS an editable built-in (id === builtinId). */
  builtinId?: string
  /** Built-ins only: the content differs from its original default. */
  builtinModified?: boolean
}

export interface LoopTemplateSummary {
  id: string
  name: string
  description: string
  /** Discovery category (one of the server's LOOP_CATEGORIES). Optional on the
   *  wire so older servers / factory-loop previews without a category still type. */
  category?: string
  tags: string[]
  /** Full graph, included so the gallery can render a read-only preview. */
  graph: LoopGraph
}

export interface WorkflowPieceDescriptor {
  kind: CoreNodeKind
  paramsSchema: Record<string, unknown>
  outcomes: string[]
  effect: 'read' | 'write' | 'derived'
  requiresAI: boolean
}
export interface WorkflowCatalog { definitionSchema?: Record<string, unknown>; nodeKindsVersion: number; nodeKinds: WorkflowPieceDescriptor[]; builtins: Array<{ id: string; version: string; deprecated: boolean }> }

export interface GraphValidationError {
  code: string
  message: string
  nodeId?: string
  path?: string
  edgeId?: string
}

/** One resolved step in a dry-run preview (the exact text that would be sent). */
export interface LoopPreviewStep {
  nodeId: string
  kind: string
  label?: string
  text: string
}

/** A global, cross-loop constant. Dragged into steps as `{{const:NAME}}` and
 *  resolved at run time. `builtin` constants are read-only (verify sentinels). */
export interface LoopConstant {
  id: string
  name: string
  value: string
  builtin?: boolean
}

/** Thrown when publish fails validation (HTTP 422). Carries the per-node errors
 *  so the builder can highlight them. */
export class LoopPublishError extends Error {
  readonly errors: GraphValidationError[]
  constructor(errors: GraphValidationError[]) {
    super('Loop graph is invalid')
    this.name = 'LoopPublishError'
    this.errors = errors
  }
}

const BASE = '/api'

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = undefined
    }
    if ((res.status === 422 || res.status === 400) && body && typeof body === 'object' && 'errors' in body) {
      throw new LoopPublishError((body as { errors: GraphValidationError[] }).errors ?? [])
    }
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status})`
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return parse<T>(res)
}

export type LoopMigrationState = 'current' | 'invalid' | 'convertible' | 'needs_attention' | 'running'
export interface LoopMigrationEntry {
  id: string; name: string; status: 'draft' | 'published'; engine: 'legacy' | 'core'; hasLegacyGraph: boolean
  state: LoopMigrationState; issues: Array<{ code: string; message: string; nodeId?: string }>
}
export interface LoopMigrationReport { loops: LoopMigrationEntry[]; summary: Record<LoopMigrationState, number> }

export const loopsApi = {
  async migration(): Promise<LoopMigrationReport> { return send('GET', '/loops/migration') },
  async catalog(): Promise<WorkflowCatalog> { return send('GET', '/loops/catalog') },
  async list(): Promise<LoopDefinition[]> {
    return (await send<{ loops: LoopDefinition[] }>('GET', '/loops')).loops
  },
  async get(id: string): Promise<LoopDefinition> {
    return (await send<{ loop: LoopDefinition }>('GET', `/loops/${id}`)).loop
  },
  async legacyGraph(id: string): Promise<{ graph: LoopGraph; savedAt: string }> {
    return send('GET', `/loops/${encodeURIComponent(id)}/legacy-graph`)
  },
  async convert(id: string, repositoryId?: string): Promise<{ loop: LoopDefinition; nodeIds: Record<string, string>; alreadyConverted?: boolean }> {
    return send('POST', `/loops/${encodeURIComponent(id)}/convert`, { ...(repositoryId ? { repositoryId } : {}) })
  },
  async create(input: { name: string; description?: string; graph?: LoopGraph }): Promise<LoopDefinition> {
    return (await send<{ loop: LoopDefinition }>('POST', '/loops', input)).loop
  },
  async update(
    id: string,
    patch: { name?: string; description?: string | null; graph?: LoopGraph }
  ): Promise<LoopDefinition> {
    return (await send<{ loop: LoopDefinition }>('PUT', `/loops/${id}`, patch)).loop
  },
  async publish(id: string): Promise<LoopDefinition> {
    return (await send<{ loop: LoopDefinition }>('POST', `/loops/${id}/publish`)).loop
  },
  async unpublish(id: string): Promise<LoopDefinition> {
    return (await send<{ loop: LoopDefinition }>('POST', `/loops/${id}/unpublish`)).loop
  },
  async duplicate(id: string, name?: string): Promise<LoopDefinition> {
    return (await send<{ loop: LoopDefinition }>('POST', `/loops/${id}/duplicate`, name ? { name } : {})).loop
  },
  async remove(id: string): Promise<void> {
    const res = await fetch(`${BASE}/loops/${id}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 204) await parse(res)
  },
  async templates(): Promise<LoopTemplateSummary[]> {
    return (await send<{ templates: LoopTemplateSummary[] }>('GET', '/loop-templates')).templates
  },
  async fromTemplate(templateId: string, name?: string): Promise<LoopDefinition> {
    return (
      await send<{ loop: LoopDefinition }>('POST', `/loops/from-template/${templateId}`, name ? { name } : {})
    ).loop
  },
  /** Magic-command catalog for the builder palette ({ name, label, description }). */
  async loopCommands(): Promise<{ name: string; label: string; description: string }[]> {
    return (await send<{ commands: { name: string; label: string; description: string }[] }>('GET', '/loops/commands')).commands
  },
  /** Reset a built-in loop to its original default (Published). */
  async restoreBuiltin(id: string): Promise<LoopDefinition> {
    return (await send<{ loop: LoopDefinition }>('POST', `/loops/${encodeURIComponent(id)}/restore-builtin`)).loop
  },
  // ── Constants library (global) ──────────────────────────────────────────────
  async loopConstants(): Promise<LoopConstant[]> {
    return (await send<{ constants: LoopConstant[] }>('GET', '/loops/constants')).constants
  },
  async createConstant(name: string, value: string): Promise<LoopConstant> {
    return (await send<{ constant: LoopConstant }>('POST', '/loops/constants', { name, value })).constant
  },
  async updateConstant(id: string, value: string): Promise<LoopConstant> {
    return (await send<{ constant: LoopConstant }>('PUT', `/loops/constants/${id}`, { value })).constant
  },
  async deleteConstant(id: string): Promise<void> {
    await send('DELETE', `/loops/constants/${id}`)
  },
  /** Import loops from an export envelope; duplicate NAMES are skipped server-side. */
  async importLoops(loops: Array<{ name: string; description?: string | null; graph: LoopGraph }>): Promise<{ imported: Array<{ id: string; name: string }>; skipped: string[] }> {
    return send('POST', '/loops/import', { loops })
  },
  /** Dry-run: resolve each step's tokens (no spawn) for the given (unsaved) graph. */
  async previewLoop(graph: LoopGraph, provider?: string): Promise<{ steps: LoopPreviewStep[] }> {
    return send('POST', '/loops/preview', { graph, provider })
  },
  /** Launch a ticket-less loop standalone against a specific project (no rail). */
  async runStandalone(
    projectId: string,
    loopId: string,
    opts: { repositoryIds?: string[]; aiEngine?: string; model?: string; reasoning_effort?: string } = {}
  ): Promise<{ loopRunId: string }> {
    const res = await fetch(`/api/projects/${projectId}/loop-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loopId, ...opts }),
    })
    return parse(res)
  },
}
