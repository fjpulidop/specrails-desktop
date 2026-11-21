import type { SpendSurface } from './ai-invocations'

/**
 * Spend categories: the "why" behind AI spend. Every surface (recorded or
 * virtual) belongs to exactly one category so the analytics breakdown always
 * reconciles to the headline total. Pure — no I/O.
 */
export type SpendCategory = 'implementation' | 'missions' | 'specs' | 'code' | 'support'

/** Canonical display order (also the tie-break order when costs are equal). */
export const SPEND_CATEGORIES: readonly SpendCategory[] = ['implementation', 'missions', 'specs', 'code', 'support']

const CATEGORY_SURFACES: Readonly<Record<SpendCategory, readonly SpendSurface[]>> = {
  // Building specs with rails, loops and jobs.
  implementation: ['job', 'loop'],
  // Talking to the agent and Intent mode (agent ledger turns + the Intent spec rewrite).
  missions: ['mission', 'intent', 'flow'],
  // Writing and refining specs.
  specs: ['quick-spec', 'explore-spec', 'ai-edit', 'smash', 'spec-launcher', 'proposal', 'triage'],
  // Explaining the code.
  code: ['file-summary'],
  // Setup, diagnosis and side chats.
  support: ['failure-analysis', 'setup', 'agent-studio', 'chat-sidebar'],
}

const CATEGORY_BY_SURFACE: ReadonlyMap<string, SpendCategory> = new Map(
  SPEND_CATEGORIES.flatMap((category) => CATEGORY_SURFACES[category].map((surface) => [surface, category] as const)),
)

export function isSpendCategory(value: unknown): value is SpendCategory {
  return typeof value === 'string' && (SPEND_CATEGORIES as readonly string[]).includes(value)
}

/** Category of a surface. An unknown surface (written by a newer build) lands in 'support' so it is never dropped. */
export function categoryForSurface(surface: string): SpendCategory {
  return CATEGORY_BY_SURFACE.get(surface) ?? 'support'
}

/** Surfaces of a category, in canonical order. */
export function surfacesForCategory(category: SpendCategory): readonly SpendSurface[] {
  return CATEGORY_SURFACES[category]
}

/** Union of the surfaces of several categories (deduplicated, canonical order). */
export function surfacesForCategories(categories: readonly SpendCategory[]): SpendSurface[] {
  const out: SpendSurface[] = []
  for (const category of SPEND_CATEGORIES) {
    if (!categories.includes(category)) continue
    for (const surface of CATEGORY_SURFACES[category]) if (!out.includes(surface)) out.push(surface)
  }
  return out
}

/** Per-surface aggregate the category breakdown is built from. */
export interface SurfaceSpendAggregate {
  surface: SpendSurface
  costUsd: number
  /** Portion of costUsd from pricing-table estimates. */
  estimatedCostUsd: number
  count: number
  tokens: number
  unpricedCount: number
}

export interface CategorySurfaceEntry {
  surface: SpendSurface
  costUsd: number
  count: number
  tokens: number
}

export interface CategoryBreakdownEntry {
  category: SpendCategory
  costUsd: number
  estimatedCostUsd: number
  count: number
  tokens: number
  unpricedCount: number
  /** Surfaces with at least one invocation, costliest first. */
  surfaces: CategorySurfaceEntry[]
}

/**
 * Fold per-surface aggregates into the five categories. Every category is
 * returned (zeroed when empty) so the client can render a stable list; sorted
 * by cost (descending), ties in canonical order.
 */
export function buildCategoryBreakdown(aggregates: readonly SurfaceSpendAggregate[]): CategoryBreakdownEntry[] {
  const byCategory = new Map<SpendCategory, CategoryBreakdownEntry>(
    SPEND_CATEGORIES.map((category) => [category, {
      category, costUsd: 0, estimatedCostUsd: 0, count: 0, tokens: 0, unpricedCount: 0, surfaces: [],
    }]),
  )
  for (const agg of aggregates) {
    if (agg.count === 0) continue
    const entry = byCategory.get(categoryForSurface(agg.surface))!
    entry.costUsd += agg.costUsd
    entry.estimatedCostUsd += agg.estimatedCostUsd
    entry.count += agg.count
    entry.tokens += agg.tokens
    entry.unpricedCount += agg.unpricedCount
    entry.surfaces.push({ surface: agg.surface, costUsd: agg.costUsd, count: agg.count, tokens: agg.tokens })
  }
  const order = (category: SpendCategory) => SPEND_CATEGORIES.indexOf(category)
  return Array.from(byCategory.values())
    .map((entry) => ({ ...entry, surfaces: entry.surfaces.sort((a, b) => b.costUsd - a.costUsd || b.count - a.count) }))
    .sort((a, b) => b.costUsd - a.costUsd || order(a.category) - order(b.category))
}
