/**
 * The stored "context used" snapshot of a mission conversation: how full the
 * provider session's context window was after its last turn. Measured by the
 * missions module (mission-context-usage.ts); stored and read here with the
 * conversation it belongs to.
 */

export type ContextUsageSource = 'response' | 'session-file'

export interface ContextUsageSnapshot {
  provider: string
  model: string | null
  /** Tokens in the context at the last request; null after a compaction until the next response. */
  usedTokens: number | null
  /** Context window of the model; null when the provider did not report one. */
  windowTokens: number | null
  /** round(used / window * 100), NOT clamped (a client clamps only when drawing). */
  percent: number | null
  source: ContextUsageSource
  measuredAt: string
  /** The provider compacted the context during the measured turn. */
  compacted?: boolean
}

export function contextPercent(used: number | null, window: number | null): number | null {
  if (used === null || window === null || !(window > 0)) return null
  return Math.round((used / window) * 100)
}

/** Validate a stored snapshot (the DB column is free-form JSON). */
export function parseContextUsageSnapshot(raw: string | null | undefined): ContextUsageSnapshot | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<ContextUsageSnapshot>
    if (!value || typeof value !== 'object' || typeof value.provider !== 'string') return null
    if (value.source !== 'response' && value.source !== 'session-file') return null
    const nullableNumber = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const usedTokens = nullableNumber(value.usedTokens)
    const windowTokens = nullableNumber(value.windowTokens)
    return {
      provider: value.provider,
      model: typeof value.model === 'string' ? value.model : null,
      usedTokens,
      windowTokens,
      percent: contextPercent(usedTokens, windowTokens),
      source: value.source,
      measuredAt: typeof value.measuredAt === 'string' ? value.measuredAt : '',
      ...(value.compacted ? { compacted: true } : {}),
    }
  } catch {
    return null
  }
}
