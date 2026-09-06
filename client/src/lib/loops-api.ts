/**
 * Loops API client — talks to the GLOBAL (cross-project) loops endpoints at
 * `/api/loops*`. Unlike per-project resources, this does NOT use `getApiBase()`
 * (loops are a global library on the desktop router, not scoped to a project).
 */

export type LoopStatus = 'draft' | 'published'
export type LoopNodeType = 'start' | 'ai-step' | 'shell' | 'decider' | 'condition' | 'end'
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
}

export interface LoopGraph {
  nodes: LoopNode[]
  edges: LoopEdge[]
  config: { maxIterations: number; timeoutMinutes: number; maxCostUsd?: number; layout?: 'vertical' | 'horizontal' | 'grid' | 'manual' }
}

export interface LoopDefinition {
  id: string
  name: string
  description: string | null
  status: LoopStatus
  graph: LoopGraph
  createdAt: string
  updatedAt: string
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

/** A built-in factory loop (locked) — implement / batch / freestyle. */
export interface FactoryLoopSummary {
  id: string
  name: string
  description: string
  /** Legacy rail mode this loop maps to. */
  mode: 'implement' | 'batch-implement' | 'freestyle'
  /** Adapter capability required to execute this factory loop, when any. */
  requiredCapability?: 'freestyle'
  /** Backward-compatible field from older servers. */
  claudeOnly?: boolean
  /**
   * False for a loop the platform runs on its own initiative and the user cannot
   * start by hand. Absent on older servers, which only ever shipped launchable
   * loops — so `!== false` is the correct read.
   */
  launchable?: boolean
  graph: LoopGraph
}

export interface GraphValidationError {
  code: string
  message: string
  nodeId?: string
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
    if (res.status === 422 && body && typeof body === 'object' && 'errors' in body) {
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

export const loopsApi = {
  async list(): Promise<LoopDefinition[]> {
    return (await send<{ loops: LoopDefinition[] }>('GET', '/loops')).loops
  },
  async get(id: string): Promise<LoopDefinition> {
    return (await send<{ loop: LoopDefinition }>('GET', `/loops/${id}`)).loop
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
  async factoryLoops(): Promise<FactoryLoopSummary[]> {
    return (await send<{ factoryLoops: FactoryLoopSummary[] }>('GET', '/loops/factory')).factoryLoops
  },
  /** Magic-command catalog for the builder palette ({ name, label, description }). */
  async loopCommands(): Promise<{ name: string; label: string; description: string }[]> {
    return (await send<{ commands: { name: string; label: string; description: string }[] }>('GET', '/loops/commands')).commands
  },
  async forkFactory(id: string, name?: string): Promise<LoopDefinition> {
    return (await send<{ loop: LoopDefinition }>('POST', `/loops/factory/${id}/fork`, name ? { name } : {})).loop
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
