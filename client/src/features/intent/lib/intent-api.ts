// ─── Intent HTTP client ─────────────────────────────────────────────────────────
// Project-scoped routes of the server Intent module (server/modules/flow). A
// mission is pinned to ONE project, which may differ from the app's active
// project, so every call names its project explicitly: the base is the same
// `${API_ORIGIN}/api/projects/<id>` that getApiBase() builds for the active one.

import { API_ORIGIN } from '../../../lib/origin'

/** `closed`: a needs-review Intent the person ended keeping its branch (terminal). */
export type IntentState = 'active' | 'paused' | 'handed_off' | 'delivered' | 'discarded' | 'closed' | 'needs-review'
export type IntentStep = 'start:ticket' | 'start:worktree' | 'start:session' | 'handoff:freeze' | 'handoff:launch'

export interface IntentSession {
  id: string
  conversationId: string
  ticketId: number | null
  state: IntentState
  branch: string | null
  worktreePath: string | null
  baseSha: string | null
  headSha: string | null
  coreSessionId?: string | null
  railIndex: number | null
  deliveryId: string | null
  step: IntentStep | null
  /** Back to Intent: the review the agent receives on its next turn (absent once delivered). */
  returnBriefing?: string | null
  /** The non-primary repository the Intent runs in (absent ⇒ the primary). */
  repositoryId?: string | null
  /** `existing`: started from the person's own spec (absent ⇒ its placeholder spec). */
  specOrigin?: 'placeholder' | 'existing'
  createdAt?: string
  updatedAt?: string
}

/** A conversation in Intent mode (GET /flow/open). */
export interface IntentOpenEntry {
  id: string
  conversationId: string
  state: IntentState
  branch: string | null
}

export type IntentCapability = 'sessions' | 'flowSessions' | 'deriveChange'

/** A project repository as the Intent entry card shows it. */
export interface IntentRepositoryOption {
  id: string
  name: string
  path: string
  isPrimary: boolean
  kind: 'git' | 'folder'
  available?: boolean
}

function isRepositoryOption(value: unknown): value is IntentRepositoryOption {
  const o = value as Record<string, unknown> | null
  return !!o && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.path === 'string' && typeof o.isPrimary === 'boolean' && (o.kind === 'git' || o.kind === 'folder')
}

/**
 * The Git repositories an Intent session can run in, and whether the person must see the
 * choice: only a project with several Git repositories, or a folder primary
 * (a workspace), shows it. A single-repository project never does.
 */
export function flowRepositoryChoice(repositories: readonly IntentRepositoryOption[]): { show: boolean; candidates: IntentRepositoryOption[]; fallback: string | null } {
  const candidates = repositories.filter((repository) => repository.kind === 'git' && repository.available !== false)
  const primary = repositories.find((repository) => repository.isPrimary) ?? null
  const show = repositories.length > 1 && (candidates.length > 1 || primary?.kind !== 'git')
  const fallback = primary && primary.kind === 'git' && primary.available !== false ? primary.id : candidates.length === 1 ? candidates[0]!.id : null
  return { show, candidates, fallback }
}

export interface IntentAvailability {
  available: boolean
  reason: string
  missing: IntentCapability[]
}

export interface IntentDiffFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  additions: number | null
  deletions: number | null
}

export interface IntentDiff {
  branch: string | null
  baseSha: string | null
  headSha: string | null
  files: IntentDiffFile[]
  totals: { files: number; additions: number; deletions: number }
}

export interface IntentCost {
  flowId: string
  costUsd: number
  turns: number
  unpricedTurns: number
}

export interface IntentHandOffResult {
  flow: IntentSession
  loopRunIds: string[]
  deliveryId: string | null
}

