import { API_ORIGIN } from './origin'

/**
 * Restart continuity (server: modules/continuity). App-level, never project
 * scoped. Shared by the update card (is anything running?) and the
 * "pick up where you left off" dialog.
 */

export type InterruptTrigger = 'quit' | 'update' | 'crash'

export interface ResumeOffer {
  conversationId: string
  title: string | null
  startedAt: string
  stoppedAt: string
  provider: string | null
  trigger: InterruptTrigger
}

export interface ActiveWork {
  missions: number
  runs: number
  total: number
}

function isTrigger(value: unknown): value is InterruptTrigger {
  return value === 'quit' || value === 'update' || value === 'crash'
}

/** A rail/loop run the last restart interrupted (matched to its Inbox item and Resume action). */
export interface InterruptedRun {
  projectId: string
  runId: string
}

export interface ResumeOffers {
  offers: ResumeOffer[]
  runs: InterruptedRun[]
  bootedAt: string | null
}

export function readResumeOffers(body: unknown): ResumeOffers {
  const value = (body ?? {}) as { offers?: unknown; runs?: unknown; bootedAt?: unknown }
  const offers = Array.isArray(value.offers) ? value.offers : []
  const runs = Array.isArray(value.runs) ? value.runs : []
  return {
    bootedAt: typeof value.bootedAt === 'string' ? value.bootedAt : null,
    runs: runs.flatMap((raw): InterruptedRun[] => {
      const r = (raw ?? {}) as Record<string, unknown>
      return typeof r.projectId === 'string' && typeof r.runId === 'string' ? [{ projectId: r.projectId, runId: r.runId }] : []
    }),
    offers: offers.flatMap((raw): ResumeOffer[] => {
      const o = (raw ?? {}) as Record<string, unknown>
      if (typeof o.conversationId !== 'string' || typeof o.startedAt !== 'string' || !isTrigger(o.trigger)) return []
      return [{
        conversationId: o.conversationId,
        title: typeof o.title === 'string' && o.title.trim() ? o.title : null,
        startedAt: o.startedAt,
        stoppedAt: typeof o.stoppedAt === 'string' ? o.stoppedAt : o.startedAt,
        provider: typeof o.provider === 'string' ? o.provider : null,
        trigger: o.trigger,
      }]
    }),
  }
}

export async function fetchResumeOffers(signal?: AbortSignal): Promise<ResumeOffers> {
  const res = await fetch(`${API_ORIGIN}/api/continuity/resume-offers`, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return readResumeOffers(await res.json())
}

/** The person resumed or dismissed these offers (`runs`: and decided about the interrupted runs). */
export async function settleResumeOffers(conversationIds: string[], options: { runs?: boolean } = {}): Promise<void> {
  const res = await fetch(`${API_ORIGIN}/api/continuity/resume-offers/settle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationIds, ...(options.runs ? { runs: true } : {}) }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

/** What an app restart would interrupt right now. Null when the server cannot say. */
export async function fetchActiveWork(signal?: AbortSignal): Promise<ActiveWork | null> {
  try {
    const res = await fetch(`${API_ORIGIN}/api/continuity/active-work`, { signal })
    if (!res.ok) return null
    const body = await res.json() as Partial<ActiveWork>
    const missions = Number(body.missions) || 0
    const runs = Number(body.runs) || 0
    return { missions, runs, total: missions + runs }
  } catch {
    return null
  }
}

/** Say the coming restart installs an update (interrupted turns are offered back as "update"). Best-effort. */
export async function noteUpdateRestart(): Promise<void> {
  try {
    await fetch(`${API_ORIGIN}/api/continuity/shutdown-intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trigger: 'update' }),
    })
  } catch { /* the restart still happens; turns are offered back as "quit" */ }
}
