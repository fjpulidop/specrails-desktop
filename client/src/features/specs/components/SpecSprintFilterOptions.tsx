import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { LocalTicket } from '../../../types'
import { FILTER_OPTION_CLASS, FilterOptionCheck } from './SpecLabelFilterOptions'

interface SpecSprintFilterOptionsProps {
  tickets: LocalTicket[]
  /** Active sprint id, or null for "All sprints" (no filter). */
  active: string | null
  onChange: (id: string | null) => void
}

interface SprintEntry {
  id: string
  name: string
  count: number
  /** True when this is the board's active ("current") sprint. */
  active: boolean
}

/** Resolve a sprint id to its display name from the tickets (falls back to the id). */
export function sprintNameFor(tickets: LocalTicket[], id: string): string {
  return tickets.find((tk) => tk.jira_sprint_id === id && tk.jira_sprint_name)?.jira_sprint_name ?? id
}

/**
 * Sprint section of the Filters popover: single-select over the sprints in
 * the Jira-backed specs, current sprint first. Rendered only when at least one
 * spec has a sprint (so it is effectively Jira-only).
 */
export function SpecSprintFilterOptions({ tickets, active, onChange }: SpecSprintFilterOptionsProps) {
  const { t } = useTranslation('specs')

  const entries = useMemo<SprintEntry[]>(() => {
    const map = new Map<string, SprintEntry>()
    for (const tk of tickets) {
      if (!tk.jira_sprint_id) continue
      const isActive = tk.jira_sprint_state === 'active'
      const cur = map.get(tk.jira_sprint_id)
      if (cur) {
        cur.count += 1
        if (isActive) cur.active = true
      } else {
        map.set(tk.jira_sprint_id, { id: tk.jira_sprint_id, name: tk.jira_sprint_name ?? tk.jira_sprint_id, count: 1, active: isActive })
      }
    }
    // Current sprint first, then by count, then name.
    return Array.from(map.values()).sort((a, b) =>
      a.active !== b.active ? (a.active ? -1 : 1) : b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name),
    )
  }, [tickets])

  return (
    <div role="listbox" aria-label={t('sprintFilter.ariaLabel')} data-testid="spec-sprint-filter-panel" className="space-y-0.5">
      <button
        type="button"
        role="option"
        aria-selected={active === null}
        onClick={() => onChange(null)}
        data-testid="spec-sprint-filter-all"
        className={FILTER_OPTION_CLASS}
      >
        <FilterOptionCheck selected={active === null} />
        <span className="flex-1">{t('sprintFilter.all')}</span>
        <span className="tabular-nums text-muted-foreground">{tickets.length}</span>
      </button>
      {entries.map((e) => {
        const selected = active === e.id
        return (
          <button
            key={e.id}
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => onChange(e.id)}
            className={FILTER_OPTION_CLASS}
          >
            <FilterOptionCheck selected={selected} />
            <span className="truncate">{e.name}</span>
            {e.active && (
              <span
                data-testid="spec-sprint-current-badge"
                className="shrink-0 rounded-full bg-accent-success/15 px-1.5 py-0.5 text-label text-accent-success"
              >
                {t('sprintFilter.current')}
              </span>
            )}
            <span className="ml-auto tabular-nums text-muted-foreground">{e.count}</span>
          </button>
        )
      })}
    </div>
  )
}
