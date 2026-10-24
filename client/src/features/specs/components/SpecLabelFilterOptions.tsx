import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { hashLabelToTone } from './SpecLabelFilterStrip'
import type { LocalTicket } from '../../../types'

interface SpecLabelFilterOptionsProps {
  tickets: LocalTicket[]
  /** Empty set ⇒ "All labels" (no filter). Non-empty ⇒ multi-selection (OR-match). */
  active: Set<string>
  onChange: (next: Set<string>) => void
}

const TONE_CHIP: Record<string, string> = {
  'accent-primary': 'bg-accent-primary/20 text-accent-primary',
  'accent-info': 'bg-accent-info/20 text-accent-info',
  'accent-success': 'bg-accent-success/20 text-accent-success',
  'accent-secondary': 'bg-accent-secondary/20 text-accent-secondary',
  'accent-warning': 'bg-accent-warning/20 text-accent-warning',
  'accent-highlight': 'bg-accent-highlight/20 text-accent-highlight',
}

/** Shared option-row skin for every Filters-popover section. */
export const FILTER_OPTION_CLASS =
  'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs text-foreground hover:bg-muted/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export function FilterOptionCheck({ selected }: { selected: boolean }) {
  return (
    <span className="inline-flex w-4 h-4 shrink-0 items-center justify-center" aria-hidden>
      {selected && <Check className="w-3.5 h-3.5 text-accent-primary" />}
    </span>
  )
}

/** Labels with more entries than this get a local "Find a label" input. */
const FIND_THRESHOLD = 8

/**
 * Labels section of the Filters popover: "All labels" plus a checkbox-style
 * multi-select of every label present in the board's tickets (OR-match).
 * Toggling the last selected label off returns to "All labels".
 */
export function SpecLabelFilterOptions({ tickets, active, onChange }: SpecLabelFilterOptionsProps) {
  const { t } = useTranslation('specs')
  const [find, setFind] = useState('')

  const entries = useMemo(() => {
    const counts = new Map<string, number>()
    for (const tk of tickets) {
      for (const raw of tk.labels ?? []) {
        const label = raw.trim()
        if (!label) continue
        counts.set(label, (counts.get(label) ?? 0) + 1)
      }
    }
    return Array.from(counts.entries()).sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
  }, [tickets])

  const needle = find.trim().toLowerCase()
  const shown = needle ? entries.filter(([label]) => label.toLowerCase().includes(needle)) : entries

  function toggleLabel(label: string) {
    const next = new Set(active)
    if (next.has(label)) next.delete(label)
    else next.add(label)
    onChange(next)
  }

  return (
    <div
      role="listbox"
      aria-multiselectable="true"
      aria-label={t('labelFilter.ariaLabel')}
      data-testid="spec-label-filter-panel"
      className="space-y-0.5"
    >
      <button
        type="button"
        role="option"
        aria-selected={active.size === 0}
        onClick={() => onChange(new Set())}
        data-testid="spec-label-filter-all"
        className={FILTER_OPTION_CLASS}
      >
        <FilterOptionCheck selected={active.size === 0} />
        <span className="flex-1">{t('labelFilter.all')}</span>
        <span className="tabular-nums text-muted-foreground">{tickets.length}</span>
      </button>

      {entries.length === 0 && (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('labelFilter.empty')}</p>
      )}

      {entries.length > FIND_THRESHOLD && (
        <div className="px-1 py-1">
          <input
            type="search"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              // Escape clears the local find first; a second press closes the popover.
              if (e.key === 'Escape' && find) {
                e.preventDefault()
                e.stopPropagation()
                setFind('')
              }
            }}
            placeholder={t('filters.findLabel')}
            aria-label={t('filters.findLabel')}
            data-testid="spec-label-filter-find"
            className="h-7 w-full rounded-md border border-border/60 bg-muted/20 px-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:appearance-none"
          />
        </div>
      )}

      {shown.map(([label, count]) => {
        const selected = active.has(label)
        const tone = TONE_CHIP[hashLabelToTone(label)] ?? 'bg-muted/40 text-foreground'
        return (
          <button
            key={label}
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => toggleLabel(label)}
            className={FILTER_OPTION_CLASS}
          >
            <FilterOptionCheck selected={selected} />
            <span className={cn('inline-flex min-w-0 items-center px-1.5 py-0.5 rounded-full text-label truncate', tone)}>
              {label}
            </span>
            <span className="ml-auto tabular-nums text-muted-foreground">{count}</span>
          </button>
        )
      })}
    </div>
  )
}
