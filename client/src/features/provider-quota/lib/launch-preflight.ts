/** Server `PreflightReport` (server/modules/launch-preflight/domain.ts) and its fetch. */
import { API_ORIGIN } from '../../../lib/origin'

export type ChipState = 'ok' | 'warn' | 'fail' | 'unknown'
export type SignInStatus = 'signed-in' | 'signed-out' | 'missing' | 'unknown'

export type PreflightChip =
  | { id: 'disk'; kind: 'disk'; state: ChipState; freeBytes: number | null }
  | { id: string; kind: 'provider'; state: ChipState; providerId: string; status: SignInStatus }
  | { id: 'github'; kind: 'github'; state: ChipState; status: SignInStatus }
  | { id: string; kind: 'quota'; state: ChipState; providerId: string; level: string; usedPercent: number | null; rejectedUntil: string | null }
  | { id: 'headless'; kind: 'headless'; state: ChipState; framework: string; honoured: boolean }

export interface PreflightReport { chips: PreflightChip[]; blocking: boolean; checkedAt: string }

const STATES: ReadonlySet<string> = new Set(['ok', 'warn', 'fail', 'unknown'])

export function parsePreflight(raw: unknown): PreflightReport | null {
  const value = raw as { chips?: unknown; blocking?: unknown; checkedAt?: unknown } | null
  if (!value || !Array.isArray(value.chips) || typeof value.blocking !== 'boolean') return null
  const chips = value.chips.filter((chip): chip is PreflightChip => !!chip && typeof chip === 'object' && typeof (chip as PreflightChip).id === 'string' && STATES.has((chip as PreflightChip).state))
  return { chips, blocking: value.blocking, checkedAt: typeof value.checkedAt === 'string' ? value.checkedAt : new Date().toISOString() }
}

/** `providers`: each rail's engine ('' = the project's primary provider). */
export async function fetchLaunchPreflight(projectId: string, providers: readonly string[], options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<PreflightReport | null> {
  const query = new URLSearchParams({ projectId, providers: [...new Set(providers)].join(','), ...(options.fresh ? { fresh: '1' } : {}) })
  const response = await fetch(`${API_ORIGIN}/api/launch-preflight?${query.toString()}`, { signal: options.signal })
  if (!response.ok) return null
  return parsePreflight(await response.json())
}
