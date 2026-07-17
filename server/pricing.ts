// Local pricing table for providers whose CLI does NOT report `total_cost_usd`
// natively. The app uses this to populate `ai_invocations.total_cost_usd` from
// captured token usage so the Spending dashboard, daily-budget enforcement, and
// cost alerts continue to function uniformly across providers.
//
// IMPORTANT — review cadence:
//
// Every quarter, the maintainer is expected to:
//   1. Confirm each entry's per-1M-token prices against the provider's
//      published rate card (https://openai.com/pricing for OpenAI / Codex).
//   2. Bump the entry's `lastReviewedAt` to the verification date.
//   3. Add new models that have shipped since the last review.
//
// If a model is encountered at runtime that is NOT in the table,
// `estimateCostUsd` returns `null` and the consuming row is persisted with
// `total_cost_usd = NULL`. This is the deliberate fail-soft behaviour: never
// fabricate a cost from an unknown rate card.
//
// Spec: openspec/changes/add-multi-provider-support/specs/project-spending/spec.md
//   - "Pricing-table fallback for non-native-cost providers"

import { getAdapter, hasAdapter } from './providers/registry'

export interface PriceEntry {
  /** USD per 1 000 000 input tokens. */
  inputPer1M: number
  /** USD per 1 000 000 output tokens. Reasoning tokens are billed at this rate
   *  per OpenAI's pricing model and are folded into `tokens_out` upstream. */
  outputPer1M: number
  /** USD per 1 000 000 cache-read tokens. */
  cacheReadPer1M: number
  /**
   * USD per 1 000 000 cache-WRITE tokens (`tokens_cache_create`). Optional —
   * only providers that bill cache writes as a separate tier model it
   * (Anthropic bills 5-minute-TTL cache writes at 1.25x the input rate; the
   * 1-hour-TTL 2x tier is not modelled — the CLI defaults to 5-minute).
   * When absent, cache-create tokens are silently ignored, preserving the
   * pre-existing OpenAI/Google semantics (no separate cache-write tier as of
   * the entries' lastReviewedAt).
   */
  cacheWritePer1M?: number
  /**
   * Usage-semantics flag. When true (the default, OpenAI/Google semantics),
   * `tokens_in` is the TOTAL prompt token count and `tokens_cache_read` is a
   * SUBSET already inside it — fresh input = tokens_in - tokens_cache_read.
   * Anthropic reports `input_tokens` EXCLUSIVE of cache reads/writes, so
   * claude entries set this to false and `tokens_in` is billed as-is.
   */
  inputIncludesCacheReads?: boolean
  /**
   * Long-context threshold tier (Gemini Pro models are context-tiered): when
   * the TOTAL prompt token count (`tokens_in`) exceeds `thresholdTokens`, the
   * provider bills the ENTIRE request at these higher rates — not just the
   * marginal tokens beyond the threshold. Cache writes are not re-rated (no
   * entry with both tiers exists today).
   */
  longContext?: {
    thresholdTokens: number
    inputPer1M: number
    outputPer1M: number
    cacheReadPer1M: number
  }
  /** YYYY-MM-DD of the last quarterly review. Drives the staleness reminder. */
  lastReviewedAt: string
}

export interface TokenUsage {
  tokens_in?: number
  tokens_out?: number
  tokens_cache_read?: number
  tokens_cache_create?: number
}

