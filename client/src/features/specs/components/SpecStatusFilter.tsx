import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { TicketStatus } from '../../../types'
import { TicketStatusDot } from './TicketStatusIndicator'
import { useElementWidth } from '../../../hooks/useElementWidth'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu'
import {
  ACTIVE_STATUSES,
  TICKET_STATUS_ORDER,
  type SpecStatusFilterValue,
} from '../lib/spec-status-filter'

/** Layout tier, chosen from the measured row width (never the viewport). */
export type StatusTier = 'full' | 'compact' | 'menu'

interface SpecStatusFilterProps {
  /** Current selection. */
  value: SpecStatusFilterValue
  onChange: (v: SpecStatusFilterValue) => void
  /** Live per-status counts (after the label/epic/sprint/search filters). */
  counts: Record<TicketStatus, number>
  /** Counts are not known yet (first load): render `–` instead of numbers. */
  loading?: boolean
  /** Tests only: pin a tier instead of measuring. */
  forceTier?: StatusTier
  className?: string
}

const BUCKETS = ['active', 'all'] as const
const PINNED_STATUS: TicketStatus = 'done'
const MENU_STATUSES: readonly TicketStatus[] = TICKET_STATUS_ORDER.filter((s) => s !== PINNED_STATUS)
const ALL_VALUES: readonly SpecStatusFilterValue[] = [...BUCKETS, ...TICKET_STATUS_ORDER]
/** Below this row width even the compact track is too cramped. */
const MIN_COMPACT_WIDTH = 300

/** i18n label per value — statuses reuse the exact pill labels. */
const LABEL_KEYS: Record<SpecStatusFilterValue, string> = {
  active: 'statusFilter.active',
  all: 'statusFilter.all',
  draft: 'common:status.draft',
  todo: 'status.todo',
  in_progress: 'status.inProgress',
  on_review: 'status.onReview',
  done: 'status.done',
  cancelled: 'status.cancelled',
}

const isStatus = (v: SpecStatusFilterValue): v is TicketStatus => v !== 'active' && v !== 'all'

const SEGMENT_BASE =
  'inline-flex items-center gap-1.5 h-7 px-2.5 shrink-0 rounded-md text-label whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const SEGMENT_SELECTED = 'bg-background text-foreground shadow-sm ring-1 ring-border/70'
const SEGMENT_IDLE = 'text-muted-foreground hover:text-foreground hover:bg-muted/40'

function StatusDot({ value, pulsing = true }: { value: SpecStatusFilterValue; pulsing?: boolean }) {
  if (!isStatus(value)) return null
  return (
    <span aria-hidden className="inline-flex items-center">
      <TicketStatusDot status={value} className="w-2 h-2" pulsing={pulsing} />
    </span>
  )
}

interface CountProps {
  value: SpecStatusFilterValue
  selected: boolean
  text: string
  measure?: boolean
}

function Count({ value, selected, text, measure }: CountProps) {
  return (
    <span
      data-testid={measure ? undefined : `specs-status-count-${value}`}
      className={cn('tabular-nums text-xs', selected ? 'text-muted-foreground' : 'text-muted-foreground')}
    >
      {text}
    </span>
  )
}

interface SegmentProps {
  value: SpecStatusFilterValue
  label: string
  countText: string
  selected: boolean
  onSelect?: () => void
  /** Measuring clone: no roles, ids or focus. */
  measure?: boolean
  /** Pulse the in-progress dot only while something is in progress. */
  pulsing?: boolean
}

function Segment({ value, label, countText, selected, onSelect, measure, pulsing }: SegmentProps) {
  const content = (
    <>
      <StatusDot value={value} pulsing={pulsing} />
      <span>{label}</span>
      <Count value={value} selected={selected} text={countText} measure={measure} />
    </>
  )
  if (measure) return <span className={cn(SEGMENT_BASE, selected && SEGMENT_SELECTED)}>{content}</span>
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      data-value={value}
      data-testid={`specs-status-chip-${value}`}
      onClick={onSelect}
      className={cn(SEGMENT_BASE, selected ? SEGMENT_SELECTED : SEGMENT_IDLE)}
    >
      {content}
    </button>
  )
}

