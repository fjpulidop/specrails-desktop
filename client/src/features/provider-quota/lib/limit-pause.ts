/** A loop run paused on a provider usage limit (server `LoopLimitPause`). */
import { API_ORIGIN } from '../../../lib/origin'

export interface LimitPause {
  providerId: string
  resumeAt: string | null
  autoResume: boolean
  message: string
  pausedAt: string
  switchable: boolean
}

export function readLimitPause(raw: unknown): LimitPause | null {
  const value = raw as Partial<LimitPause> | null
  if (!value || typeof value !== 'object' || typeof value.providerId !== 'string' || typeof value.pausedAt !== 'string') return null
  return {
    providerId: value.providerId,
    resumeAt: typeof value.resumeAt === 'string' && Number.isFinite(Date.parse(value.resumeAt)) ? value.resumeAt : null,
    autoResume: value.autoResume === true,
    message: typeof value.message === 'string' ? value.message : '',
    pausedAt: value.pausedAt,
    switchable: value.switchable === true,
  }
}

export type LimitAction = { action: 'resume' } | { action: 'auto'; enabled: boolean } | { action: 'switch'; provider: string }

export async function answerLimitPause(projectId: string, runId: string, choice: LimitAction): Promise<{ ok: true; limit?: LimitPause | null } | { ok: false; detail: string }> {
  try {
    const response = await fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/loop-runs/${encodeURIComponent(runId)}/limit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(choice),
    })
    const body = await response.json().catch(() => null) as { limit?: unknown; error?: string; detail?: string } | null
    if (!response.ok) return { ok: false, detail: body?.detail ?? body?.error ?? `HTTP ${response.status}` }
    return { ok: true, ...(body && 'limit' in body ? { limit: readLimitPause(body.limit) } : {}) }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}
