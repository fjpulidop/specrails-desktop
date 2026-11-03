// Local pricing table for providers whose CLI does NOT report `total_cost_usd`
// natively. The app uses this to populate `ai_invocations.total_cost_usd` from
// captured token usage so the Spending dashboard, daily-budget enforcement, and
// cost alerts continue to function uniformly across providers.
//
// IMPORTANT — review cadence:
//
// Every quarter, the maintainer is expected to:
//   1. Confirm each entry's per-1M-token prices against the provider's
//      published rate card (https://developers.openai.com/api/docs/pricing for
//      OpenAI / Codex, https://platform.claude.com/docs/en/pricing for Claude).
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

import { getAdapter, hasAdapter } from '../../../providers/registry'

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
   * marginal tokens beyond the threshold. For entries with
   * `inputIncludesCacheReads: false` (Anthropic) the prompt size compared with
   * the threshold is input + cache reads + cache writes, because
   * `tokens_in` alone excludes the cached portions of the prompt. Cache
   * writes are re-rated only when the tier declares `cacheWritePer1M`.
   */
  longContext?: {
    thresholdTokens: number
    inputPer1M: number
    outputPer1M: number
    cacheReadPer1M: number
    cacheWritePer1M?: number
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
  // Codex (OpenAI). Reference: https://developers.openai.com/api/docs/pricing
  // (standard tier; models listed at https://developers.openai.com/codex/models,
  // reviewed 2026-11-01). Prompts above 272K input tokens re-rate the WHOLE
  // request at the `longContext` tier. The 6.x rate cards publish no cache-write
  // tier, so none is modelled (cache-create tokens are ignored, fail-soft).
  'codex:gpt-6.1-sol':   {
    inputPer1M: 2.00, outputPer1M: 10.00, cacheReadPer1M: 0.10, lastReviewedAt: '2026-11-01',
    longContext: { thresholdTokens: 272_000, inputPer1M: 4.00, outputPer1M: 15.00, cacheReadPer1M: 0.20 },
  },
  'codex:gpt-6.1-terra': {
    inputPer1M: 1.00, outputPer1M: 5.00, cacheReadPer1M: 0.05, lastReviewedAt: '2026-11-01',
    longContext: { thresholdTokens: 272_000, inputPer1M: 2.00, outputPer1M: 7.50, cacheReadPer1M: 0.10 },
  },
  'codex:gpt-6-astra':   {
    inputPer1M: 10.00, outputPer1M: 50.00, cacheReadPer1M: 1.00, lastReviewedAt: '2026-11-01',
    longContext: { thresholdTokens: 272_000, inputPer1M: 20.00, outputPer1M: 75.00, cacheReadPer1M: 2.00 },
  },
  'codex:gpt-6-sol':     {
    inputPer1M: 2.00, outputPer1M: 10.00, cacheReadPer1M: 0.20, lastReviewedAt: '2026-11-01',
    longContext: { thresholdTokens: 272_000, inputPer1M: 4.00, outputPer1M: 15.00, cacheReadPer1M: 0.40 },
  },
  'codex:gpt-6-luna':    {
    inputPer1M: 0.10, outputPer1M: 0.50, cacheReadPer1M: 0.01, lastReviewedAt: '2026-11-01',
    longContext: { thresholdTokens: 272_000, inputPer1M: 0.20, outputPer1M: 0.75, cacheReadPer1M: 0.02 },
  },
  // GPT-5.6 family (legacy, no longer listed by Codex): cache reads keep the 90%
  // discount. OpenAI publishes no cache-write price and the Codex adapter never
  // reports cache-creation tokens (`tokens_cache_create: undefined`), so no row
  // carries `cacheWritePer1M`.
  'codex:gpt-5.6-sol':   {
    inputPer1M: 4.00, outputPer1M: 20.00, cacheReadPer1M: 0.40, lastReviewedAt: '2026-11-01',
    longContext: { thresholdTokens: 272_000, inputPer1M: 8.00, outputPer1M: 30.00, cacheReadPer1M: 0.80 },
  },
  'codex:gpt-5.6-terra': {
    inputPer1M: 2.00, outputPer1M: 12.00, cacheReadPer1M: 0.20, lastReviewedAt: '2026-11-01',
    longContext: { thresholdTokens: 272_000, inputPer1M: 4.00, outputPer1M: 18.00, cacheReadPer1M: 0.40 },
  },
  'codex:gpt-5.6-luna':  {
    inputPer1M: 0.20, outputPer1M: 1.20, cacheReadPer1M: 0.02, lastReviewedAt: '2026-11-01',
    longContext: { thresholdTokens: 272_000, inputPer1M: 0.40, outputPer1M: 1.80, cacheReadPer1M: 0.04 },
  },
  // Retired from Codex with ChatGPT sign-in (gpt-5.5 2026-10-14, gpt-5.4 and
  // gpt-5.4-mini 2026-08-31); rows kept so historic invocations still price.
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
  // (reviewed 2026-11-01).
  // The claude CLI reports `total_cost_usd` natively — that value is always
  // authoritative when present. These entries exist ONLY for the estimation
  // fallback on spawns killed/aborted/timed-out before their terminal `result`
  // event (COST-ACCOUNTING-AUDIT CRIT-1 + refuted-#3), where per-assistant-event
  // usage is the sole signal. Alias keys (`sonnet`, `opus`, `haiku`, `fable`)
  // carry the generation Desktop PINS for that alias (PINNED_ALIAS_MODEL_IDS in
  // claude-adapter.ts); legacy generations have their own exact keys, and other
  // full model ids (per-event `message.model`) collapse via `resolvePriceEntry`.
  // Cache write = 1.25x input (5-minute-TTL default); cache reads are
  // model-specific. Anthropic usage semantics: input_tokens
  // EXCLUDES cache reads/writes → inputIncludesCacheReads: false.
  // Fable 5.1: https://platform.claude.com/docs/en/models/fable-5-1/overview
  'claude:fable':            { inputPer1M: 10.00, outputPer1M: 50.00, cacheReadPer1M: 0.25, cacheWritePer1M: 12.50, inputIncludesCacheReads: false, lastReviewedAt: '2026-11-01' },
  'claude:claude-fable-5-1': { inputPer1M: 10.00, outputPer1M: 50.00, cacheReadPer1M: 0.25, cacheWritePer1M: 12.50, inputIncludesCacheReads: false, lastReviewedAt: '2026-11-01' },
  // Fable 5 (legacy): cache hits still bill 1.00.
  'claude:claude-fable-5':   { inputPer1M: 10.00, outputPer1M: 50.00, cacheReadPer1M: 1.00, cacheWritePer1M: 12.50, inputIncludesCacheReads: false, lastReviewedAt: '2026-11-01' },
  // Opus 5.5: https://platform.claude.com/docs/en/models/opus-5-5/overview
  'claude:opus':             { inputPer1M: 4.00, outputPer1M: 20.00, cacheReadPer1M: 0.20, cacheWritePer1M: 5.00, inputIncludesCacheReads: false, lastReviewedAt: '2026-11-01' },
  'claude:claude-opus-5-5':  { inputPer1M: 4.00, outputPer1M: 20.00, cacheReadPer1M: 0.20, cacheWritePer1M: 5.00, inputIncludesCacheReads: false, lastReviewedAt: '2026-11-01' },
  // Opus 5 (legacy); Opus 4.5-4.8 share this card via `resolvePriceEntry`.
  'claude:claude-opus-5':    { inputPer1M: 5.00, outputPer1M: 25.00, cacheReadPer1M: 0.50, cacheWritePer1M: 6.25, inputIncludesCacheReads: false, lastReviewedAt: '2026-11-01' },
  // Sonnet 5.5: https://platform.claude.com/docs/en/models/sonnet-5-5/overview
  'claude:sonnet':           { inputPer1M: 2.00, outputPer1M: 10.00, cacheReadPer1M: 0.10, cacheWritePer1M: 2.50, inputIncludesCacheReads: false, lastReviewedAt: '2026-11-01' },
  'claude:claude-sonnet-5-5': { inputPer1M: 2.00, outputPer1M: 10.00, cacheReadPer1M: 0.10, cacheWritePer1M: 2.50, inputIncludesCacheReads: false, lastReviewedAt: '2026-11-01' },
  // Sonnet 5 (legacy): the introductory price became the standard price.
  'claude:claude-sonnet-5':  { inputPer1M: 2.00, outputPer1M: 10.00, cacheReadPer1M: 0.20, cacheWritePer1M: 2.50, inputIncludesCacheReads: false, lastReviewedAt: '2026-11-01' },
  // Sonnet 4.x (legacy, incl. 4.6): 3 / 15 card.
  'claude:claude-sonnet-4':  { inputPer1M: 3.00, outputPer1M: 15.00, cacheReadPer1M: 0.30, cacheWritePer1M: 3.75, inputIncludesCacheReads: false, lastReviewedAt: '2026-11-01' },
  // Haiku 5.5: prompts above 100,000 tokens bill the whole request at the higher tier.
  'claude:haiku': {
    inputPer1M: 0.10, outputPer1M: 0.50, cacheReadPer1M: 0.01, cacheWritePer1M: 0.125, inputIncludesCacheReads: false, lastReviewedAt: '2026-11-01',
    longContext: { thresholdTokens: 100_000, inputPer1M: 0.50, outputPer1M: 2.50, cacheReadPer1M: 0.05, cacheWritePer1M: 0.625 },
  },
  'claude:claude-haiku-5-5': {
    inputPer1M: 0.10, outputPer1M: 0.50, cacheReadPer1M: 0.01, cacheWritePer1M: 0.125, inputIncludesCacheReads: false, lastReviewedAt: '2026-11-01',
    longContext: { thresholdTokens: 100_000, inputPer1M: 0.50, outputPer1M: 2.50, cacheReadPer1M: 0.05, cacheWritePer1M: 0.625 },
  },
  // Haiku 4.5 and older (legacy): 1 / 5 card.
  'claude:claude-haiku-4-5': { inputPer1M: 1.00, outputPer1M: 5.00, cacheReadPer1M: 0.10, cacheWritePer1M: 1.25, inputIncludesCacheReads: false, lastReviewedAt: '2026-11-01' },
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
    // Keep the existing estimates for older concrete Opus generations.
    if (/^claude-opus-(?:4(?:-|$)|5$)/.test(model)) return PRICING['claude:claude-opus-5']
    if (/^claude-sonnet-5$/.test(model)) return PRICING['claude:claude-sonnet-5']
    if (/^claude-sonnet-4(?:-|$)/.test(model)) return PRICING['claude:claude-sonnet-4']
    // Haiku 4.5 and older keep the pre-5.5 card; the `haiku` alias is Haiku 5.5.
    if (/^claude-(?:haiku-[1-4](?:-|$)|3-5-haiku|3-haiku)/.test(model)) return PRICING['claude:claude-haiku-4-5']
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
  // Anthropic reports `tokens_in` EXCLUSIVE of cached prompt tokens, so its
  // prompt size is input + cache reads + cache writes.
  const promptTokens = entry.inputIncludesCacheReads === false
    ? (usage.tokens_in ?? 0) + (usage.tokens_cache_read ?? 0) + (usage.tokens_cache_create ?? 0)
    : (usage.tokens_in ?? 0)
  const longTier = entry.longContext && promptTokens > entry.longContext.thresholdTokens
    ? entry.longContext
    : undefined
  const rates = longTier ?? entry
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
  const cacheWriteRate = longTier?.cacheWritePer1M ?? entry.cacheWritePer1M
  const cacheWriteCost = cacheWriteRate !== undefined
    ? (usage.tokens_cache_create ?? 0) * cacheWriteRate / 1_000_000
    : 0
  return inputCost + outputCost + cacheReadCost + cacheWriteCost
}

/**
 * Cost of a LOCAL (OpenAI-compatible) invocation from the connection's
 * user-supplied per-1M rates. `null` when the connection has no rates or the
 * usage is empty — never a rate-card guess for a local model.
 */
export function estimateLocalCostUsd(
  rates: { inputPer1M: number; outputPer1M: number } | null | undefined,
  usage: Pick<TokenUsage, 'tokens_in' | 'tokens_out'>,
): number | null {
  if (!rates) return null
  const tokensIn = usage.tokens_in ?? 0
  const tokensOut = usage.tokens_out ?? 0
  if (tokensIn <= 0 && tokensOut <= 0) return null
  return tokensIn / 1_000_000 * rates.inputPer1M + tokensOut / 1_000_000 * rates.outputPer1M
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