/** Key shape: `<providerId>:<model>` (case-sensitive). */
export const PRICING: Record<string, PriceEntry> = {
  // Codex (OpenAI). Reference: https://openai.com/pricing
  // GPT-5.6 family (GA 2026-07-09): cache reads keep the 90% discount; 5.6+
  // ALSO bills cache WRITES at 1.25x the uncached input rate (new semantics).
  'codex:gpt-5.6-sol':   { inputPer1M: 5.00, outputPer1M: 30.00, cacheReadPer1M: 0.50,  cacheWritePer1M: 6.25,  lastReviewedAt: '2026-07-17' },
  'codex:gpt-5.6-terra': { inputPer1M: 2.50, outputPer1M: 15.00, cacheReadPer1M: 0.25,  cacheWritePer1M: 3.125, lastReviewedAt: '2026-07-17' },
  'codex:gpt-5.6-luna':  { inputPer1M: 1.00, outputPer1M: 6.00,  cacheReadPer1M: 0.10,  cacheWritePer1M: 1.25,  lastReviewedAt: '2026-07-17' },
  'codex:gpt-5.5':       { inputPer1M: 1.25, outputPer1M: 10.00, cacheReadPer1M: 0.125, lastReviewedAt: '2026-05-17' },
  'codex:gpt-5.4':       { inputPer1M: 2.50, outputPer1M: 10.00, cacheReadPer1M: 0.25,  lastReviewedAt: '2026-05-17' },
  'codex:gpt-5.4-mini':  { inputPer1M: 0.25, outputPer1M: 2.00,  cacheReadPer1M: 0.025, lastReviewedAt: '2026-05-17' },
  'codex:gpt-5.3-codex': { inputPer1M: 1.50, outputPer1M: 6.00,  cacheReadPer1M: 0.15,  lastReviewedAt: '2026-05-17' },
  // Gemini (Google). Reference: https://ai.google.dev/gemini-api/docs/pricing
  // Standard paid tier, <=200k-context prices (Gemini Pro is context-tiered;
  // prompts >200k are under-estimated in v1 — see docs/gemini-cli-provider-study.md §2).
  // Current catalog (June 2026): 3.5-flash flagship default, 3.1-pro-preview max,
  // 3.1-flash-lite budget, 2.5-flash-lite cheapest. Older 2.5-pro/2.5-flash rows
  // are retained so historic invocations still price.
  'gemini:gemini-3.5-flash':       { inputPer1M: 1.50, outputPer1M: 9.00,  cacheReadPer1M: 0.15,  lastReviewedAt: '2026-06-17' },
  'gemini:gemini-3.1-pro-preview': {
    inputPer1M: 2.00, outputPer1M: 12.00, cacheReadPer1M: 0.20, lastReviewedAt: '2026-06-17',
    // Gemini Pro >200k-context tier (2x input / 1.5x output / 2x cache-read,
    // mirroring Google's published 2.5-pro tier structure).
    longContext: { thresholdTokens: 200_000, inputPer1M: 4.00, outputPer1M: 18.00, cacheReadPer1M: 0.40 },
  },
  'gemini:gemini-3.1-flash-lite':  { inputPer1M: 0.25, outputPer1M: 1.50,  cacheReadPer1M: 0.025, lastReviewedAt: '2026-06-17' },
  'gemini:gemini-3-flash-preview': { inputPer1M: 0.50, outputPer1M: 3.00,  cacheReadPer1M: 0.05,  lastReviewedAt: '2026-06-17' },
  'gemini:gemini-2.5-pro':         {
    inputPer1M: 1.25, outputPer1M: 10.00, cacheReadPer1M: 0.125, lastReviewedAt: '2026-06-17',
    // Google's published >200k rates for 2.5 Pro: $2.50 in / $15.00 out / $0.25 cache-read.
    longContext: { thresholdTokens: 200_000, inputPer1M: 2.50, outputPer1M: 15.00, cacheReadPer1M: 0.25 },
  },
  'gemini:gemini-2.5-flash':       { inputPer1M: 0.30, outputPer1M: 2.50,  cacheReadPer1M: 0.03,  lastReviewedAt: '2026-06-17' },
  'gemini:gemini-2.5-flash-lite':  { inputPer1M: 0.10, outputPer1M: 0.40,  cacheReadPer1M: 0.01,  lastReviewedAt: '2026-06-17' },
  // Claude (Anthropic). Reference: https://platform.claude.com/docs/en/pricing
  // The claude CLI reports `total_cost_usd` natively — that value is always
  // authoritative when present. These entries exist ONLY for the estimation
  // fallback on spawns killed/aborted/timed-out before their terminal `result`
  // event (COST-ACCOUNTING-AUDIT CRIT-1 + refuted-#3), where per-assistant-event
  // usage is the sole signal. Keys are the CLI's short aliases; full model ids
  // (e.g. per-event `message.model` like "claude-sonnet-4-6") are collapsed by
  // family via `resolvePriceEntry`. Cache write = 1.25x input (5-minute-TTL
  // default), cache read = 0.1x input. Anthropic usage semantics: input_tokens
  // EXCLUDES cache reads/writes → inputIncludesCacheReads: false.
  'claude:opus':   { inputPer1M: 5.00,  outputPer1M: 25.00, cacheReadPer1M: 0.50, cacheWritePer1M: 6.25,  inputIncludesCacheReads: false, lastReviewedAt: '2026-07-02' },
  'claude:sonnet': { inputPer1M: 3.00,  outputPer1M: 15.00, cacheReadPer1M: 0.30, cacheWritePer1M: 3.75,  inputIncludesCacheReads: false, lastReviewedAt: '2026-07-02' },
  'claude:haiku':  { inputPer1M: 1.00,  outputPer1M: 5.00,  cacheReadPer1M: 0.10, cacheWritePer1M: 1.25,  inputIncludesCacheReads: false, lastReviewedAt: '2026-07-02' },
  'claude:fable':  { inputPer1M: 10.00, outputPer1M: 50.00, cacheReadPer1M: 1.00, cacheWritePer1M: 12.50, inputIncludesCacheReads: false, lastReviewedAt: '2026-07-02' },
}

/** Claude model families the rate card is keyed on (short CLI aliases). */
const CLAUDE_MODEL_FAMILY = /(fable|opus|sonnet|haiku)/

/**
 * Resolve the rate-card entry for `${providerId}:${model}`. Exact key first;
 * for claude, full model ids (`claude-sonnet-4-6`, `claude-opus-4-8`, dated
 * snapshots, …) collapse to their family alias so per-event `message.model`
 * values price without enumerating every dated id in the table.
 */
export function resolvePriceEntry(providerId: string, model: string): PriceEntry | undefined {
  const exact = PRICING[`${providerId}:${model}`]
  if (exact) return exact
  if (providerId === 'claude') {
    const family = CLAUDE_MODEL_FAMILY.exec(model)
    if (family) return PRICING[`claude:${family[1]}`]
  }
  return undefined
}