/** A refused Intent request: `code` is the server's `error` (e.g. `feature_unavailable`). */
export class IntentApiError extends Error {
  constructor(readonly code: string, readonly status: number, readonly detail?: string, readonly missing?: IntentCapability[], readonly action?: string) {
    super(detail || code)
    this.name = 'IntentApiError'
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
    throw new IntentApiError(
      typeof body?.error === 'string' ? body.error : `http_${res.status}`,
      res.status,
      typeof body?.detail === 'string' ? body.detail : undefined,
      Array.isArray(body?.missing) ? body.missing as IntentCapability[] : undefined,
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
  async availability(projectId: string): Promise<IntentAvailability> {
    try {
      return await call<IntentAvailability>(`${flowBase(projectId)}/availability`)
    } catch (error) {
      // The routes answer 409 feature_unavailable when the project has no Intent service.
      if (error instanceof IntentApiError && error.code === 'feature_unavailable') {
        return { available: false, reason: error.detail ?? error.code, missing: error.missing ?? [] }
      }
      throw error
    }
  },
  async byConversation(projectId: string, conversationId: string): Promise<IntentSession | null> {
    return (await call<{ flow: IntentSession | null }>(`${flowBase(projectId)}/by-conversation/${encodeURIComponent(conversationId)}`)).flow
  },
  /** `ticketId`: start from that existing spec (the idea is then optional). */
  async start(projectId: string, input: { conversationId: string; idea: string; title?: string; repositoryId?: string; ticketId?: number }): Promise<IntentSession> {
    return (await call<{ flow: IntentSession }>(flowBase(projectId), post(input))).flow
  },
  /** The project's repositories (the entry card's target picker). */
  /** The project's conversations in Intent mode (the mission list's mark). */
  async open(projectId: string): Promise<IntentOpenEntry[]> {
    const body = await call<{ flows?: IntentOpenEntry[] }>(`${flowBase(projectId)}/open`)
    return Array.isArray(body.flows) ? body.flows.filter((entry) => typeof entry?.conversationId === 'string') : []
  },
  async repositories(projectId: string): Promise<IntentRepositoryOption[]> {
    const body = await call<{ repositories?: unknown }>(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/repositories`)
    return Array.isArray(body.repositories) ? body.repositories.filter(isRepositoryOption) : []
  },
  async pause(projectId: string, flowId: string): Promise<IntentSession> {
    return (await call<{ flow: IntentSession }>(`${flowBase(projectId)}/${encodeURIComponent(flowId)}/pause`, post())).flow
  },
  async resume(projectId: string, flowId: string): Promise<IntentSession> {
    return (await call<{ flow: IntentSession }>(`${flowBase(projectId)}/${encodeURIComponent(flowId)}/resume`, post())).flow
  },
  async discard(projectId: string, flowId: string): Promise<IntentSession> {
    return (await call<{ flow: IntentSession }>(`${flowBase(projectId)}/${encodeURIComponent(flowId)}/discard`, post())).flow
  },
  /** Close a needs-review Intent keeping its branch (nothing is deleted). */
  async close(projectId: string, flowId: string): Promise<IntentSession> {
    return (await call<{ flow: IntentSession }>(`${flowBase(projectId)}/${encodeURIComponent(flowId)}/close`, post())).flow
  },
  async handOff(projectId: string, flowId: string, input: { railIndex: number; loopId?: string; aiEngine?: string; model?: string; reasoningEffort?: string }): Promise<IntentHandOffResult> {
    return call<IntentHandOffResult>(`${flowBase(projectId)}/${encodeURIComponent(flowId)}/hand-off`, post(input))
  },
  /** Back to Intent: the stopped Intent → Spec delivery gives the worktree back to its Intent. */
  async returnToFlow(projectId: string, deliveryId: string): Promise<IntentSession> {
    return (await call<{ flow: IntentSession }>(`${flowBase(projectId)}/by-delivery/${encodeURIComponent(deliveryId)}/return`, post())).flow
  },
  /** Run Intent → Spec again on the same worktree (same rail and engine choices). */
  async relaunch(projectId: string, deliveryId: string): Promise<IntentHandOffResult> {
    return call<IntentHandOffResult>(`${flowBase(projectId)}/by-delivery/${encodeURIComponent(deliveryId)}/relaunch`, post())
  },
  async diff(projectId: string, flowId: string): Promise<IntentDiff> {
    return call<IntentDiff>(`${flowBase(projectId)}/${encodeURIComponent(flowId)}/diff`)
  },
  async cost(projectId: string, flowId: string): Promise<IntentCost> {
    return call<IntentCost>(`${flowBase(projectId)}/${encodeURIComponent(flowId)}/cost`)
  },
}

/** Open Flows own the conversation's look and the board label. */
export function isOpenFlow(flow: Pick<IntentSession, 'state'> | null | undefined): boolean {
  return !!flow && (flow.state === 'active' || flow.state === 'paused')
}
