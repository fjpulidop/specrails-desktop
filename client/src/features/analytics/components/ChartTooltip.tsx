import { formatUsd } from '../lib/format'

interface Entry {
  name?: string | number
  value?: unknown
  color?: string
}

interface Props {
  active?: boolean
  label?: string | number
  payload?: Entry[]
  /** Format a series value; defaults to USD. */
  formatValue?: (value: number) => string
}

/**
 * Shared themed tooltip for analytics charts: raised surface, hairline border,
 * tabular numerals, one row per non-zero series plus a total.
 */
export function ChartTooltip({ active, label, payload, formatValue = (v) => formatUsd(v) }: Props) {
  if (!active || !payload || payload.length === 0) return null
  const rows = payload.filter((p) => typeof p.value === 'number' && (p.value as number) !== 0)
  if (rows.length === 0) return null
  const total = rows.reduce((sum, p) => sum + (p.value as number), 0)
  return (
    <div className="rounded-card border border-border bg-popover px-3 py-2 text-popover-foreground shadow-2">
      {label !== undefined && <div className="text-caption text-muted-foreground mb-1 num">{label}</div>}
      <ul className="space-y-0.5">
        {rows.map((p) => (
          <li key={String(p.name)} className="flex items-center gap-2 text-caption">
            <span aria-hidden className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
            <span className="text-muted-foreground">{p.name}</span>
            <span className="ml-auto pl-4 num text-foreground">{formatValue(p.value as number)}</span>
          </li>
        ))}
      </ul>
      {rows.length > 1 && (
        <div className="mt-1 flex items-center border-t border-border/60 pt-1 text-caption">
          <span className="ml-auto num font-medium text-foreground">{formatValue(total)}</span>
        </div>
      )}
    </div>
  )
}