/**
 * Estimate cost in USD from a token usage breakdown. Returns `null` when:
 *   - the model is null/empty,
 *   - the `${providerId}:${model}` key is not in the pricing table,
 *   - the usage breakdown is entirely empty (every token field undefined/0).
 *
 * The last case is the fix for the provider asymmetry where a codex/gemini turn
 * that ends WITHOUT a usage block (abort/crash before `turn.completed`) would
 * otherwise estimate the number `0` and persist `total_cost_usd=0, estimated=1`,
 * while the equivalent claude failure leaves `total_cost_usd` NULL. Treating an
 * all-zero usage breakdown as "no cost to estimate" (→ `null`) keeps failed
 * non-native-cost rows NULL, exactly like claude, so they're excluded from the
 * scatter/`byProvider` estimated branch rather than rendering as `~$0.00` dots.
 *
 * Cache-creation tokens are billed at the entry's `cacheWritePer1M` when that
 * tier is modelled (claude). For entries WITHOUT a cache-write tier (codex /
 * gemini) they are silently ignored — including them as ordinary input tokens
 * would double-count against the rate card — and a payload carrying ONLY
 * cache-create tokens still estimates to null rather than 0 (BUG-ANALYTICS-05
 * shape preserved for those providers).
 */
export function estimateCostUsd(
  providerId: string,
  model: string | null | undefined,
  usage: TokenUsage,
): number | null {
  if (!model) return null
  const entry = resolvePriceEntry(providerId, model)
  if (!entry) return null
  // Entirely-empty usage breakdown → there is no real usage to price. Return
  // null (not 0) so the row persists NULL, matching claude's failed-row shape.
  // tokens_cache_create counts as billable usage only when the entry actually
  // prices cache writes; otherwise a cache-create-only payload has no billable
  // usage and must estimate to null rather than 0.
  const cacheCreateBillable =
    entry.cacheWritePer1M !== undefined && (usage.tokens_cache_create ?? 0) > 0
  const hasBillableUsage =
    (usage.tokens_in ?? 0) > 0 ||
    (usage.tokens_out ?? 0) > 0 ||
    (usage.tokens_cache_read ?? 0) > 0 ||
    cacheCreateBillable
  if (!hasBillableUsage) return null
  // Long-context threshold tier (LOW-5, Gemini Pro): when the total prompt
  // token count exceeds the threshold the WHOLE request re-rates at the
  // higher tier (Google bills the entire request, not the marginal excess).
  const rates =
    entry.longContext && (usage.tokens_in ?? 0) > entry.longContext.thresholdTokens
      ? entry.longContext
      : entry
  // Default (OpenAI/Google) semantics: `tokens_in` is the TOTAL prompt token
  // count and `tokens_cache_read` is a SUBSET already inside it (input_tokens
  // includes cached_input_tokens). Bill the cached portion at the cache rate
  // ONLY, and the remaining fresh input at the full input rate. Charging the
  // full input rate over the whole `tokens_in` AND a separate cache-read cost
  // would double-charge every cached token. Clamp at 0 to guard a malformed
  // payload where the reported cache subset exceeds the total.
  // Anthropic semantics (`inputIncludesCacheReads: false`): input_tokens
  // already EXCLUDES cache reads/writes, so it is billed as-is.
  const freshInput = entry.inputIncludesCacheReads === false
    ? (usage.tokens_in ?? 0)
    : Math.max(0, (usage.tokens_in ?? 0) - (usage.tokens_cache_read ?? 0))
  const inputCost      = freshInput                        * rates.inputPer1M     / 1_000_000
  const outputCost     = (usage.tokens_out          ?? 0) * rates.outputPer1M    / 1_000_000
  const cacheReadCost  = (usage.tokens_cache_read   ?? 0) * rates.cacheReadPer1M / 1_000_000
  const cacheWriteCost = entry.cacheWritePer1M !== undefined
    ? (usage.tokens_cache_create ?? 0) * entry.cacheWritePer1M / 1_000_000
    : 0
  return inputCost + outputCost + cacheReadCost + cacheWriteCost
}

/**
 * Returns the oldest `lastReviewedAt` date across the table. Surfaced by an
 * optional diagnostic endpoint so the maintainer can spot staleness quickly.
 */
export function lastReviewedAt(): string {
  let oldest: string | null = null
  for (const entry of Object.values(PRICING)) {
    if (oldest === null || entry.lastReviewedAt < oldest) oldest = entry.lastReviewedAt
  }
  return oldest ?? '0000-00-00'
}

/**
 * Returns true when the resolved adapter for the given provider id declares
 * `capabilities.nativeCostUsd === false`. Used by callsites to decide whether
 * to fall back to estimation vs trust the provider's terminal event.
 *
 * Returns false for unknown ids (defensive: do not call the estimator for an
 * unrecognised provider).
 */
export function providerNeedsCostEstimation(providerId: string): boolean {
  if (!hasAdapter(providerId)) return false
  return getAdapter(providerId).capabilities.nativeCostUsd === false
}
