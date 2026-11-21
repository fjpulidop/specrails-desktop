import type { AdapterEvent } from '../../../providers/types'
import { contextPercent, type ContextUsageSnapshot } from '../../agents/runtime/conversation-context-usage'

// The stored snapshot shape lives with the conversation store (agents); missions measure it.
export { contextPercent, parseContextUsageSnapshot, type ContextUsageSnapshot, type ContextUsageSource } from '../../agents/runtime/conversation-context-usage'

// ─── Mission "context used" snapshot (pure) ───────────────────────────────────
//
// A mission keeps ONE provider session per conversation, so its context grows
// turn after turn until the provider compacts it. This module measures how full
// the window is from what the provider itself reported. It never estimates:
// no usage, no window → no ring.
//
// - Claude (`claude -p --output-format stream-json`): the NEWEST root assistant
//   frame's `message.usage` input side (input + cache write + cache read). Each
//   request's input already contains the whole context, so frames and turns are
//   never summed and output tokens are never added. The window comes from the
//   `result` frame's `modelUsage[<model>].contextWindow`.
// - Codex (`codex exec --json`): the session rollout's last `token_count`
//   (`info.last_token_usage.total_tokens` / `info.model_context_window`); see
//   [codex-rollout-reader.ts](./codex-rollout-reader.ts) for the file lookup.
// - Claude through Core sessions (no provider frames reach Desktop): the
//   session transcript tail ([claude-transcript-reader.ts](./claude-transcript-reader.ts)).

/** A model id with the `[1m]` suffix runs with the 1M-token context window. */
export const ONE_MILLION_CONTEXT_WINDOW = 1_000_000


function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function isOneMillion(model: string | null | undefined): boolean {
  return typeof model === 'string' && /\[1m\]$/i.test(model.trim())
}

/** Fields the Claude adapter attaches to its events (see claude-adapter.ts). */
interface ClaudeEventCarrier {
  usage?: { input_tokens?: unknown; cache_creation_input_tokens?: unknown; cache_read_input_tokens?: unknown }
  model?: string
  parentToolUseId?: string
  systemSubtype?: string
}

/** Root frames belong to the mission's own conversation; sub-agent (Task) frames carry a parent tool use id. */
function isRootFrame(ev: AdapterEvent): boolean {
  const carrier = ev as AdapterEvent & ClaudeEventCarrier
  if (typeof carrier.parentToolUseId === 'string' && carrier.parentToolUseId) return false
  if (ev.kind === 'other') {
    const parent = ev.raw.parent_tool_use_id
    if (typeof parent === 'string' && parent) return false
    if (ev.raw.isSidechain === true) return false
  }
  return true
}

/** The usage block of an assistant-derived event, whatever its kind. */
function assistantUsage(ev: AdapterEvent): { used: number; model: string | null } | null {
  const carrier = ev as AdapterEvent & ClaudeEventCarrier
  let usage = carrier.usage
  let model: string | null = typeof carrier.model === 'string' ? carrier.model : null
  if (!usage && ev.kind === 'other' && ev.type === 'assistant') {
    const message = ev.raw.message as { usage?: ClaudeEventCarrier['usage']; model?: unknown } | undefined
    usage = message?.usage
    if (typeof message?.model === 'string') model = message.model
  }
  if (!usage || typeof usage !== 'object') return null
  const used = num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens)
  return used > 0 ? { used, model } : null
}

/** The main model's context window from the `result` frame's `modelUsage`. */
export function claudeContextWindow(
  modelUsage: unknown,
  preferred: { initModel?: string | null; assistantModel?: string | null },
): { window: number; model: string } | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null
  const entries = Object.entries(modelUsage as Record<string, unknown>)
    .map(([model, value]) => ({ model, window: positive((value as { contextWindow?: unknown } | null)?.contextWindow) }))
    .filter((entry): entry is { model: string; window: number } => entry.window !== null)
  if (!entries.length) return null
  const pick = (model: string | null | undefined) => (model ? entries.find((entry) => entry.model === model) : undefined)
  return pick(preferred.initModel)
    ?? pick(preferred.assistantModel)
    ?? entries.reduce((largest, entry) => (entry.window > largest.window ? entry : largest))
}

/**
 * Context snapshot from Core's own measurement of a session turn (the
 * `core-context-usage` event the Core session runner emits). The latest one
 * wins. A missing window falls back to `knownWindow` (the last window this
 * mission measured), then to `[1m]`; otherwise it stays null (ring hidden).
 */
export function coreContextUsage(
  events: readonly AdapterEvent[],
  options: { provider: string; configuredModel?: string | null; knownWindow?: number | null; now?: Date },
): ContextUsageSnapshot | null {
  let raw: Record<string, unknown> | null = null
  for (const ev of events) if (ev.kind === 'other' && ev.type === 'core-context-usage') raw = ev.raw
  if (!raw) return null
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)
  const usedTokens = count(raw.usedTokens)
  const compacted = raw.compacted === true
  if (usedTokens === null && !compacted && count(raw.windowTokens) === null) return null
  const model = typeof raw.model === 'string' && raw.model ? raw.model : options.configuredModel ?? null
  const windowTokens = count(raw.windowTokens) || (options.knownWindow ?? null)
    || (isOneMillion(model) || isOneMillion(options.configuredModel) ? ONE_MILLION_CONTEXT_WINDOW : null)
  return {
    provider: options.provider,
    model,
    usedTokens,
    windowTokens,
    percent: contextPercent(usedTokens, windowTokens),
    source: 'response',
    measuredAt: (options.now ?? new Date()).toISOString(),
    ...(compacted ? { compacted: true } : {}),
  }
}

