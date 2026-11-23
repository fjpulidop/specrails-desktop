import { cn } from '../../lib/utils'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  testId?: string
}

/**
 * The one in-panel view switch: text labels, a hairline track and a neutral
 * selected segment. Primary stays reserved for actions, so a mode switch never
 * reads as a call to action.
 */
export function SegmentedControl<T extends string>({ value, options, onChange, label, className }: {
  value: T
  options: readonly SegmentedOption<T>[]
  onChange(value: T): void
  /** Accessible name for the group. */
  label?: string
  className?: string
}) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-control border border-border p-0.5', className)}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          data-testid={option.testId}
          className="inline-flex h-6 items-center rounded-[calc(var(--radius-control)-2px)] px-2 text-label text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-muted aria-pressed:text-foreground"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