function Divider() {
  return <span aria-hidden className="w-px h-4 bg-border/60 mx-0.5 shrink-0" />
}

/**
 * Status selector for the SpecsBoard toolbar: a segmented control with a live
 * count per bucket (Active, All) and per lifecycle status.
 *
 * It never scrolls and never clips. A measured collapse ladder keeps the
 * selected value visible at every width:
 *  - `full`: every segment.
 *  - `compact`: Active · All · Done, the other statuses behind "More". When
 *    the selection lives in that menu the trigger renders as the selected
 *    segment (dot, label, count).
 *  - `menu`: one trigger showing the selection, listing every value.
 */
export function SpecStatusFilter({ value, onChange, counts, loading = false, forceTier, className }: SpecStatusFilterProps) {
  const { t, i18n } = useTranslation('specs')
  const [rowRef, rowWidth] = useElementWidth<HTMLDivElement>()
  const fullCloneRef = useRef<HTMLDivElement>(null)
  const compactCloneRef = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<{ full: number; compact: number } | null>(null)
  const groupRef = useRef<HTMLDivElement>(null)
  const focusAfterChangeRef = useRef(false)

  const activeCount = TICKET_STATUS_ORDER.filter((s) => ACTIVE_STATUSES.has(s)).reduce((sum, s) => sum + counts[s], 0)
  const allCount = TICKET_STATUS_ORDER.reduce((sum, s) => sum + counts[s], 0)
  const countFor = (v: SpecStatusFilterValue): number =>
    v === 'active' ? activeCount : v === 'all' ? allCount : counts[v]
  const countText = (v: SpecStatusFilterValue) => (loading ? '–' : String(countFor(v)))
  const labelFor = (v: SpecStatusFilterValue) => t(LABEL_KEYS[v])
  const inProgressPulsing = !loading && counts.in_progress > 0

  // The measuring clones mount only once a real width is known (never in
  // jsdom), so they cannot duplicate text or test ids for queries.
  const measuring = forceTier === undefined && rowWidth !== null
  const countsKey = TICKET_STATUS_ORDER.map((s) => counts[s]).join(',')
  useLayoutEffect(() => {
    if (!measuring) return
    const full = fullCloneRef.current?.offsetWidth ?? 0
    const compact = compactCloneRef.current?.offsetWidth ?? 0
    if (full <= 0) return
    setNatural((prev) => (prev && prev.full === full && prev.compact === compact ? prev : { full, compact }))
  }, [measuring, countsKey, loading, value, i18n.language])

  let tier: StatusTier = 'full'
  if (forceTier) tier = forceTier
  else if (rowWidth !== null && natural) {
    if (rowWidth >= natural.full) tier = 'full'
    else if (rowWidth >= Math.max(MIN_COMPACT_WIDTH, natural.compact)) tier = 'compact'
    else tier = 'menu'
  }

  const visibleRadios: readonly SpecStatusFilterValue[] =
    tier === 'full' ? ALL_VALUES : tier === 'compact' ? [...BUCKETS, PINNED_STATUS] : []

  // Keyboard selection carries focus to the new segment once it renders.
  useEffect(() => {
    if (!focusAfterChangeRef.current) return
    focusAfterChangeRef.current = false
    groupRef.current?.querySelector<HTMLElement>(`[role="radio"][data-value="${value}"]`)?.focus()
  }, [value])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.getAttribute('role') !== 'radio' || visibleRadios.length === 0) return
    const current = visibleRadios.indexOf(target.dataset.value as SpecStatusFilterValue)
    let next = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (current + 1) % visibleRadios.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (current - 1 + visibleRadios.length) % visibleRadios.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = visibleRadios.length - 1
    if (next < 0) return
    e.preventDefault()
    const nextValue = visibleRadios[next]
    if (nextValue === value) return
    focusAfterChangeRef.current = true
    onChange(nextValue)
  }

  const renderSegments = (values: readonly SpecStatusFilterValue[], measure?: boolean) =>
    values.map((v) => (
      <Segment
        key={v}
        value={v}
        label={labelFor(v)}
        countText={countText(v)}
        selected={!measure && value === v}
        onSelect={measure ? undefined : () => onChange(v)}
        measure={measure}
        pulsing={inProgressPulsing}
      />
    ))

  // The shared DropdownMenu drives keyboard focus through `role="menuitem"`;
  // the current choice is marked with a check and `aria-current`.
  const menuItems = (values: readonly SpecStatusFilterValue[]) =>
    values.map((v) => {
      const selected = value === v
      return (
        <DropdownMenuItem
          key={v}
          onSelect={() => onChange(v)}
          aria-current={selected || undefined}
          data-testid={`specs-status-option-${v}`}
          className={cn('gap-2 min-w-[12rem]', selected && 'text-foreground font-medium')}
        >
          <span className="inline-flex w-3.5 justify-center" aria-hidden>
            {selected && <Check className="w-3.5 h-3.5" />}
          </span>
          <StatusDot value={v} pulsing={inProgressPulsing} />
          <span className="flex-1">{labelFor(v)}</span>
          <span className="tabular-nums text-muted-foreground">{countText(v)}</span>
        </DropdownMenuItem>
      )
    })

  const selectedInMenu = isStatus(value) && MENU_STATUSES.includes(value)
  const longestMenuLabel = MENU_STATUSES.map(labelFor).reduce(
    (a, b) => (b.length > a.length ? b : a),
    t('statusFilter.more'),
  )

  return (
    <div ref={rowRef} className={cn('relative flex-1 min-w-0', className)}>
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label={t('statusFilter.ariaLabel')}
        data-testid="specs-status-filter"
        data-tier={tier}
        onKeyDown={onKeyDown}
        className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/20 p-0.5 max-w-full"
      >
        {tier !== 'menu' && (
          <>
            {renderSegments(BUCKETS)}
            <Divider />
            {renderSegments(tier === 'full' ? TICKET_STATUS_ORDER : [PINNED_STATUS])}
          </>
        )}

        {tier === 'compact' && (
          <DropdownMenu>
            <DropdownMenuTrigger
              data-testid="specs-status-more"
              aria-label={selectedInMenu ? t('statusFilter.moreSelected', { status: labelFor(value) }) : t('statusFilter.more')}
              className={cn(SEGMENT_BASE, selectedInMenu ? SEGMENT_SELECTED : SEGMENT_IDLE)}
            >
              {selectedInMenu ? (
                <>
                  <StatusDot value={value} pulsing={inProgressPulsing} />
                  <span>{labelFor(value)}</span>
                  <Count value={value} selected text={countText(value)} />
                </>
              ) : (
                <span>{t('statusFilter.more')}</span>
              )}
              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">{menuItems(MENU_STATUSES)}</DropdownMenuContent>
          </DropdownMenu>
        )}

        {tier === 'menu' && (
          <DropdownMenu>
            <DropdownMenuTrigger
              data-testid="specs-status-more"
              aria-label={t('statusFilter.moreSelected', { status: labelFor(value) })}
              className={cn(SEGMENT_BASE, SEGMENT_SELECTED)}
            >
              <StatusDot value={value} pulsing={inProgressPulsing} />
              <span>{labelFor(value)}</span>
              <Count value={value} selected text={countText(value)} />
              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {menuItems(BUCKETS)}
              <DropdownMenuSeparator />
              {menuItems(TICKET_STATUS_ORDER)}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {measuring && (
        <div aria-hidden className="pointer-events-none invisible absolute inset-0 overflow-hidden">
          <div ref={fullCloneRef} className="absolute left-0 top-0 inline-flex w-max items-center gap-0.5 border p-0.5">
            {renderSegments(BUCKETS, true)}
            <Divider />
            {renderSegments(TICKET_STATUS_ORDER, true)}
          </div>
          <div ref={compactCloneRef} className="absolute left-0 top-0 inline-flex w-max items-center gap-0.5 border p-0.5">
            {renderSegments(BUCKETS, true)}
            <Divider />
            {renderSegments([PINNED_STATUS], true)}
            {/* Widest possible "More" trigger: the longest menu label + count. */}
            <span className={SEGMENT_BASE}>
              <span className="w-2 h-2" />
              <span>{longestMenuLabel}</span>
              <span className="tabular-nums text-xs">{String(allCount)}</span>
              <span className="w-3.5 h-3.5" />
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
