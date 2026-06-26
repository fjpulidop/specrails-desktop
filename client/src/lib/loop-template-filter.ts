/**
 * Pure, testable filtering for the loop-template gallery. Kept outside the page
 * component so the search + category-chip logic is unit-tested without rendering.
 *
 * The category order mirrors the server's `LOOP_CATEGORIES` taxonomy so the chips
 * render in a stable, intentional order regardless of catalog insertion order.
 */

/** The 15-value taxonomy, in canonical chip order (mirror of the server). */
export const LOOP_CATEGORY_ORDER = [
  'API', 'Automation', 'CI', 'Database', 'Debugging', 'DevOps', 'Docs', 'Git',
  'Maintenance', 'Performance', 'Planning', 'Quality', 'Review', 'Security', 'Testing',
] as const

/** Minimal shape the filter needs; the real `LoopTemplateSummary` is a superset. */
export interface FilterableTemplate {
  name: string
  description: string
  tags: string[]
  category?: string
  /** Extra already-localized text (translated name/description/category label)
   *  searched IN ADDITION to the raw fields, so a query in the user's language
   *  matches the strings actually shown on the card. Optional. */
  searchTerms?: string
}

export interface TemplateFilter {
  /** Free-text query (matched case-insensitively over name/description/tags/category). */
  query: string
  /** Selected category chips. Empty ⇒ no category restriction. */
  categories: string[]
}

/** A template matches when it satisfies BOTH the query (substring over its text)
 *  AND the category selection (its category is among the selected, when any). */
export function filterTemplates<T extends FilterableTemplate>(templates: T[], filter: TemplateFilter): T[] {
  const q = filter.query.trim().toLowerCase()
  const cats = filter.categories
  return templates.filter((t) => {
    if (cats.length > 0 && !(t.category && cats.includes(t.category))) return false
    if (!q) return true
    const haystack = `${t.name} ${t.description} ${t.tags.join(' ')} ${t.category ?? ''} ${t.searchTerms ?? ''}`.toLowerCase()
    return haystack.includes(q)
  })
}

/** Per-category counts over the catalog, in canonical taxonomy order. Only
 *  categories that actually appear are returned (so the chip row never shows an
 *  empty category). Unknown categories (not in the taxonomy) are appended last. */
export function categoryCounts(templates: FilterableTemplate[]): { category: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const t of templates) {
    if (!t.category) continue
    counts.set(t.category, (counts.get(t.category) ?? 0) + 1)
  }
  const ordered: { category: string; count: number }[] = []
  for (const c of LOOP_CATEGORY_ORDER) {
    const n = counts.get(c)
    if (n) { ordered.push({ category: c, count: n }); counts.delete(c) }
  }
  // Any non-taxonomy categories (defensive) appended alphabetically.
  for (const c of [...counts.keys()].sort()) ordered.push({ category: c, count: counts.get(c)! })
  return ordered
}
