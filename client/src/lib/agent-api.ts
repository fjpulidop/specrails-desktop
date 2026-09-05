import { API_ORIGIN } from './origin'
import { coerceRailPrStateSnapshot } from './pr-delivery'
import type {
  RailDeliveryOutcome,
  RailImplementationOutcome,
  RailPrStateSnapshot,
  RailPrUnitOutcome,
} from '../types'

// App-level (NOT per-project) client for the global agent chat. The global fetch
// patch (lib/auth) attaches the desktop token automatically for localhost.

export type AgentTierLevel = 0 | 1 | 2 | 3
export const AGENT_TIER_NAMES = ['observe', 'edit', 'operate', 'autonomous'] as const
export type AgentTierName = (typeof AGENT_TIER_NAMES)[number]

export interface AgentConversation {
  id: string
  title: string | null
  provider: string
  model: string | null
  session_id: string | null
  pinned_project_id: string | null
  tier_level: AgentTierLevel
  /** Reasoning effort for spawns; null = no provider-specific override. */
  reasoning_effort: string | null
  created_at: string
  updated_at: string
}

export interface AgentMessage {
  id: string
  conversation_id: string
  /** `system` rows are app-authored inline cards (e.g. the PR-decision card). */
  role: 'user' | 'assistant' | 'system'
  content: string
  attachment_ids?: string[]
  context_refs?: AgentContextReference[]
  created_at: string
}

export interface AgentAttachment {
  id: string
  filename: string
  storedName: string
  mimeType: string
  size: number
  addedAt: string
}

export interface AgentContextReference {
  kind: string
  id: string
  label: string
  token: string
  scope?: {
    projectId?: string | null
    projectName?: string | null
  }
  status?: string | null
  metadata?: Record<string, unknown>
}

const base = `${API_ORIGIN}/api/agent`

async function json<T>(res: Response): Promise<T> {
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
  return data as T
}

export interface AgentModel {
  value: string
  label: string
  default?: boolean
}

export interface AgentModelsResponse {
  models: AgentModel[]
  /** Provider accepts safe aliases configured outside SpecRails. */
  customModelAliases: boolean
  /** Composer gates the image affordance on this capability (design D22). */
  supportsImageInput: boolean
  /** Provider's reasoning-effort tiers, ascending. Empty ⇒ no selector (gemini). */
  efforts: string[]
}

export async function getAgentModels(provider: string): Promise<AgentModelsResponse> {
  const data = await json<{
    models: AgentModel[]
    customModelAliases?: boolean
    supportsImageInput?: boolean
    efforts?: string[]
  }>(
    await fetch(`${base}/models?provider=${encodeURIComponent(provider)}`),
  )
  return {
    models: data.models,
    customModelAliases: data.customModelAliases === true,
    supportsImageInput: data.supportsImageInput !== false,
    efforts: Array.isArray(data.efforts) ? data.efforts : [],
  }
}

export async function listAgentConversations(): Promise<AgentConversation[]> {
  return (await json<{ conversations: AgentConversation[] }>(await fetch(`${base}/conversations`))).conversations
}

// ─── Mission search (search-missions-in-palette) ──────────────────────────────

/** A highlighted excerpt: plain text plus `[start, end)` ranges to mark. The
 *  server never sends HTML — the palette renders the marks itself. */
export interface MissionSearchSnippet {
  text: string
  ranges: Array<[number, number]>
}

export interface MissionSearchHit {
  conversation: AgentConversation
  /** Title hits rank first; a mission matching both keeps `'title'` and still
   *  carries the content snippet. */
  match: 'title' | 'content'
  messageId: string | null
  snippet: MissionSearchSnippet | null
}

/** Full-text search over missions (title + user/assistant content). Pass an
 *  `AbortSignal` so a superseded keystroke can cancel its request. */
export async function searchMissions(q: string, limit = 20, signal?: AbortSignal): Promise<MissionSearchHit[]> {
  const params = new URLSearchParams({ q, limit: String(limit) })
  return (await json<{ results: MissionSearchHit[] }>(await fetch(`${base}/search?${params.toString()}`, { signal }))).results
}

export interface AgentActiveTurnsSnapshot {
  snapshotVersion: number
  capturedAt: string
  turns: Array<{ conversationId: string; startedAt: string }>
}

