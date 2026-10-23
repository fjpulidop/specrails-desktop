// ─── Flow HTTP client ─────────────────────────────────────────────────────────
// Project-scoped routes of the server Flow module (server/modules/flow). A
// mission is pinned to ONE project, which may differ from the app's active
// project, so every call names its project explicitly: the base is the same
// `${API_ORIGIN}/api/projects/<id>` that getApiBase() builds for the active one.

import { API_ORIGIN } from '../../../lib/origin'

export type FlowState = 'active' | 'paused' | 'handed_off' | 'delivered' | 'discarded' | 'needs-review'
export type FlowStep = 'start:ticket' | 'start:worktree' | 'start:session' | 'handoff:freeze' | 'handoff:launch'

export interface Flow {
  id: string
  conversationId: string
  ticketId: number | null
  state: FlowState
  branch: string | null
  worktreePath: string | null
  baseSha: string | null
  headSha: string | null
  coreSessionId?: string | null
  railIndex: number | null
  deliveryId: string | null
  step: FlowStep | null
  /** Back to Flow: the review the agent receives on its next turn (absent once delivered). */
  returnBriefing?: string | null
  /** The non-primary repository the Flow runs in (absent ⇒ the primary). */
  repositoryId?: string | null
  createdAt?: string
  updatedAt?: string
}

export type FlowCapability = 'sessions' | 'flowSessions' | 'deriveChange'

/** A project repository as the Flow entry card shows it. */
export interface FlowRepositoryOption {
  id: string
  name: string
  path: string
  isPrimary: boolean
  kind: 'git' | 'folder'
  available?: boolean
}

function isRepositoryOption(value: unknown): value is FlowRepositoryOption {
  const o = value as Record<string, unknown> | null
  return !!o && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.path === 'string' && typeof o.isPrimary === 'boolean' && (o.kind === 'git' || o.kind === 'folder')
}

/**
 * The Git repositories a Flow can run in, and whether the person must see the
 * choice: only a project with several Git repositories, or a folder primary
 * (a workspace), shows it. A single-repository project never does.
 */
export function flowRepositoryChoice(repositories: readonly FlowRepositoryOption[]): { show: boolean; candidates: FlowRepositoryOption[]; fallback: string | null } {
  const candidates = repositories.filter((repository) => repository.kind === 'git' && repository.available !== false)
  const primary = repositories.find((repository) => repository.isPrimary) ?? null
  const show = repositories.length > 1 && (candidates.length > 1 || primary?.kind !== 'git')
  const fallback = primary && primary.kind === 'git' && primary.available !== false ? primary.id : candidates.length === 1 ? candidates[0]!.id : null
  return { show, candidates, fallback }
}

export interface FlowAvailability {
  available: boolean
  reason: string
  missing: FlowCapability[]
}

export interface FlowDiffFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  additions: number | null
  deletions: number | null
}

export interface FlowDiff {
  branch: string | null
  baseSha: string | null
  headSha: string | null
  files: FlowDiffFile[]
  totals: { files: number; additions: number; deletions: number }
}

export interface FlowCost {
  flowId: string
  costUsd: number
  turns: number
  unpricedTurns: number
}

export interface FlowHandOffResult {
  flow: Flow
  loopRunIds: string[]
  deliveryId: string | null
}

/** A refused Flow request: `code` is the server's `error` (e.g. `feature_unavailable`). */
export class FlowApiError extends Error {
  constructor(readonly code: string, readonly status: number, readonly detail?: string, readonly missing?: FlowCapability[], readonly action?: string) {
    super(detail || code)
    this.name = 'FlowApiError'
  }
}

export function flowBase(projectId: string): string {
  return `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/flow`
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  let body: Record<string, unknown> | null = null
  try { body = await res.json() as Record<string, unknown> } catch { body = null }
  if (!res.ok) {
    throw new FlowApiError(
      typeof body?.error === 'string' ? body.error : `http_${res.status}`,
      res.status,
      typeof body?.detail === 'string' ? body.detail : undefined,
      Array.isArray(body?.missing) ? body.missing as FlowCapability[] : undefined,
      typeof body?.action === 'string' ? body.action : undefined,
    )
  }
  return body as T
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
})

export const flowApi = {
  async availability(projectId: string): Promise<FlowAvailability> {
    try {
      return await call<FlowAvailability>(`${flowBase(projectId)}/availability`)
    } catch (error) {
      // The routes answer 409 feature_unavailable when the project has no Flow service.
      if (error instanceof FlowApiError && error.code === 'feature_unavailable') {
        return { available: false, reason: error.detail ?? error.code, missing: error.missing ?? [] }
      }
      throw error
    }
  },
  async byConversation(projectId: string, conversationId: string): Promise<Flow | null> {
    return (await call<{ flow: Flow | null }>(`${flowBase(projectId)}/by-conversation/${encodeURIComponent(conversationId)}`)).flow
  },
  async start(projectId: string, input: { conversationId: string; idea: string; title?: string; repositoryId?: string }): Promise<Flow> {
    return (await call<{ flow: Flow }>(flowBase(projectId), post(input))).flow
  },
  /** The project's repositories (the entry card's target picker). */
  async repositories(projectId: string): Promise<FlowRepositoryOption[]> {
    const body = await call<{ repositories?: unknown }>(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/repositories`)
    return Array.isArray(body.repositories) ? body.repositories.filter(isRepositoryOption) : []
  },
  async pause(projectId: string, flowId: string): Promise<Flow> {
    return (await call<{ flow: Flow }>(`${flowBase(projectId)}/${encodeURIComponent(flowId)}/pause`, post())).flow
  },
  async resume(projectId: string, flowId: string): Promise<Flow> {
    return (await call<{ flow: Flow }>(`${flowBase(projectId)}/${encodeURIComponent(flowId)}/resume`, post())).flow
  },
  async discard(projectId: string, flowId: string): Promise<Flow> {
    return (await call<{ flow: Flow }>(`${flowBase(projectId)}/${encodeURIComponent(flowId)}/discard`, post())).flow
  },
  async handOff(projectId: string, flowId: string, input: { railIndex: number; loopId?: string; aiEngine?: string; model?: string; reasoningEffort?: string }): Promise<FlowHandOffResult> {
    return call<FlowHandOffResult>(`${flowBase(projectId)}/${encodeURIComponent(flowId)}/hand-off`, post(input))
  },
  /** Back to Flow: the stopped Flow → Spec delivery gives the worktree back to its Flow. */
  async returnToFlow(projectId: string, deliveryId: string): Promise<Flow> {
    return (await call<{ flow: Flow }>(`${flowBase(projectId)}/by-delivery/${encodeURIComponent(deliveryId)}/return`, post())).flow
  },
  /** Run Flow → Spec again on the same worktree (same rail and engine choices). */
  async relaunch(projectId: string, deliveryId: string): Promise<FlowHandOffResult> {
    return call<FlowHandOffResult>(`${flowBase(projectId)}/by-delivery/${encodeURIComponent(deliveryId)}/relaunch`, post())
  },
  async diff(projectId: string, flowId: string): Promise<FlowDiff> {
    return call<FlowDiff>(`${flowBase(projectId)}/${encodeURIComponent(flowId)}/diff`)
  },
  async cost(projectId: string, flowId: string): Promise<FlowCost> {
    return call<FlowCost>(`${flowBase(projectId)}/${encodeURIComponent(flowId)}/cost`)
  },
}

/** Open Flows own the conversation's look and the board label. */
export function isOpenFlow(flow: Pick<Flow, 'state'> | null | undefined): boolean {
  return !!flow && (flow.state === 'active' || flow.state === 'paused')
}
