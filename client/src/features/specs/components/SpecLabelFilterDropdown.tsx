import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Tag } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { hashLabelToTone } from './SpecLabelFilterStrip'
import type { LocalTicket } from '../../../types'

interface SpecLabelFilterDropdownProps {
  tickets: LocalTicket[]
  /** Empty set ⇒ "All" (no filter). Non-empty ⇒ multi-selection (OR-match). */
  active: Set<string>
  onChange: (next: Set<string>) => void
  className?: string
}

const TONE_CHIP: Record<string, string> = {
  'accent-primary': 'bg-accent-primary/20 text-accent-primary',
  'accent-info': 'bg-accent-info/20 text-accent-info',
  'accent-success': 'bg-accent-success/20 text-accent-success',
  'accent-secondary': 'bg-accent-secondary/20 text-accent-secondary',
  'accent-warning': 'bg-accent-warning/20 text-accent-warning',
  'accent-highlight': 'bg-accent-highlight/20 text-accent-highlight',
}

/**
 * Dropdown replacement for the inline carousel `SpecLabelFilterStrip`.
 * Shows `All` (default, no filter) and a checkbox-style multi-select list
 * of every label present in the current ticket set. At least one label must
 * stay selected once the user leaves "All"; toggling the last selected
 * label off snaps back to "All".
 */
export function SpecLabelFilterDropdown({ tickets, active, onChange, className }: SpecLabelFilterDropdownProps) {
  const { t } = useTranslation('specs')
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const entries = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of tickets) {
      for (const raw of t.labels ?? []) {
        const label = raw.trim()
        if (!label) continue
        counts.set(label, (counts.get(label) ?? 0) + 1)
      }
    }
    return Array.from(counts.entries()).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      return a[0].localeCompare(b[0])
    })
  }, [tickets])

  // Close on outside-click / Escape.
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

  function toggleLabel(label: string) {
    const next = new Set(active)
    if (next.has(label)) {
      next.delete(label)
    } else {
      next.add(label)
    }
    onChange(next)
  }

  function selectAll() {
    onChange(new Set())
  }

  const triggerLabel = active.size === 0
    ? t('labelFilter.all')
    : active.size === 1
      ? Array.from(active)[0]
      : t('labelFilter.selected', { count: active.size })

  return (
    <div className={cn('relative shrink-0', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('labelFilter.ariaLabel')}
        data-testid="spec-label-filter-dropdown"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 h-7 px-2 rounded-md text-xs bg-accent-secondary/10 border border-accent-secondary/30 hover:bg-accent-secondary/20 text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary/50"
      >
        <Tag className="w-3 h-3 text-muted-foreground" />
        <span className="truncate max-w-[120px]">{triggerLabel}</span>
        {active.size > 0 && (
          <span className="text-[10px] text-muted-foreground/80">·&nbsp;{active.size}</span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="listbox"
          aria-multiselectable="true"
          data-testid="spec-label-filter-panel"
          className="absolute z-40 left-0 mt-1 w-56 max-h-72 overflow-y-auto rounded-xl border border-border/60 bg-card/95 backdrop-blur shadow-xl shadow-black/30 p-1"
        >
          {/* All — clears the active set */}
          <button
            type="button"
            role="option"
            aria-selected={active.size === 0}
            onClick={selectAll}
            data-testid="spec-label-filter-all"
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs hover:bg-accent-info/10 transition-colors',
              active.size === 0 && 'bg-accent-info/10 text-accent-info',
            )}
          >
            <span className="inline-flex w-4 h-4 items-center justify-center">
              {active.size === 0 && <Check className="w-3 h-3 text-accent-info" />}
            </span>
            <span className="flex-1">{t('labelFilter.all')}</span>
            <span className="text-[10px] text-muted-foreground/70">{tickets.length}</span>
          </button>

          {entries.length === 0 && (
            <div className="px-2 py-2 text-[11px] text-muted-foreground/60 italic">{t('labelFilter.empty')}</div>
          )}

          {entries.length > 0 && (
            <div className="my-1 h-px bg-border/40" aria-hidden />
          )}

          {entries.map(([label, count]) => {
            const selected = active.has(label)
            const tone = TONE_CHIP[hashLabelToTone(label)] ?? 'bg-muted/40 text-foreground'
            return (
              <button
                key={label}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => toggleLabel(label)}
                className={cn(
                  'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs hover:bg-muted/30 transition-colors',
                  selected && 'bg-accent-info/5',
                )}
              >
                <span className="inline-flex w-4 h-4 items-center justify-center">
                  {selected && <Check className="w-3 h-3 text-accent-info" />}
                </span>
                <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium', tone)}>
                  {label}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground/60">{count}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
