import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import type { LocalTicket, TicketStatus } from '../../../types'
import { TicketStatusDot } from './TicketStatusIndicator'
import { TICKET_STATUS_ORDER } from '../lib/spec-status-filter'
import { FILTER_OPTION_CLASS, FilterOptionCheck } from './SpecLabelFilterOptions'

interface SpecJiraStatusFilterOptionsProps {
  /** Union set the entries + counts derive from (label/epic/sprint-filtered). */
  tickets: LocalTicket[]
  /** Active RAW Jira status name, or null for "all Jira statuses" (no filter). */
  active: string | null
  onChange: (name: string | null) => void
}

interface RawStatusEntry {
  /** RAW Jira workflow status name, verbatim (e.g. "Code Review"). */
  name: string
  count: number
  /** Logical Specrails state the entry groups under (majority vote). */
  logical: TicketStatus | 'other'
}

/** Group headers render in lifecycle order; 'other' (unresolvable) is last, muted. */
const GROUP_ORDER: ReadonlyArray<TicketStatus | 'other'> = [...TICKET_STATUS_ORDER, 'other']

const GROUP_LABEL_KEYS: Record<TicketStatus, string> = {
  draft: 'common:status.draft',
  todo: 'status.todo',
  in_progress: 'status.inProgress',
  on_review: 'status.onReview',
  done: 'status.done',
  cancelled: 'status.cancelled',
}

/**
 * Jira-status section of the Filters popover: the board's REAL Jira workflow
 * statuses (raw names materialized per ticket by the inbound sync), each with
 * a live count, grouped under the logical Specrails state they map to. Raw
 * names whose grouping cannot be resolved land in a muted "Other" group.
 * Rendered only when at least one spec carries a `jira_status`.
 */
export function SpecJiraStatusFilterOptions({ tickets, active, onChange }: SpecJiraStatusFilterOptionsProps) {
  const { t } = useTranslation('specs')

  const { groups, total } = useMemo(() => {
    // raw name → per-logical-state tally (majority vote decides the group;
    // ties → 'other'. Mixed tallies only happen transiently, e.g. during a
    // frozen outbox window).
    const tally = new Map<string, Map<TicketStatus, number>>()
    let totalWithRaw = 0
    for (const tk of tickets) {
      if (!tk.jira_status) continue
      totalWithRaw += 1
      let m = tally.get(tk.jira_status)
      if (!m) {
        m = new Map()
        tally.set(tk.jira_status, m)
      }
      m.set(tk.status, (m.get(tk.status) ?? 0) + 1)
    }
    const entries: RawStatusEntry[] = []
    for (const [name, m] of tally) {
      let count = 0
      let best: TicketStatus | 'other' = 'other'
      let bestN = 0
      let tie = false
      for (const s of TICKET_STATUS_ORDER) {
        const n = m.get(s) ?? 0
        count += n
        if (n > bestN) {
          best = s
          bestN = n
          tie = false
        } else if (n === bestN && n > 0) {
          tie = true
        }
      }
      entries.push({ name, count, logical: tie ? 'other' : best })
    }
    const byGroup = new Map<TicketStatus | 'other', RawStatusEntry[]>()
    for (const g of GROUP_ORDER) {
      const list = entries
        .filter((e) => e.logical === g)
        .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name)))
      if (list.length > 0) byGroup.set(g, list)
    }
    return { groups: byGroup, total: totalWithRaw }
  }, [tickets])

  return (
    <div
      role="listbox"
      aria-label={t('jiraStatusFilter.ariaLabel')}
      data-testid="spec-jira-status-filter-panel"
      className="space-y-0.5"
    >
      <button
        type="button"
        role="option"
        aria-selected={active === null}
        onClick={() => onChange(null)}
        data-testid="spec-jira-status-filter-all"
        className={FILTER_OPTION_CLASS}
      >
        <FilterOptionCheck selected={active === null} />
        <span className="flex-1">{t('jiraStatusFilter.all')}</span>
        <span className="tabular-nums text-muted-foreground">{total}</span>
      </button>

      {GROUP_ORDER.map((g) => {
        const list = groups.get(g)
        if (!list) return null
        const other = g === 'other'
        return (
          <div key={g} role="group" aria-label={other ? t('jiraStatusFilter.other') : t(GROUP_LABEL_KEYS[g])} data-testid={`spec-jira-status-group-${g}`}>
            <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-label text-muted-foreground" aria-hidden>
              {!other && <TicketStatusDot status={g} className="w-2 h-2" />}
              <span>{other ? t('jiraStatusFilter.other') : t(GROUP_LABEL_KEYS[g])}</span>
            </div>
            {list.map((e) => {
              const selected = active === e.name
              return (
                <button
                  key={e.name}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => onChange(e.name)}
                  data-testid={`spec-jira-status-option-${e.name}`}
                  className={cn(FILTER_OPTION_CLASS, other && 'text-muted-foreground')}
                >
                  <FilterOptionCheck selected={selected} />
                  <span className="truncate">{e.name}</span>
                  <span className="ml-auto tabular-nums text-muted-foreground">{e.count}</span>
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