/**
 * Context snapshot of one settled Claude turn, or null when the turn carried
 * no usable usage (e.g. a Core session turn, which reports no provider frames).
 * `configuredModel` is the mission's model setting, used for `[1m]` and as the
 * display fallback.
 */
export function claudeContextUsage(
  events: readonly AdapterEvent[],
  options: { provider?: string; configuredModel?: string | null; now?: Date } = {},
): ContextUsageSnapshot | null {
  let initModel: string | null = null
  let latest: { used: number; model: string | null } | null = null
  let compacted = false
  let resultPayload: Record<string, unknown> | null = null
  for (const ev of events) {
    const carrier = ev as AdapterEvent & ClaudeEventCarrier
    if (ev.kind === 'session-started') {
      if (carrier.systemSubtype === 'compact_boundary') {
        compacted = true
        latest = null
      } else if (typeof carrier.model === 'string' && carrier.model) {
        initModel = carrier.model
      }
      continue
    }
    if (ev.kind === 'other' && ev.type === 'system' && ev.raw.subtype === 'compact_boundary') {
      compacted = true
      latest = null
      continue
    }
    if (ev.kind === 'result') {
      resultPayload = ev.payload
      continue
    }
    if (!isRootFrame(ev)) continue
    const usage = assistantUsage(ev)
    if (usage) latest = usage
  }
  if (!latest && !compacted) return null

  const assistantModel = latest?.model ?? null
  const windowEntry = claudeContextWindow(resultPayload?.modelUsage, { initModel, assistantModel })
  const model = initModel ?? windowEntry?.model ?? assistantModel ?? options.configuredModel ?? null
  let windowTokens = windowEntry?.window ?? null
  if (isOneMillion(initModel) || isOneMillion(windowEntry?.model) || isOneMillion(options.configuredModel)) windowTokens = ONE_MILLION_CONTEXT_WINDOW
  const usedTokens = latest?.used ?? null
  return {
    provider: options.provider ?? 'claude',
    model,
    usedTokens,
    windowTokens,
    percent: contextPercent(usedTokens, windowTokens),
    source: 'response',
    measuredAt: (options.now ?? new Date()).toISOString(),
    ...(compacted ? { compacted: true } : {}),
  }
}

/**
 * Context snapshot from the tail of a Codex session rollout (JSONL). Uses the
 * LAST `token_count` event that carries both values; a first partial line (a
 * tail cut mid-line) and malformed lines are ignored.
 */
export function codexContextUsageFromRollout(
  tail: string,
  options: { provider?: string; configuredModel?: string | null; now?: Date } = {},
): ContextUsageSnapshot | null {
  const lines = tail.split('\n')
  let model: string | null = null
  let measured: { used: number; window: number } | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let entry: { type?: unknown; payload?: Record<string, unknown> }
    try { entry = JSON.parse(trimmed) as typeof entry } catch { continue }
    const payload = entry.payload
    if (!payload || typeof payload !== 'object') continue
    if (entry.type === 'turn_context' && typeof payload.model === 'string') model = payload.model
    if (payload.type !== 'token_count') continue
    const info = payload.info as { last_token_usage?: { total_tokens?: unknown }; model_context_window?: unknown } | null | undefined
    const used = positive(info?.last_token_usage?.total_tokens)
    const window = positive(info?.model_context_window)
    if (used !== null && window !== null) measured = { used, window }
  }
  if (!measured) return null
  return {
    provider: options.provider ?? 'codex',
    model: model ?? options.configuredModel ?? null,
    usedTokens: measured.used,
    windowTokens: measured.window,
    percent: contextPercent(measured.used, measured.window),
    source: 'session-file',
    measuredAt: (options.now ?? new Date()).toISOString(),
  }
}

/**
 * Context snapshot from the tail of a Claude Code session transcript
 * (`<config>/projects/<encoded-cwd>/<sessionId>.jsonl`), used when the turn
 * itself carried no provider frames (Core session turns). The newest root
 * (`isSidechain !== true`) assistant line with non-zero usage gives `used`; a
 * later `compact_boundary` line makes it unknown. The transcript has no
 * context window: `knownWindow` is the last window this mission measured from
 * a stream-json turn, a `[1m]` model is 1,000,000, otherwise the window stays
 * null (the ring is hidden).
 */
export function claudeContextUsageFromTranscript(
  tail: string,
  options: { provider?: string; configuredModel?: string | null; knownWindow?: number | null; now?: Date } = {},
): ContextUsageSnapshot | null {
  let latest: { used: number; model: string | null } | null = null
  let compacted = false
  for (const line of tail.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let entry: { type?: unknown; subtype?: unknown; isSidechain?: unknown; message?: { model?: unknown; usage?: ClaudeEventCarrier['usage'] } }
    try { entry = JSON.parse(trimmed) as typeof entry } catch { continue }
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      compacted = true
      latest = null
      continue
    }
    if (entry.type !== 'assistant' || entry.isSidechain === true) continue
    const usage = entry.message?.usage
    if (!usage || typeof usage !== 'object') continue
    const used = num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens)
    if (used > 0) latest = { used, model: typeof entry.message?.model === 'string' ? entry.message.model : null }
  }
  if (!latest && !compacted) return null
  const model = latest?.model ?? options.configuredModel ?? null
  const windowTokens = isOneMillion(options.configuredModel) || isOneMillion(model)
    ? ONE_MILLION_CONTEXT_WINDOW
    : positive(options.knownWindow)
  const usedTokens = latest?.used ?? null
  return {
    provider: options.provider ?? 'claude',
    model,
    usedTokens,
    windowTokens,
    percent: contextPercent(usedTokens, windowTokens),
    source: 'session-file',
    measuredAt: (options.now ?? new Date()).toISOString(),
    ...(compacted ? { compacted: true } : {}),
  }
}

