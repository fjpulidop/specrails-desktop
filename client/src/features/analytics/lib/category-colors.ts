import { useMemo } from 'react'
import { useActiveTheme } from '../../settings/context/ThemeContext'
import { SPEND_CATEGORIES, categoryForSurface, type SpendCategory, type SpendingResponse } from '../types/spending'

/**
 * Spend-category colours: the theme's chart palette in the canonical category
 * order, so a category keeps its colour on every chart, legend and row. Never
 * a lamp token: a category is not a state.
 */
export function categoryColors(chart: readonly string[]): Record<SpendCategory, string> {
  return Object.fromEntries(SPEND_CATEGORIES.map((category, index) => [category, chart[index % chart.length]])) as Record<SpendCategory, string>
}

export function useCategoryColors(): Record<SpendCategory, string> {
  const theme = useActiveTheme()
  return useMemo(() => categoryColors(theme.chart), [theme.chart])
}

/** A surface draws in its category's colour. */
export function surfaceColor(colors: Record<SpendCategory, string>, surface: string): string {
  return colors[categoryForSurface(surface)]
}

export interface CategorySpend { category: SpendCategory; costUsd: number; count: number }

/**
 * Spend per category in canonical order, from `byCategory` when the server
 * sends it, else folded from `bySurface` (older servers). Unknown surfaces
 * land in 'support', like the server, so the total always reconciles.
 */
export function categorySpend(data: Pick<SpendingResponse, 'byCategory' | 'bySurface'>): CategorySpend[] {
  const totals = new Map<SpendCategory, CategorySpend>(SPEND_CATEGORIES.map((category) => [category, { category, costUsd: 0, count: 0 }]))
  if (data.byCategory && data.byCategory.length > 0) {
    for (const entry of data.byCategory) {
      const row = totals.get(entry.category)
      if (row) { row.costUsd += entry.costUsd; row.count += entry.count }
    }
  } else {
    for (const entry of data.bySurface) {
      const row = totals.get(categoryForSurface(entry.surface))!
      row.costUsd += entry.costUsd
      row.count += entry.count
    }
  }
  return SPEND_CATEGORIES.map((category) => totals.get(category)!)
}
