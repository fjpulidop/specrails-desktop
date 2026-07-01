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
  created_at: string
  updated_at: string
}

export interface AgentMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
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

export async function getAgentModels(provider: string): Promise<AgentModel[]> {
  return (await json<{ models: AgentModel[] }>(await fetch(`${base}/models?provider=${encodeURIComponent(provider)}`))).models
}

export async function listAgentConversations(): Promise<AgentConversation[]> {
  return (await json<{ conversations: AgentConversation[] }>(await fetch(`${base}/conversations`))).conversations
}

export async function createAgentConversation(input: {
  provider?: string
  model?: string | null
  pinnedProjectId?: string | null
  tierLevel?: AgentTierLevel
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
  patch: Partial<{ title: string | null; provider: string; model: string | null; pinnedProjectId: string | null; tierLevel: AgentTierLevel }>,
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
  opts: { tierLevel?: AgentTierLevel; model?: string } = {},
): Promise<void> {
  await fetch(`${base}/conversations/${id}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, ...opts }),
  })
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
