import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { LocalTicket } from '../../../types'
import { FILTER_OPTION_CLASS, FilterOptionCheck } from './SpecLabelFilterOptions'

interface SpecEpicFilterOptionsProps {
  tickets: LocalTicket[]
  /** Active epic key, or null for "All epics" (no filter). */
  active: string | null
  onChange: (key: string | null) => void
}

interface EpicEntry {
  key: string
  name: string
  count: number
}

/** Resolve an epic key to its display name from the tickets (falls back to the key). */
export function epicNameFor(tickets: LocalTicket[], key: string): string {
  return tickets.find((tk) => tk.jira_epic_key === key && tk.jira_epic_name)?.jira_epic_name ?? key
}

/**
 * Epic section of the Filters popover: single-select over the parent epics
 * present in the Jira-backed specs. Rendered only when at least one spec has
 * an epic (so it is effectively Jira-only).
 */
export function SpecEpicFilterOptions({ tickets, active, onChange }: SpecEpicFilterOptionsProps) {
  const { t } = useTranslation('specs')

  const entries = useMemo<EpicEntry[]>(() => {
    const map = new Map<string, EpicEntry>()
    for (const tk of tickets) {
      if (!tk.jira_epic_key) continue
      const cur = map.get(tk.jira_epic_key)
      if (cur) cur.count += 1
      else map.set(tk.jira_epic_key, { key: tk.jira_epic_key, name: tk.jira_epic_name ?? tk.jira_epic_key, count: 1 })
    }
    return Array.from(map.values()).sort((a, b) => (b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name)))
  }, [tickets])

  return (
    <div role="listbox" aria-label={t('epicFilter.ariaLabel')} data-testid="spec-epic-filter-panel" className="space-y-0.5">
      <button
        type="button"
        role="option"
        aria-selected={active === null}
        onClick={() => onChange(null)}
        data-testid="spec-epic-filter-all"
        className={FILTER_OPTION_CLASS}
      >
        <FilterOptionCheck selected={active === null} />
        <span className="flex-1">{t('epicFilter.all')}</span>
        <span className="tabular-nums text-muted-foreground">{tickets.length}</span>
      </button>
      {entries.map((e) => {
        const selected = active === e.key
        return (
          <button
            key={e.key}
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => onChange(e.key)}
            className={FILTER_OPTION_CLASS}
          >
            <FilterOptionCheck selected={selected} />
            <span className="font-mono text-xs text-muted-foreground shrink-0">{e.key}</span>
            <span className="truncate">{e.name}</span>
            <span className="ml-auto tabular-nums text-muted-foreground">{e.count}</span>
          </button>
        )
      })}
    </div>
  )
}
