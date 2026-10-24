import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select'
import { cn } from '../../../lib/utils'

/** Radix Select forbids an empty item value; '' maps to this sentinel and back. */
const EMPTY_VALUE = '__settings-empty__'

export interface SettingsSelectOption {
  value: string
  label: string
}

/**
 * Thin `ui/select` wrapper for settings forms that still model "no choice"
 * as `''` (provider default, no skill, …). Replaces the native `<select>`
 * so every settings dropdown shares the app's popover styling.
 */
export function SettingsSelect({
  id,
  value,
  onChange,
  options,
  disabled,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'data-testid': testId,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  options: readonly SettingsSelectOption[]
  disabled?: boolean
  className?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'data-testid'?: string
}) {
  return (
    <Select
      value={value === '' ? EMPTY_VALUE : value}
      onValueChange={(next) => onChange(next === EMPTY_VALUE ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        className={cn('h-9 text-sm', className)}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        data-testid={testId}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value || EMPTY_VALUE} value={option.value === '' ? EMPTY_VALUE : option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
