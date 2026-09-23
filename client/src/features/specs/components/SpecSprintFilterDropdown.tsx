import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Timer } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { LocalTicket } from '../../../types'

interface SpecSprintFilterDropdownProps {
  tickets: LocalTicket[]
  /** Active sprint id, or null for "All sprints" (no filter). */
  active: string | null
  onChange: (id: string | null) => void
  className?: string
}

interface SprintEntry {
  id: string
  name: string
  count: number
  /** True when this is the board's active ("current") sprint. */
  active: boolean
}

/**
 * Single-select filter over the sprints present in the current Jira-backed
 * specs. Shown only when at least one spec has a sprint (so it's effectively
 * Jira-only). Picking a sprint filters the board to it; "All sprints" clears.
 */
export function SpecSprintFilterDropdown({ tickets, active, onChange, className }: SpecSprintFilterDropdownProps) {
  const { t } = useTranslation('specs')
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

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

  function select(id: string | null) {
    onChange(id)
    setOpen(false)
  }

  const activeEntry = active ? entries.find((e) => e.id === active) : null
  const triggerLabel = activeEntry ? activeEntry.name : t('sprintFilter.all')

  return (
    <div className={cn('relative shrink-0', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('sprintFilter.ariaLabel')}
        data-testid="spec-sprint-filter-dropdown"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 h-7 px-2 rounded-md text-xs bg-accent-success/10 border border-accent-success/30 hover:bg-accent-success/20 text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-success/50"
      >
        <Timer className="w-3 h-3 text-muted-foreground" />
        <span className="truncate max-w-[140px]">{triggerLabel}</span>
      </button>

      {open && (
        <div
          ref={panelRef}
          role="listbox"
          data-testid="spec-sprint-filter-panel"
          className="absolute z-40 left-0 mt-1 w-64 max-h-72 overflow-y-auto rounded-xl border border-border/60 bg-card/95 backdrop-blur shadow-xl shadow-black/30 p-1"
        >
          <button
            type="button"
            role="option"
            aria-selected={active === null}
            onClick={() => select(null)}
            data-testid="spec-sprint-filter-all"
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs hover:bg-accent-info/10 transition-colors',
              active === null && 'bg-accent-info/10 text-accent-info',
            )}
          >
            <span className="inline-flex w-4 h-4 items-center justify-center">
              {active === null && <Check className="w-3 h-3 text-accent-info" />}
            </span>
            <span className="flex-1">{t('sprintFilter.all')}</span>
            <span className="text-[10px] text-muted-foreground/70">{tickets.length}</span>
          </button>

          {entries.length > 0 && <div className="my-1 h-px bg-border/40" aria-hidden />}

          {entries.map((e) => {
            const selected = active === e.id
            return (
              <button
                key={e.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => select(e.id)}
                className={cn(
                  'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs hover:bg-muted/30 transition-colors',
                  selected && 'bg-accent-info/5',
                )}
              >
                <span className="inline-flex w-4 h-4 items-center justify-center">
                  {selected && <Check className="w-3 h-3 text-accent-info" />}
                </span>
                <span className="truncate text-foreground/80">{e.name}</span>
                {e.active && (
                  <span
                    data-testid="spec-sprint-current-badge"
                    className="shrink-0 rounded-full bg-accent-success/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-accent-success"
                  >
                    {t('sprintFilter.current')}
                  </span>
                )}
                <span className="ml-auto text-[10px] text-muted-foreground/60">{e.count}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
