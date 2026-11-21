/** The `usage-limit` system row a mission turn leaves when its provider refused on the usage limit. */
import { API_ORIGIN } from '../../../lib/origin'

export interface UsageLimitRow { kind: 'usage-limit'; provider: string; resumeAt: string | null; message: string; at: string }

export function parseUsageLimitRow(content: string): UsageLimitRow | null {
  try {
    const value = JSON.parse(content) as Partial<UsageLimitRow>
    if (value?.kind !== 'usage-limit' || typeof value.provider !== 'string' || typeof value.at !== 'string') return null
    return { kind: 'usage-limit', provider: value.provider, resumeAt: typeof value.resumeAt === 'string' && Number.isFinite(Date.parse(value.resumeAt)) ? value.resumeAt : null, message: typeof value.message === 'string' ? value.message : '', at: value.at }
  } catch { return null }
}

const base = (conversationId: string) => `${API_ORIGIN}/api/agent/conversations/${encodeURIComponent(conversationId)}/limit-continue`

export async function getLimitContinue(conversationId: string, signal?: AbortSignal): Promise<string | null> {
  const response = await fetch(base(conversationId), { signal })
  if (!response.ok) return null
  const body = await response.json() as { at?: unknown }
  return typeof body.at === 'string' ? body.at : null
}

/** Schedule (or cancel with null) the mission's continue at the reset. */
export async function setLimitContinue(conversationId: string, at: string | null): Promise<string | null> {
  const response = await fetch(base(conversationId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at }) })
  const body = await response.json().catch(() => null) as { at?: unknown; error?: string } | null
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
  return typeof body?.at === 'string' ? body.at : null
}
