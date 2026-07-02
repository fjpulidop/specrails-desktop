import { API_ORIGIN } from './origin'

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
  /** Reasoning effort for spawns; null = app default ("medium"). */
  reasoning_effort: string | null
  created_at: string
  updated_at: string
}

export interface AgentMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  attachment_ids?: string[]
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
  /** Composer gates the image affordance on this capability (design D22). */
  supportsImageInput: boolean
  /** Provider's reasoning-effort tiers, ascending. Empty ⇒ no selector (gemini). */
  efforts: string[]
}

export async function getAgentModels(provider: string): Promise<AgentModelsResponse> {
  const data = await json<{ models: AgentModel[]; supportsImageInput?: boolean; efforts?: string[] }>(
    await fetch(`${base}/models?provider=${encodeURIComponent(provider)}`),
  )
  return {
    models: data.models,
    supportsImageInput: data.supportsImageInput !== false,
    efforts: Array.isArray(data.efforts) ? data.efforts : [],
  }
}

export async function listAgentConversations(): Promise<AgentConversation[]> {
  return (await json<{ conversations: AgentConversation[] }>(await fetch(`${base}/conversations`))).conversations
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
  opts: { tierLevel?: AgentTierLevel; model?: string; attachments?: { ids: string[] }; queueId?: string } = {},
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

export async function deleteAgentAttachment(conversationId: string, attachmentId: string): Promise<void> {
  await fetch(`${base}/conversations/${conversationId}/attachments/${attachmentId}`, { method: 'DELETE' })
}

export async function abortAgentTurn(id: string): Promise<void> {
  await fetch(`${base}/conversations/${id}/abort`, { method: 'POST' })
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
