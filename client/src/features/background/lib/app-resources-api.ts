import { API_ORIGIN } from '../../../lib/origin'
import type { ResourceSample } from './mission-resources-api'

export type AppResourceCategoryId = 'missions' | 'rails' | 'background' | 'terminals' | 'agent-cli' | 'mcp' | 'git' | 'other' | 'server'

export interface AppResourceTotals { cpuPercent: number; memoryBytes: number; processCount: number }

export interface AppResourceItem extends AppResourceTotals {
  label: string
  projectId?: string
  projectName?: string
  chatId?: string
  /** Loop run or job id (rails). */
  runId?: string
}

export interface AppResourceCategory extends AppResourceTotals {
  id: AppResourceCategoryId
  items: AppResourceItem[]
}

/** `GET /api/resources`: what everything Specrails launched consumes right now. */
export interface AppResourcesSnapshot {
  measuredAt: number
  supported: boolean
  totals: AppResourceTotals
  categories: AppResourceCategory[]
  /** Oldest first; kept by the server only while the view is polled. */
  history?: ResourceSample[]
}

export async function getAppResources(signal?: AbortSignal): Promise<AppResourcesSnapshot> {
  const response = await fetch(`${API_ORIGIN}/api/resources`, { signal })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`)
  if (!body || !body.totals || !Array.isArray(body.categories)) throw new Error('Invalid resources snapshot')
  return body as AppResourcesSnapshot
}
