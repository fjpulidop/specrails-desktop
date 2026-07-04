import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Workflow } from 'lucide-react'
import { cn } from '../lib/utils'
import type { LocalTicket, TicketStatus } from '../types'
import { TicketStatusDot } from './TicketStatusIndicator'
import { TICKET_STATUS_ORDER } from '../lib/spec-status-filter'

interface SpecJiraStatusFilterDropdownProps {
  /** Union set the entries + counts derive from (label/epic/sprint-filtered). */
  tickets: LocalTicket[]
  /** Active RAW Jira status name, or null for "all Jira statuses" (no filter). */
  active: string | null
  onChange: (name: string | null) => void
  className?: string
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
 * Second filter dimension for Jira-connected projects: the board's REAL Jira
 * workflow statuses (raw names materialized per ticket by the inbound sync),
 * each with a live count, grouped under the logical Specrails state they map
 * to (same color language as the status chips). Selecting one filters the
 * board by raw status; raw names whose logical grouping cannot be resolved
 * land in a muted "Other" group. Shown only when at least one spec carries a
 * `jira_status` (so it's implicitly Jira-only — the epic/sprint precedent).
 */
export function SpecJiraStatusFilterDropdown({
  tickets,
  active,
  onChange,
  className,
}: SpecJiraStatusFilterDropdownProps) {
  const { t } = useTranslation('specs')
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    if (!open) return
    function onPointer(e: PointerEvent) {
      if (panelRef.current?.contains(e.target as Node)) return
      if (triggerRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function select(name: string | null) {
    onChange(name)
    setOpen(false)
  }

  const activeLogical: TicketStatus | 'other' | null = useMemo(() => {
    if (!active) return null
    for (const [g, list] of groups) if (list.some((e) => e.name === active)) return g
    return 'other'
  }, [active, groups])

  return (
    <div className={cn('relative shrink-0', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('jiraStatusFilter.ariaLabel')}
        data-testid="spec-jira-status-filter-dropdown"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-1.5 h-6 px-2 rounded-full text-[11px] font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-info/50',
          active
            ? 'bg-accent-info/10 border-accent-info/40 text-accent-info hover:bg-accent-info/20'
            : 'bg-transparent border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/40',
        )}
      >
        <Workflow className="w-3 h-3" />
        {active && activeLogical && activeLogical !== 'other' && (
          <TicketStatusDot status={activeLogical} className="w-2 h-2" />
        )}
        <span className="truncate max-w-[140px]">
          {active ?? t('jiraStatusFilter.triggerLabel')}
        </span>
      </button>

      {open && (
        <div
          ref={panelRef}
          role="listbox"
          data-testid="spec-jira-status-filter-panel"
          className="absolute z-40 left-0 mt-1 w-64 max-h-80 overflow-y-auto rounded-xl border border-border/60 bg-card/95 backdrop-blur shadow-xl shadow-black/30 p-1"
        >
          <button
            type="button"
            role="option"
            aria-selected={active === null}
            onClick={() => select(null)}
            data-testid="spec-jira-status-filter-all"
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs hover:bg-accent-info/10 transition-colors',
              active === null && 'bg-accent-info/10 text-accent-info',
            )}
          >
            <span className="inline-flex w-4 h-4 items-center justify-center">
              {active === null && <Check className="w-3 h-3 text-accent-info" />}
            </span>
            <span className="flex-1">{t('jiraStatusFilter.all')}</span>
            <span className="text-[10px] text-muted-foreground/70 tabular-nums">{total}</span>
          </button>

          {GROUP_ORDER.map((g) => {
            const list = groups.get(g)
            if (!list) return null
            const muted = g === 'other'
            return (
              <div key={g} data-testid={`spec-jira-status-group-${g}`}>
                <div
                  className={cn(
                    'flex items-center gap-1.5 px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide',
                    muted ? 'text-muted-foreground/50' : 'text-muted-foreground/80',
                  )}
                  aria-hidden
                >
                  {!muted && <TicketStatusDot status={g} className="w-2 h-2" />}
                  <span>{muted ? t('jiraStatusFilter.other') : t(GROUP_LABEL_KEYS[g])}</span>
                </div>
                {list.map((e) => {
                  const selected = active === e.name
                  return (
                    <button
                      key={e.name}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => select(e.name)}
                      data-testid={`spec-jira-status-option-${e.name}`}
                      className={cn(
                        'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs hover:bg-muted/30 transition-colors',
                        selected && 'bg-accent-info/5',
                        muted && 'opacity-70',
                      )}
                    >
                      <span className="inline-flex w-4 h-4 items-center justify-center">
                        {selected && <Check className="w-3 h-3 text-accent-info" />}
                      </span>
                      <span className="truncate text-foreground/80">{e.name}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground/60 tabular-nums">
                        {e.count}
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
