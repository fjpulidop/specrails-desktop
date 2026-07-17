import { describe, it, expect } from 'vitest'
import { PRICING, estimateCostUsd, lastReviewedAt, providerNeedsCostEstimation } from './pricing'
// Import the providers barrel so claude+codex are registered for the helper-
// behind-adapter test cases below.
import './providers'

describe('pricing.PRICING — table sanity', () => {
  it('has at least one codex entry', () => {
    const codexKeys = Object.keys(PRICING).filter((k) => k.startsWith('codex:'))
    expect(codexKeys.length).toBeGreaterThan(0)
  })

  it('every entry has all four required fields with sane shapes', () => {
    for (const [key, entry] of Object.entries(PRICING)) {
      expect(entry.inputPer1M, `${key}.inputPer1M`).toBeGreaterThanOrEqual(0)
      expect(entry.outputPer1M, `${key}.outputPer1M`).toBeGreaterThanOrEqual(0)
      expect(entry.cacheReadPer1M, `${key}.cacheReadPer1M`).toBeGreaterThanOrEqual(0)
      expect(entry.lastReviewedAt, `${key}.lastReviewedAt`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('output prices are always >= input prices (per OpenAI rate card structure)', () => {
    for (const [key, entry] of Object.entries(PRICING)) {
      expect(entry.outputPer1M, `${key} output should be ≥ input`).toBeGreaterThanOrEqual(entry.inputPer1M)
    }
  })

  it('cache-read prices are always <= input prices (caching is a discount)', () => {
    for (const [key, entry] of Object.entries(PRICING)) {
      expect(entry.cacheReadPer1M, `${key} cache-read should be ≤ input`).toBeLessThanOrEqual(entry.inputPer1M)
    }
  })
})

describe('estimateCostUsd', () => {
  it('bills cached tokens at cache rate only: ((in-cache)*p_in + out*p_out + cache*p_cache) / 1M', () => {
    // codex:gpt-5.4-mini → input 0.25, output 2.00, cache_read 0.025
    const cost = estimateCostUsd('codex', 'gpt-5.4-mini', {
      tokens_in: 100_000,        // TOTAL prompt tokens (includes the cached subset)
      tokens_out: 50_000,
      tokens_cache_read: 20_000, // subset already inside tokens_in
    })
    // fresh input = 100000 - 20000 = 80000
    // 80000 * 0.25  / 1M = 0.020
    // 50000 * 2.00  / 1M = 0.100
    // 20000 * 0.025 / 1M = 0.0005
    // Total ≈ 0.1205  (NOT 0.1255 — the cached 20k is not charged at full input rate)
    expect(cost).toBeCloseTo(0.1205, 4)
  })

  it('does not double-charge cached tokens (cache subset billed once, at the cache rate)', () => {
    // All input is cached → input portion is 0; only the cache-read rate applies.
    const cost = estimateCostUsd('codex', 'gpt-5.4-mini', {
      tokens_in: 50_000,
      tokens_cache_read: 50_000,
    })
    // fresh input = 0; cache = 50000 * 0.025 / 1M = 0.00125
    expect(cost).toBeCloseTo(0.00125, 6)
  })

  it('clamps fresh input at 0 when reported cache subset exceeds the total (malformed payload)', () => {
    const cost = estimateCostUsd('codex', 'gpt-5.4-mini', {
      tokens_in: 10_000,
      tokens_cache_read: 30_000, // larger than tokens_in — must not go negative
    })
    // fresh input = max(0, 10000-30000) = 0; cache = 30000 * 0.025 / 1M = 0.00075
    expect(cost).toBeCloseTo(0.00075, 6)
  })

  it('returns null when usage is entirely empty (no billable usage to price)', () => {
    // BUG-ANALYTICS-05: an all-empty usage breakdown (e.g. a codex/gemini turn
    // aborted before its usage block) must price to NULL, not the number 0, so
    // failed non-native-cost rows stay NULL like the equivalent claude row.
    expect(estimateCostUsd('codex', 'gpt-5.4-mini', {})).toBeNull()
  })

  it('returns null when every token field is explicitly 0', () => {
    expect(
      estimateCostUsd('codex', 'gpt-5.4-mini', {
        tokens_in: 0,
        tokens_out: 0,
        tokens_cache_read: 0,
      }),
    ).toBeNull()
  })

  it('returns null when only non-billable cache_create tokens are present', () => {
    // cache_create is never billed, so a cache-create-only payload has no
    // billable usage → null (not 0).
    expect(estimateCostUsd('codex', 'gpt-5.4-mini', { tokens_cache_create: 500_000 })).toBeNull()
  })

  it('still prices when any single billable field is > 0', () => {
    expect(estimateCostUsd('codex', 'gpt-5.4-mini', { tokens_out: 1 })).toBeGreaterThan(0)
  })

  it('treats missing usage fields as zero', () => {
    const cost = estimateCostUsd('codex', 'gpt-5.4-mini', { tokens_in: 1_000_000 })
    // 1M * 0.25 / 1M = 0.25 USD, no output or cache
    expect(cost).toBeCloseTo(0.25, 6)
  })

  it('ignores tokens_cache_create silently (no separate tier modelled)', () => {
    const withCacheCreate = estimateCostUsd('codex', 'gpt-5.4-mini', {
      tokens_in: 1_000_000,
      tokens_cache_create: 500_000,
    })
    const withoutCacheCreate = estimateCostUsd('codex', 'gpt-5.4-mini', {
      tokens_in: 1_000_000,
    })
    expect(withCacheCreate).toBe(withoutCacheCreate)
  })

  it('prices the GPT-5.6 family, billing cache WRITES at 1.25x input (new 5.6 semantics)', () => {
    // Sol: $5 in / $30 out / $0.50 cache-read / $6.25 cache-write per 1M.
    const sol = estimateCostUsd('codex', 'gpt-5.6-sol', {
      tokens_in: 1_000_000,
      tokens_out: 100_000,
      tokens_cache_read: 400_000, // subset of tokens_in (OpenAI semantics)
      tokens_cache_create: 200_000,
    })
    // fresh input 600k*$5 + cache-read 400k*$0.50 + out 100k*$30 + cache-write 200k*$6.25
    expect(sol).toBeCloseTo(3.0 + 0.2 + 3.0 + 1.25, 6)
    // Luna: $1 / $6 — cheapest 5.6 tier still prices.
    const luna = estimateCostUsd('codex', 'gpt-5.6-luna', { tokens_in: 1_000_000 })
    expect(luna).toBeCloseTo(1.0, 6)
    expect(estimateCostUsd('codex', 'gpt-5.6-terra', { tokens_in: 1_000_000 })).toBeCloseTo(2.5, 6)
  })

  it('returns null when model is null', () => {
    expect(estimateCostUsd('codex', null, { tokens_in: 100 })).toBeNull()
  })

  it('returns null when model is undefined', () => {
    expect(estimateCostUsd('codex', undefined, { tokens_in: 100 })).toBeNull()
  })

  it('returns null when model is empty string', () => {
    expect(estimateCostUsd('codex', '', { tokens_in: 100 })).toBeNull()
  })

  it('returns null for unknown providerId', () => {
    expect(estimateCostUsd('ghost', 'gpt-5.4-mini', { tokens_in: 100 })).toBeNull()
  })

  it('returns null for unknown model under a known provider', () => {
    expect(estimateCostUsd('codex', 'gpt-99-future', { tokens_in: 100 })).toBeNull()
  })

  it('computes deterministic cost for each table entry', () => {
    const tokens_in = 1_500_000       // 1M fresh + 500k cached (default semantics)
    const tokens_out = 1_000_000
    const tokens_cache_read = 500_000 // subset of tokens_in under default semantics
    for (const [key, entry] of Object.entries(PRICING)) {
      const [providerId, model] = key.split(':')
      const cost = estimateCostUsd(providerId!, model!, { tokens_in, tokens_out, tokens_cache_read })
      // Mirror estimateCostUsd's own branching so the property holds across the
      // three semantics now in the table: default OpenAI/Google (input includes
      // cache reads), claude (input billed as-is, inputIncludesCacheReads:false),
      // and Gemini Pro long-context (whole-request re-rate above the threshold).
      const rates =
        entry.longContext && tokens_in > entry.longContext.thresholdTokens
          ? entry.longContext
          : entry
      const freshInput =
        entry.inputIncludesCacheReads === false
          ? tokens_in
          : Math.max(0, tokens_in - tokens_cache_read)
      const expected =
        (freshInput * rates.inputPer1M +
          tokens_out * rates.outputPer1M +
          tokens_cache_read * rates.cacheReadPer1M) /
        1_000_000
      expect(cost, key).toBeCloseTo(expected, 6)
    }
  })
})

describe('estimateCostUsd — claude cache-write tier + Anthropic usage semantics (CRIT-1 / refuted-#3)', () => {
  it('bills tokens_cache_create at cacheWritePer1M (1.25x input) for claude', () => {
    // claude:sonnet → input 3.00, output 15.00, cache_read 0.30, cache_write 3.75
    const cost = estimateCostUsd('claude', 'sonnet', { tokens_cache_create: 1_000_000 })
    // Only cache-write tokens present → 1M * 3.75 / 1M = 3.75
    expect(cost).toBeCloseTo(3.75, 6)
  })

  it('cache-create-only payload IS billable for claude (opposite of codex/gemini null)', () => {
    // For providers WITHOUT a cache-write tier a cache-create-only payload
    // prices to null; claude models a cache-write tier so it must price > 0.
    expect(estimateCostUsd('claude', 'opus', { tokens_cache_create: 500_000 })).toBeGreaterThan(0)
  })

  it('bills input as-is under Anthropic semantics (does NOT subtract cache reads)', () => {
    // claude:sonnet inputIncludesCacheReads:false → input_tokens EXCLUDES cache
    // reads, so tokens_in is billed whole and cache reads add on top.
    const cost = estimateCostUsd('claude', 'sonnet', {
      tokens_in: 1_000_000,
      tokens_cache_read: 1_000_000,
    })
    // 1M * 3.00 (input, not reduced) + 1M * 0.30 (cache read) / 1M = 3.30
    expect(cost).toBeCloseTo(3.3, 6)
  })

  it('sums input + output + cache-read + cache-write for a full claude breakdown', () => {
    const cost = estimateCostUsd('claude', 'sonnet', {
      tokens_in: 100_000,
      tokens_out: 20_000,
      tokens_cache_read: 500_000,
      tokens_cache_create: 40_000,
    })
    // 100k*3.00 + 20k*15.00 + 500k*0.30 + 40k*3.75 all /1M
    // = 0.30 + 0.30 + 0.15 + 0.15 = 0.90
    expect(cost).toBeCloseTo(0.9, 6)
  })

  it('prices full claude model ids by collapsing to the family alias', () => {
    const viaFull = estimateCostUsd('claude', 'claude-sonnet-4-6', { tokens_in: 1_000_000 })
    const viaAlias = estimateCostUsd('claude', 'sonnet', { tokens_in: 1_000_000 })
    expect(viaFull).toBe(viaAlias)
    expect(viaFull).toBeCloseTo(3.0, 6)
  })
})

describe('estimateCostUsd — Gemini Pro long-context threshold tier (LOW-5)', () => {
  it('uses base rates at/below the 200k threshold', () => {
    const cost = estimateCostUsd('gemini', 'gemini-3.1-pro-preview', { tokens_in: 200_000 })
    // base input 2.00 → 200k * 2.00 / 1M = 0.40
    expect(cost).toBeCloseTo(0.4, 6)
  })

  it('re-rates the WHOLE request at long-context rates above the threshold', () => {
    const cost = estimateCostUsd('gemini', 'gemini-3.1-pro-preview', { tokens_in: 200_001 })
    // 200_001 > 200k → longContext input 4.00 over the ENTIRE prompt (not just the excess)
    expect(cost).toBeCloseTo((200_001 * 4.0) / 1_000_000, 6)
  })

  it('applies long-context output + cache-read tiers together on a large prompt', () => {
    const cost = estimateCostUsd('gemini', 'gemini-3.1-pro-preview', {
      tokens_in: 500_000,
      tokens_out: 100_000,
      tokens_cache_read: 100_000,
    })
    // >200k → longContext: input 4.00 / output 18.00 / cache_read 0.40
    // fresh input = 500k - 100k = 400k (default gemini semantics)
    // 400k*4.00 + 100k*18.00 + 100k*0.40 /1M = 1.60 + 1.80 + 0.04 = 3.44
    expect(cost).toBeCloseTo(3.44, 6)
  })

  it('flat (non-long-context) gemini models never switch tiers', () => {
    const cost = estimateCostUsd('gemini', 'gemini-3.5-flash', { tokens_in: 5_000_000 })
    // no longContext entry → base input 1.50 regardless of size
    expect(cost).toBeCloseTo((5_000_000 * 1.5) / 1_000_000, 6)
  })
})

describe('lastReviewedAt', () => {
  it('returns the oldest review date in YYYY-MM-DD format', () => {
    const date = lastReviewedAt()
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('providerNeedsCostEstimation', () => {
  it('returns true for codex (capabilities.nativeCostUsd === false)', () => {
    expect(providerNeedsCostEstimation('codex')).toBe(true)
  })

  it('returns false for claude (capabilities.nativeCostUsd === true)', () => {
    expect(providerNeedsCostEstimation('claude')).toBe(false)
  })

  it('returns false for unknown providerId (defensive)', () => {
    expect(providerNeedsCostEstimation('ghost')).toBe(false)
  })
})