export async function getAgentActiveTurns(): Promise<AgentActiveTurnsSnapshot> {
  return json(await fetch(`${base}/active-turns`))
}

export async function createAgentConversation(input: {
  provider?: string
  model?: string | null
  pinnedProjectId?: string | null
  tierLevel?: AgentTierLevel
  reasoningEffort?: string | null
}): Promise<AgentConversation> {
  const res = await fetch(`${base}/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  return (await json<{ conversation: AgentConversation }>(res)).conversation
}

export async function getAgentConversation(
  id: string,
): Promise<{ conversation: AgentConversation; messages: AgentMessage[] }> {
  return json(await fetch(`${base}/conversations/${id}`))
}

export async function patchAgentConversation(
  id: string,
  patch: Partial<{ title: string | null; provider: string; model: string | null; pinnedProjectId: string | null; tierLevel: AgentTierLevel; reasoningEffort: string | null }>,
): Promise<AgentConversation> {
  const res = await fetch(`${base}/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return (await json<{ conversation: AgentConversation }>(res)).conversation
}

export async function deleteAgentConversation(id: string): Promise<void> {
  await fetch(`${base}/conversations/${id}`, { method: 'DELETE' })
}

export async function sendAgentMessage(
  id: string,
  text: string,
  opts: {
    tierLevel?: AgentTierLevel
    model?: string
    attachments?: { ids: string[] }
    queueId?: string
    contextRefs?: AgentContextReference[]
  } = {},
): Promise<{ queued: boolean }> {
  // Through json() so a non-OK response (400/404) throws — the caller resets its
  // streaming state instead of waiting for WS events that will never arrive.
  const body = await json<{ accepted: boolean; queued?: boolean } | null>(await fetch(`${base}/conversations/${id}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, ...opts }),
  }))
  return { queued: body?.queued === true }
}

export async function uploadAgentAttachment(conversationId: string, file: File): Promise<AgentAttachment> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${base}/conversations/${conversationId}/attachments`, { method: 'POST', body: form })
  return (await json<{ attachment: AgentAttachment }>(res)).attachment
}

export async function listAgentAttachments(conversationId: string): Promise<AgentAttachment[]> {
  const res = await fetch(`${base}/conversations/${conversationId}/attachments`)
  return (await json<{ attachments: AgentAttachment[] }>(res)).attachments
}

export function agentAttachmentFileUrl(conversationId: string, attachmentId: string): string {
  return `${base}/conversations/${conversationId}/attachments/${attachmentId}`
}

export async function fetchAgentAttachmentBlob(conversationId: string, attachmentId: string): Promise<Blob> {
  const res = await fetch(agentAttachmentFileUrl(conversationId, attachmentId))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.blob()
}

export async function deleteAgentAttachment(conversationId: string, attachmentId: string): Promise<void> {
  await fetch(`${base}/conversations/${conversationId}/attachments/${attachmentId}`, { method: 'DELETE' })
}

export async function abortAgentTurn(id: string): Promise<void> {
  await fetch(`${base}/conversations/${id}/abort`, { method: 'POST' })
}

/**
 * Edit a still-queued message in place (composer ↑/↓ queue navigation).
 * `'conflict'` = the queue already dispatched it (server 409) — the caller
 * keeps the user's text as a draft. Other failures throw.
 */
export async function editQueuedAgentMessage(
  conversationId: string,
  queueId: string,
  text: string,
): Promise<'saved' | 'conflict'> {
  const res = await fetch(`${base}/conversations/${conversationId}/queue/${encodeURIComponent(queueId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (res.status === 409) return 'conflict'
  await json<{ ok: boolean }>(res)
  return 'saved'
}

// ── PR-decision card (safe-pr-review-flow) ────────────────────────────────────
// A rail launched from an agent conversation posts a `system`-role row whose
// content is this JSON envelope; the server updates the SAME row in place on
// every decision transition and mirrors it over the app-global
// `agent_pr_decision` WS event.

export type AgentPrDecisionValue =
  | 'building' | 'on_review' | 'pr_draft' | 'pr_ready' | 'no_changes' | 'completed' | 'pr_closed' | 'superseded'
  | 'merged' | 'discarded' | 'implementation_failed' | 'pr_failed'

export type AgentPrDeliveryState = 'none' | 'local-only' | 'pushed' | 'pr-created'

const PR_DECISION_VALUES: readonly string[] =
  ['building', 'on_review', 'pr_draft', 'pr_ready', 'no_changes', 'completed', 'pr_closed', 'superseded', 'merged', 'discarded', 'implementation_failed', 'pr_failed']
const PR_DELIVERY_STATES: readonly string[] = ['none', 'local-only', 'pushed', 'pr-created']

/** Parsed content of a `system` pr_decision row (mirrors the server envelope). */
export interface AgentPrDecisionEnvelope {
  kind: 'pr_decision'
  prDeliveryId: string
  railIndex: number
  projectId: string
  baseBranch: string
  ticketIds: number[]
  decision: AgentPrDecisionValue
  prUrl: string | null
  prNumber: number | null
  prState: AgentPrDeliveryState
  branch: string | null
  /** The launch's loop-run ids, in ticket order ([] until allocation lands, and
   *  for rows persisted before the column existed) — one "View log" chip each. */
  runIds: string[]
  implementationOutcome?: RailImplementationOutcome
  deliveryOutcome?: RailDeliveryOutcome
  statusCode?: string | null
  statusDetail?: string | null
  deliverySha?: string | null
  isContinuation?: boolean
  supersedesDeliveryId?: string | null
  restoredFromDeliveryId?: string | null
  operation?: AgentPrDecisionAction | null
  cleanupWarnings?: string[]
  safetyArchives?: string[]
  units?: RailPrUnitOutcome[]
  createdAt?: string
  updatedAt?: string
}

/**
 * Defensive coercion of an untyped object (a parsed system row OR the WS
 * `agent_pr_decision` message, which carries the envelope's fields top-level).
 * Returns null for foreign/malformed payloads — callers render nothing.
 */
export function coercePrDecisionEnvelope(v: unknown): AgentPrDecisionEnvelope | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.kind !== 'pr_decision') return null
  if (typeof o.prDeliveryId !== 'string' || !o.prDeliveryId) return null
  if (typeof o.railIndex !== 'number' || !Number.isFinite(o.railIndex)) return null
  if (typeof o.projectId !== 'string' || !o.projectId) return null
  if (typeof o.baseBranch !== 'string') return null
  if (typeof o.decision !== 'string' || !PR_DECISION_VALUES.includes(o.decision)) return null
  const snapshot = coerceRailPrStateSnapshot({ ...o, prDeliveryId: o.prDeliveryId }, o.railIndex)
  if (!snapshot) return null
  return {
    kind: 'pr_decision',
    prDeliveryId: o.prDeliveryId,
    railIndex: o.railIndex,
    projectId: o.projectId,
    baseBranch: o.baseBranch,
    ticketIds: snapshot.ticketIds,
    decision: o.decision as AgentPrDecisionValue,
    prUrl: typeof o.prUrl === 'string' && o.prUrl ? o.prUrl : null,
    prNumber: typeof o.prNumber === 'number' && Number.isInteger(o.prNumber) && o.prNumber > 0
      ? o.prNumber
      : null,
    prState: typeof o.prState === 'string' && PR_DELIVERY_STATES.includes(o.prState)
      ? (o.prState as AgentPrDeliveryState)
      : 'none',
    branch: typeof o.branch === 'string' && o.branch ? o.branch : null,
    // Pre-runIds persisted cards (and mid-build inserts) default to [] — the
    // card simply renders no run chips.
    runIds: snapshot.runIds,
    implementationOutcome: snapshot.implementationOutcome,
    deliveryOutcome: snapshot.deliveryOutcome,
    statusCode: snapshot.statusCode,
    statusDetail: snapshot.statusDetail,
    deliverySha: snapshot.deliverySha,
    isContinuation: snapshot.isContinuation,
    supersedesDeliveryId: snapshot.supersedesDeliveryId,
    restoredFromDeliveryId: snapshot.restoredFromDeliveryId,
    operation: snapshot.operation,
    cleanupWarnings: snapshot.cleanupWarnings,
    safetyArchives: snapshot.safetyArchives,
    units: snapshot.units,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  }
}

/** Parse a persisted system row's content string; null when not a pr_decision card. */
export function parsePrDecisionEnvelope(content: string): AgentPrDecisionEnvelope | null {
  try {
    return coercePrDecisionEnvelope(JSON.parse(content))
  } catch {
    return null
  }
}

export type AgentPrDecisionAction = 'create-pr' | 'publish' | 'discard' | 'poll-merge' | 'merge-local' | 'dismiss' | 'reopen' | 'acknowledge-no-changes' | 'recover-and-retry'

const PR_DECISION_ACTION_VALUES: readonly AgentPrDecisionAction[] = [
  'create-pr', 'publish', 'discard', 'poll-merge', 'merge-local', 'dismiss', 'reopen', 'acknowledge-no-changes', 'recover-and-retry',
]

export type AgentPrDecisionOutcome =
  | {
      kind: 'ok'
      decision: string
      prUrl: string | null
      prState: AgentPrDeliveryState
      merged: boolean
      detail: string | null
      deliveryVerified: boolean | null
      verifiedSha: string | null
      remoteHeadSha: string | null
      pushed: boolean | null
      recoveryUnavailable: boolean
      snapshot: RailPrStateSnapshot | null
    }
  /** Startup reconciliation owns the project; no decision effect was run. */
  | { kind: 'recovering'; snapshot: RailPrStateSnapshot | null }
  /** Decision changed before this request; the authoritative snapshot reconciles. */
  | { kind: 'stale'; current: string; snapshot: RailPrStateSnapshot | null }
  /** Another surface owns the durable operation lease; snapshot disables actions. */
  | { kind: 'busy'; operation: AgentPrDecisionAction | null; snapshot: RailPrStateSnapshot | null }
  /** merge-local precondition failed — USER-fixable (checkout base / clean tree). */
  | { kind: 'blocked'; reason: 'wrong_branch' | 'dirty'; base: string; current: string | null; snapshot: RailPrStateSnapshot | null }
  | { kind: 'failed'; detail: string; snapshot: RailPrStateSnapshot | null }

/**
 * POST the user's decision to the CARD's project. The agent chat is app-global,
 * so this deliberately builds the project base from the envelope's `projectId`
 * (the raw `${API_ORIGIN}/api/projects/…` precedent — TerminalsContext) and
 * NEVER via getApiBase(), which is bound to the ACTIVE project. Never throws on
 * HTTP errors — outcomes are discriminated for the card's UX branches.
 */
export async function postRailPrDecision(
  projectId: string,
  body: { prDeliveryId: string; action: AgentPrDecisionAction; expectedDecision: AgentPrDecisionValue },
): Promise<AgentPrDecisionOutcome> {
  const res = await fetch(`${API_ORIGIN}/api/projects/${projectId}/rails/pr-decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data: Record<string, unknown> | null = null
  try {
    const text = await res.text()
    data = text ? (JSON.parse(text) as Record<string, unknown>) : null
  } catch {
    data = null
  }
  if (res.ok) {
    const snapshot = coerceRailPrStateSnapshot(data?.snapshot)
    return {
      kind: 'ok',
      decision: typeof data?.decision === 'string' ? data.decision : snapshot?.decision ?? body.expectedDecision,
      prUrl: typeof data?.prUrl === 'string' ? data.prUrl : snapshot?.prUrl ?? null,
      prState: typeof data?.prState === 'string' && PR_DELIVERY_STATES.includes(data.prState)
        ? data.prState as AgentPrDeliveryState
        : snapshot?.prState ?? 'none',
      merged: data?.merged === true,
      detail: typeof data?.detail === 'string' && data.detail ? data.detail : null,
      deliveryVerified: typeof data?.deliveryVerified === 'boolean' ? data.deliveryVerified : null,
      verifiedSha: typeof data?.verifiedSha === 'string' ? data.verifiedSha : null,
      remoteHeadSha: typeof data?.remoteHeadSha === 'string' ? data.remoteHeadSha : null,
      pushed: typeof data?.pushed === 'boolean' ? data.pushed : null,
      recoveryUnavailable: data?.recoveryUnavailable === true,
      snapshot,
    }
  }
  if (res.status === 409) {
    if (data?.error === 'project_recovery_in_progress') {
      return { kind: 'recovering', snapshot: coerceRailPrStateSnapshot(data?.snapshot) }
    }
    if (data?.error === 'operation_in_progress') {
      const snapshot = coerceRailPrStateSnapshot(data?.snapshot)
      const rawOperation = snapshot?.operation ?? data?.operation
      return {
        kind: 'busy',
        operation: typeof rawOperation === 'string' && PR_DECISION_ACTION_VALUES.includes(rawOperation as AgentPrDecisionAction)
          ? rawOperation as AgentPrDecisionAction
          : null,
        snapshot,
      }
    }
    if (data?.error === 'merge_local_blocked') {
      return {
        kind: 'blocked',
        reason: data?.reason === 'dirty' ? 'dirty' : 'wrong_branch',
        base: String(data?.base ?? ''),
        current: typeof data?.current === 'string' ? data.current : null,
        snapshot: coerceRailPrStateSnapshot(data?.snapshot),
      }
    }
    return { kind: 'stale', current: String(data?.current ?? ''), snapshot: coerceRailPrStateSnapshot(data?.snapshot) }
  }
  return {
    kind: 'failed',
    detail: String(data?.detail ?? data?.error ?? `HTTP ${res.status}`),
    snapshot: coerceRailPrStateSnapshot(data?.snapshot),
  }
}

/** Merge a project-scoped authoritative rail snapshot into an agent card. */
export function agentEnvelopeFromSnapshot(
  previous: AgentPrDecisionEnvelope,
  snapshot: RailPrStateSnapshot,
): AgentPrDecisionEnvelope {
  return {
    ...previous,
    prDeliveryId: snapshot.prDeliveryId,
    railIndex: snapshot.railIndex,
    baseBranch: snapshot.baseBranch,
    ticketIds: snapshot.ticketIds,
    decision: snapshot.decision,
    prUrl: snapshot.prUrl,
    prNumber: snapshot.prNumber,
    prState: snapshot.prState,
    branch: snapshot.branch,
    runIds: snapshot.runIds,
    implementationOutcome: snapshot.implementationOutcome,
    deliveryOutcome: snapshot.deliveryOutcome,
    statusCode: snapshot.statusCode,
    statusDetail: snapshot.statusDetail,
    deliverySha: snapshot.deliverySha,
    isContinuation: snapshot.isContinuation,
    supersedesDeliveryId: snapshot.supersedesDeliveryId,
    restoredFromDeliveryId: snapshot.restoredFromDeliveryId,
    operation: snapshot.operation,
    cleanupWarnings: snapshot.cleanupWarnings,
    safetyArchives: snapshot.safetyArchives,
    units: snapshot.units,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  }
}

export type AgentPrCheckoutOutcome =
  | { kind: 'ok' }
  | { kind: 'recovering' }
  | { kind: 'failed'; error: string; detail: string }

export async function postRailPrCheckout(projectId: string, prDeliveryId: string): Promise<AgentPrCheckoutOutcome> {
  const res = await fetch(`${API_ORIGIN}/api/projects/${projectId}/rails/pr-checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prDeliveryId }),
  })
  let data: Record<string, unknown> | null = null
  try {
    const text = await res.text()
    data = text ? (JSON.parse(text) as Record<string, unknown>) : null
  } catch {
    data = null
  }
  if (res.ok) return { kind: 'ok' }
  if (res.status === 409 && data?.error === 'project_recovery_in_progress') return { kind: 'recovering' }
  return {
    kind: 'failed',
    error: String(data?.error ?? `http_${res.status}`),
    detail: String(data?.detail ?? data?.error ?? `HTTP ${res.status}`),
  }
}

// ── Provider availability (no AI CLI installed → degraded banner) ─────────────
export async function getAvailableProviders(): Promise<{ any: boolean; installed: string[] }> {
  const data = await json<Record<string, unknown>>(await fetch(`${API_ORIGIN}/api/available-providers`))
  const installed = Object.entries(data)
    .filter(([k, v]) => k !== 'tiers' && v === true)
    .map(([k]) => k)
  return { any: installed.length > 0, installed }
}

// ── MCP enable (degraded banner) ──────────────────────────────────────────────
export async function getMcpStatus(): Promise<{ enabled: boolean; running: boolean }> {
  return json(await fetch(`${API_ORIGIN}/api/mcp-admin/status`))
}
export async function enableMcp(): Promise<void> {
  await fetch(`${API_ORIGIN}/api/mcp-admin/enable`, { method: 'POST' })
}
