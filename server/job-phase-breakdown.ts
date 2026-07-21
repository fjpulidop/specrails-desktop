import { estimateCostUsd } from './pricing'

/**
 * Per-phase cost/usage attribution for a pipeline job, computed post-hoc from
 * the job's persisted raw stream events (the `events` table stores every
 * stream-json line verbatim).
 *
 * How it works (claude stream-json): each subagent phase starts as a `Task`
 * tool_use block inside an assistant event (`input.subagent_type` names the
 * agent, e.g. `sr-architect`); every event the subagent generates carries
 * `parent_tool_use_id` = that Task block's id. Summing each assistant event's
 * `message.usage` by that key yields real per-phase token usage. Costs are
 * rate-card estimates (the provider bills at session granularity, not per
 * phase) and are ALWAYS flagged `estimated` — honest-metrics contract.
 *
 * Nested subagents attribute transitively to their root phase. Events with no
 * parent belong to the orchestrator. Non-claude streams (codex/gemini/kimi)
 * have no per-event usage envelope — the computation returns null and the
 * endpoint reports the breakdown as unavailable.
 */

export interface PhaseUsageTotals {
  tokensIn: number
  tokensOut: number
  tokensCacheRead: number
  tokensCacheCreate: number
  assistantEvents: number
  /** Rate-card estimate; null when no event was priceable. */
  estimatedCostUsd: number | null
}

export interface JobPhaseEntry extends PhaseUsageTotals {
  agent: string
  toolUseId: string
  description: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
}

export interface JobPhaseBreakdown {
  phases: JobPhaseEntry[]
  orchestrator: PhaseUsageTotals
  /** Usage under parent ids that never matched a Task block; null when none. */
  unattributed: PhaseUsageTotals | null
  /** Always true — per-phase costs are pricing-table estimates by nature. */
  estimated: true
}

export interface RawJobEvent {
  event_type: string
  payload: string
  timestamp: string | null
}

interface UsageEnvelope {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export function computeJobPhaseBreakdown(
  events: RawJobEvent[],
  providerId = 'claude',
): JobPhaseBreakdown | null {
  const phases = new Map<string, JobPhaseEntry>()
  /** tool_use id → root phase id, for transitive nested-Task attribution. */
  const rootOf = new Map<string, string>()
  const orchestrator = emptyTotals()
  const unattributed = emptyTotals()
  let sawUsage = false

  const totalsFor = (parentId: string | null): PhaseUsageTotals => {
    if (!parentId) return orchestrator
    const rootId = rootOf.get(parentId)
    if (!rootId) return unattributed
    return phases.get(rootId) ?? unattributed
  }

  for (const ev of events) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(ev.payload) as Record<string, unknown>
    } catch {
      continue
    }
    const parentId = typeof parsed.parent_tool_use_id === 'string' ? parsed.parent_tool_use_id : null
    const message = parsed.message as Record<string, unknown> | undefined

    if (parsed.type === 'assistant' && message) {
      // Register Task spawns FIRST so a same-event usage envelope can't
      // attribute to a phase this very event opens.
      for (const block of contentBlocks(message)) {
        if (block.type !== 'tool_use' || block.name !== 'Task' || typeof block.id !== 'string') continue
        const input = (block.input ?? {}) as Record<string, unknown>
        const rootId = parentId ? (rootOf.get(parentId) ?? null) : null
        if (rootId) {
          // Nested Task: its events roll up into the ancestor phase.
          rootOf.set(block.id, rootId)
        } else {
          rootOf.set(block.id, block.id)
          phases.set(block.id, {
            ...emptyTotals(),
            agent: typeof input.subagent_type === 'string' ? input.subagent_type : 'subagent',
            toolUseId: block.id,
            description: typeof input.description === 'string' ? input.description : null,
            startedAt: ev.timestamp,
            endedAt: null,
            durationMs: null,
          })
        }
      }

      const usage = message.usage as UsageEnvelope | undefined
      if (usage && typeof usage === 'object') {
        sawUsage = true
        const target = totalsFor(parentId)
        const tokensIn = num(usage.input_tokens)
        const tokensOut = num(usage.output_tokens)
        const cacheRead = num(usage.cache_read_input_tokens)
        const cacheCreate = num(usage.cache_creation_input_tokens)
        target.tokensIn += tokensIn
        target.tokensOut += tokensOut
        target.tokensCacheRead += cacheRead
        target.tokensCacheCreate += cacheCreate
        target.assistantEvents += 1
        const cost = estimateCostUsd(providerId, str(message.model), {
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          tokens_cache_read: cacheRead,
          tokens_cache_create: cacheCreate,
        })
        if (cost !== null) {
          target.estimatedCostUsd = (target.estimatedCostUsd ?? 0) + cost
        }
      }
      continue
    }

    if (parsed.type === 'user' && message) {
      // A tool_result closing a root Task block ends that phase.
      for (const block of contentBlocks(message)) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
        const phase = phases.get(block.tool_use_id)
        if (phase && phase.endedAt === null) {
          phase.endedAt = ev.timestamp
          phase.durationMs = spanMs(phase.startedAt, ev.timestamp)
        }
      }
    }
  }

  if (!sawUsage) return null

  const hasUnattributed =
    unattributed.assistantEvents > 0 || unattributed.tokensIn > 0 || unattributed.tokensOut > 0
  return {
    phases: [...phases.values()],
    orchestrator,
    unattributed: hasUnattributed ? unattributed : null,
    estimated: true,
  }
}

// ─── Internals ────────────────────────────────────────────────────────────────

function emptyTotals(): PhaseUsageTotals {
  return {
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheCreate: 0,
    assistantEvents: 0,
    estimatedCostUsd: null,
  }
}

interface ContentBlock {
  type?: unknown
  name?: unknown
  id?: unknown
  input?: unknown
  tool_use_id?: unknown
}

function contentBlocks(message: Record<string, unknown>): ContentBlock[] {
  const content = message.content
  return Array.isArray(content) ? (content as ContentBlock[]) : []
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function spanMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null
  const a = Date.parse(start)
  const b = Date.parse(end)
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null
  return b - a
}
