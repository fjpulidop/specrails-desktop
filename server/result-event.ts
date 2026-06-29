// Result-event normalisation and finalisation for AI CLI invocations.
//
// Two coexisting APIs during the multi-provider migration window:
//
//   - finaliseInvocationResult(adapter, events, opts) — new contract used by
//     post-adapter managers. Walks an AdapterEvent stream, calls
//     `adapter.extractResult`, and falls back to the local pricing table when
//     the adapter declares `capabilities.nativeCostUsd === false`. Returns
//     both the NormalisedResult and an `estimated` flag for the
//     `total_cost_usd_estimated` DB column.
//
//   - normaliseResultEvent(event, provider) — legacy single-event shape kept
//     so non-migrated managers (queue-manager, chat-manager,
//     agent-refine-manager pre-refactor) keep working. Will be removed after
//     all callsites migrate (tasks §7–10).
//
// Spec: openspec/specs/multi-provider-architecture/spec.md
// Spec: openspec/changes/add-multi-provider-support/specs/project-spending/spec.md

import type { AdapterEvent, NormalisedResult, ProviderAdapter, ProviderId } from './providers/types'
import { estimateCostUsd } from './pricing'

export type { NormalisedResult } from './providers/types'

export interface FinaliseOptions {
  /** Fallback model when the adapter's extractResult cannot determine it (e.g.
   *  codex does not surface the model in its stream events; the manager-level
   *  caller already knows it from the spawn args). */
  fallbackModel?: string
  /** Optional override for cost estimation (testing hook). When omitted, the
   *  module-level `estimateCostUsd` is used. */
  estimator?: typeof estimateCostUsd
}

export interface FinalisedInvocation {
  result: NormalisedResult
  /** True when `total_cost_usd` was filled in from the local pricing table
   *  rather than from a provider's native cost field. Drives the DB
   *  `total_cost_usd_estimated` flag and the analytics `~` badge. */
  estimated: boolean
}

/**
 * Finalise an AI invocation by walking the adapter's parsed events, stamping
 * the model when the adapter does not report one, and applying the local
 * pricing-table fallback when the adapter does not report `total_cost_usd`.
 */
export function finaliseInvocationResult(
  adapter: ProviderAdapter,
  events: readonly AdapterEvent[],
  opts: FinaliseOptions = {},
): FinalisedInvocation {
  const result = adapter.extractResult(events) as NormalisedResult & { __dontFreeze?: never }
  const cloned: NormalisedResult = { ...result }

  // Stamp the model from the caller when the adapter did not derive one. The
  // adapter contract permits leaving `model` undefined; the manager knows the
  // model it spawned with.
  if (!cloned.model && opts.fallbackModel) {
    cloned.model = opts.fallbackModel
  }

  let estimated = false
  // Guard: when the breakdown carries NO billable usage (every token field
  // undefined/0 — e.g. a codex/gemini turn aborted/crashed before its
  // `turn.completed` usage block), do NOT estimate. The estimator would return
  // the number `0` for a priced model, persisting `total_cost_usd=0,
  // estimated=1`, while the equivalent claude failure leaves NULL. Skipping it
  // keeps `total_cost_usd` undefined → persisted NULL, identical to claude, and
  // also avoids the misleading "no rate-card entry" warn below for a known
  // model that simply had no usage. (BUG-ANALYTICS-05.)
  // cache_create is intentionally excluded — it is never billed by the pricing
  // table, so a row carrying only cache-create tokens has no billable usage and
  // must be treated as no-cost (NULL), mirroring estimateCostUsd.
  const hasBillableUsage =
    (cloned.tokens_in ?? 0) > 0 ||
    (cloned.tokens_out ?? 0) > 0 ||
    (cloned.tokens_cache_read ?? 0) > 0
  if (!adapter.capabilities.nativeCostUsd && hasBillableUsage) {
    const estimator = opts.estimator ?? estimateCostUsd
    const computed = estimator(adapter.id, cloned.model, {
      tokens_in: cloned.tokens_in,
      tokens_out: cloned.tokens_out,
      tokens_cache_read: cloned.tokens_cache_read,
      tokens_cache_create: cloned.tokens_cache_create,
    })
    if (computed !== null) {
      cloned.total_cost_usd = computed
      estimated = true
    } else if (cloned.model) {
      // Non-native-cost provider with a known model id but no pricing-table
      // entry → cost is persisted NULL and silently vanishes from totals.
      // Surface it so a new/renamed/drifted model id is caught fast (the fix
      // is to add the rate to server/pricing.ts, per its quarterly-review
      // contract). We deliberately do NOT fabricate a fallback rate.
      console.warn(
        `[pricing] no rate-card entry for "${adapter.id}:${cloned.model}" — ` +
          `cost will be persisted NULL. Add it to server/pricing.ts PRICING.`,
      )
    }
  }

  return { result: cloned, estimated }
}

// ─── Legacy single-event API ─────────────────────────────────────────────────
//
// Pre-adapter managers still call this with the single terminal event payload
// they captured. Behaviour identical to the implementation that lived here
// before; provider-specific branches preserved. Once all callsites migrate to
// `finaliseInvocationResult`, delete this and remove the import.

export function normaliseResultEvent(
  event: Record<string, unknown> | null | undefined,
  provider: ProviderId = 'claude',
): NormalisedResult {
  if (!event) return {}
  if (provider === 'claude') {
    const usage = event.usage as Record<string, number> | undefined
    return {
      tokens_in: usage?.input_tokens,
      tokens_out: usage?.output_tokens,
      tokens_cache_read: usage?.cache_read_input_tokens,
      tokens_cache_create: usage?.cache_creation_input_tokens,
      total_cost_usd: event.total_cost_usd as number | undefined,
      num_turns: event.num_turns as number | undefined,
      model: event.model as string | undefined,
      duration_ms: event.duration_ms as number | undefined,
      // CLI emits `duration_api_ms`; keep the legacy alias as a fallback.
      duration_api_ms: (event.duration_api_ms ?? event.api_duration_ms) as number | undefined,
      session_id: event.session_id as string | undefined,
    }
  }
  // Codex path: callers may pass either a `turn.completed` event (with a
  // nested `usage` block) or a synthesised result-like object with
  // pre-flattened fields. Read whichever shape is present.
  const usage = event.usage as Record<string, number> | undefined
  // Codex folds reasoning_output_tokens into the billed output token count
  // (OpenAI bills reasoning tokens at output-token rates), so we collapse
  // them here to keep cost estimation consistent with the adapter.
  const outputTokens = usage
    ? (usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0)
    : undefined
  return {
    tokens_in: usage?.input_tokens,
    tokens_out: outputTokens,
    tokens_cache_read: usage?.cached_input_tokens,
    total_cost_usd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
    num_turns: typeof event.num_turns === 'number' ? event.num_turns : undefined,
    model: typeof event.model === 'string' ? event.model : undefined,
    duration_ms: typeof event.duration_ms === 'number' ? event.duration_ms : undefined,
  }
}
