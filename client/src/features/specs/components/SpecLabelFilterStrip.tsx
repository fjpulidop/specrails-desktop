import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { LocalTicket } from '../../../types'

const TONES = [
  'accent-primary',
  'accent-info',
  'accent-success',
  'accent-secondary',
  'accent-warning',
  'accent-highlight',
] as const

type Tone = (typeof TONES)[number]

interface ToneClasses {
  base: string
  idle: string
  hover: string
  active: string
  count: string
  ring: string
}

const TONE_CLASSES: Record<Tone, ToneClasses> = {
  'accent-primary': {
    base: 'border',
    idle: 'bg-accent-primary/10 text-accent-primary border-accent-primary/20',
    hover: 'hover:bg-accent-primary/20 hover:border-accent-primary/35',
    active: 'bg-accent-primary/25 text-accent-primary border-accent-primary/60 ring-1 ring-accent-primary/30',
    count: 'text-accent-primary/60',
    ring: 'focus-visible:ring-accent-primary/50',
  },
  'accent-info': {
    base: 'border',
    idle: 'bg-accent-info/10 text-accent-info border-accent-info/20',
    hover: 'hover:bg-accent-info/20 hover:border-accent-info/35',
    active: 'bg-accent-info/25 text-accent-info border-accent-info/60 ring-1 ring-accent-info/30',
    count: 'text-accent-info/60',
    ring: 'focus-visible:ring-accent-info/50',
  },
  'accent-success': {
    base: 'border',
    idle: 'bg-accent-success/10 text-accent-success border-accent-success/20',
    hover: 'hover:bg-accent-success/20 hover:border-accent-success/35',
    active: 'bg-accent-success/25 text-accent-success border-accent-success/60 ring-1 ring-accent-success/30',
    count: 'text-accent-success/60',
    ring: 'focus-visible:ring-accent-success/50',
  },
  'accent-secondary': {
    base: 'border',
    idle: 'bg-accent-secondary/10 text-accent-secondary border-accent-secondary/20',
    hover: 'hover:bg-accent-secondary/20 hover:border-accent-secondary/35',
    active: 'bg-accent-secondary/25 text-accent-secondary border-accent-secondary/60 ring-1 ring-accent-secondary/30',
    count: 'text-accent-secondary/60',
    ring: 'focus-visible:ring-accent-secondary/50',
  },
  'accent-warning': {
    base: 'border',
    idle: 'bg-accent-warning/10 text-accent-warning border-accent-warning/20',
    hover: 'hover:bg-accent-warning/20 hover:border-accent-warning/35',
    active: 'bg-accent-warning/25 text-accent-warning border-accent-warning/60 ring-1 ring-accent-warning/30',
    count: 'text-accent-warning/60',
    ring: 'focus-visible:ring-accent-warning/50',
  },
  'accent-highlight': {
    base: 'border',
    idle: 'bg-accent-highlight/10 text-accent-highlight border-accent-highlight/20',
    hover: 'hover:bg-accent-highlight/20 hover:border-accent-highlight/35',
    active: 'bg-accent-highlight/25 text-accent-highlight border-accent-highlight/60 ring-1 ring-accent-highlight/30',
    count: 'text-accent-highlight/60',
    ring: 'focus-visible:ring-accent-highlight/50',
  },
}

export function hashLabelToTone(label: string): Tone {
  let hash = 0x811c9dc5
  const lower = label.toLowerCase()
  for (let i = 0; i < lower.length; i += 1) {
    hash ^= lower.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return TONES[hash % TONES.length]
}

interface SpecLabelFilterStripProps {
  tickets: LocalTicket[]
  active: Set<string>
  onToggle: (label: string) => void
  onClear: () => void
}

export function SpecLabelFilterStrip({ tickets, active, onToggle, onClear }: SpecLabelFilterStripProps) {
  const { t } = useTranslation('specs')
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

  const scrollRef = useRef<HTMLDivElement>(null)

  if (entries.length === 0) return null

  function handleWheel(e: React.WheelEvent<HTMLDivElement>) {
    const el = scrollRef.current
    if (!el) return
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    const max = el.scrollWidth - el.clientWidth
    if (max <= 0) return
    const next = el.scrollLeft + e.deltaY
    const atStart = el.scrollLeft <= 0 && e.deltaY < 0
    const atEnd = el.scrollLeft >= max && e.deltaY > 0
    if (atStart || atEnd) return
    e.preventDefault()
    el.scrollLeft = Math.max(0, Math.min(max, next))
  }

  return (
    <div
      ref={scrollRef}
      onWheel={handleWheel}
      className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(90deg,transparent,black_12px,black_calc(100%-12px),transparent)] mx-2"
      data-testid="spec-label-filter-strip"
    >
      {active.size > 0 && (
        <button
          type="button"
          onClick={onClear}
          data-testid="spec-label-filter-clear"
          className="shrink-0 inline-flex items-center gap-1 h-5 px-2 rounded-full text-[10px] font-medium border border-border/50 bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border"
        >
          <X className="w-2.5 h-2.5" />
          <span>{active.size}</span>
          <span className="opacity-60">·</span>
          <span>{t('labelFilter.clear')}</span>
        </button>
      )}
      {entries.map(([label, count]) => {
        const tone = hashLabelToTone(label)
        const cls = TONE_CLASSES[tone]
        const isActive = active.has(label)
        return (
          <button
            key={label}
            type="button"
            aria-pressed={isActive}
            onClick={() => onToggle(label)}
            className={[
              'shrink-0 inline-flex items-center gap-1 h-5 px-2 rounded-full text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1',
              cls.base,
              isActive ? cls.active : `${cls.idle} ${cls.hover}`,
              cls.ring,
            ].join(' ')}
          >
            <span className="truncate max-w-[140px]">{label}</span>
            <span className={cls.count} aria-hidden="true">·</span>
            <span className={cls.count}>{count}</span>
          </button>
        )
      })}
    </div>
  )
}
