import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Layers } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { LocalTicket } from '../../../types'

interface SpecEpicFilterDropdownProps {
  tickets: LocalTicket[]
  /** Active epic key, or null for "All epics" (no filter). */
  active: string | null
  onChange: (key: string | null) => void
  className?: string
}

interface EpicEntry {
  key: string
  name: string
  count: number
}

/**
 * Single-select filter over the parent epics present in the current Jira-backed
 * specs. Shown only when at least one spec has an epic (so it's effectively
 * Jira-only). Picking an epic filters the board to that epic; "All epics" clears.
 */
export function SpecEpicFilterDropdown({ tickets, active, onChange, className }: SpecEpicFilterDropdownProps) {
  const { t } = useTranslation('specs')
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

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

  function select(key: string | null) {
    onChange(key)
    setOpen(false)
  }

  const activeEntry = active ? entries.find((e) => e.key === active) : null
  const triggerLabel = activeEntry ? activeEntry.name : t('epicFilter.all')

  return (
    <div className={cn('relative shrink-0', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('epicFilter.ariaLabel')}
        data-testid="spec-epic-filter-dropdown"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 h-7 px-2 rounded-md text-xs bg-accent-highlight/10 border border-accent-highlight/30 hover:bg-accent-highlight/20 text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-highlight/50"
      >
        <Layers className="w-3 h-3 text-muted-foreground" />
        <span className="truncate max-w-[140px]">{triggerLabel}</span>
      </button>

      {open && (
        <div
          ref={panelRef}
          role="listbox"
          data-testid="spec-epic-filter-panel"
          className="absolute z-40 left-0 mt-1 w-64 max-h-72 overflow-y-auto rounded-xl border border-border/60 bg-card/95 backdrop-blur shadow-xl shadow-black/30 p-1"
        >
          <button
            type="button"
            role="option"
            aria-selected={active === null}
            onClick={() => select(null)}
            data-testid="spec-epic-filter-all"
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs hover:bg-accent-info/10 transition-colors',
              active === null && 'bg-accent-info/10 text-accent-info',
            )}
          >
            <span className="inline-flex w-4 h-4 items-center justify-center">
              {active === null && <Check className="w-3 h-3 text-accent-info" />}
            </span>
            <span className="flex-1">{t('epicFilter.all')}</span>
            <span className="text-[10px] text-muted-foreground/70">{tickets.length}</span>
          </button>

          {entries.length > 0 && <div className="my-1 h-px bg-border/40" aria-hidden />}

          {entries.map((e) => {
            const selected = active === e.key
            return (
              <button
                key={e.key}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => select(e.key)}
                className={cn(
                  'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs hover:bg-muted/30 transition-colors',
                  selected && 'bg-accent-info/5',
                )}
              >
                <span className="inline-flex w-4 h-4 items-center justify-center">
                  {selected && <Check className="w-3 h-3 text-accent-info" />}
                </span>
                <span className="font-mono text-[10px] text-accent-highlight shrink-0">{e.key}</span>
                <span className="truncate text-foreground/80">{e.name}</span>
                <span className="ml-auto text-[10px] text-muted-foreground/60">{e.count}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
