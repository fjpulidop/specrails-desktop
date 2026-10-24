import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { BoardToolbarRow, BoardToolbarSpacer } from '../../../components/ui/board-toolbar'

export interface ActiveFilterChip {
  key: string
  label: string
  onRemove: () => void
}

interface SpecActiveFiltersProps {
  chips: ActiveFilterChip[]
  /** Specs currently visible on the board. */
  shown: number
  /** Specs in the project (before any narrowing). */
  total: number
  onClearAll: () => void
  /** "+N" overflow chip: opens the Filters popover. */
  onOverflowClick: () => void
}

const MAX_CHIPS = 6

/**
 * Third Specs toolbar row, shown only while search or a filter beyond status
 * narrows the board: one removable chip per active value, "x of y" and a
 * Clear all. Status is not a chip: the status row already shows it.
 */
export function SpecActiveFilters({ chips, shown, total, onClearAll, onOverflowClick }: SpecActiveFiltersProps) {
  const { t } = useTranslation('specs')
  const visible = chips.slice(0, MAX_CHIPS)
  const hidden = chips.length - visible.length

  return (
    <BoardToolbarRow size="tertiary" data-testid="specs-active-filters" className="gap-1.5">
      {visible.map((chip) => (
        <span
          key={chip.key}
          data-testid={`specs-filter-chip-${chip.key}`}
          className="inline-flex items-center gap-1 h-6 max-w-[220px] pl-2 pr-0.5 rounded-md border border-border/60 bg-muted/30 text-xs text-foreground"
        >
          <span className="truncate">{chip.label}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              chip.onRemove()
            }}
            aria-label={t('filters.removeChip', { label: chip.label })}
            data-testid={`specs-filter-chip-remove-${chip.key}`}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="w-3 h-3" aria-hidden />
          </button>
        </span>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOverflowClick()
          }}
          data-testid="specs-filter-chip-overflow"
          className="inline-flex items-center h-6 px-2 rounded-md border border-border/60 bg-muted/30 text-xs text-foreground tabular-nums hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('filters.more', { count: hidden })}
        </button>
      )}
      <span className="ml-1 text-xs text-muted-foreground tabular-nums whitespace-nowrap" data-testid="specs-result-count">
        {t('filters.resultCount', { shown, total })}
      </span>
      <BoardToolbarSpacer />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClearAll()
        }}
        data-testid="specs-active-filters-clear"
        className="h-6 shrink-0 rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('filters.clearAll')}
      </button>
    </BoardToolbarRow>
  )
}
