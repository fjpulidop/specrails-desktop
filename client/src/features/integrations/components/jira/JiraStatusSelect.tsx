import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../../components/ui/select'
import { cn } from '../../../../lib/utils'

/** Radix Select forbids an empty item value, so the "none/auto" option uses a sentinel. */
const EMPTY_VALUE = '__jira-empty__'

/**
 * Jira status picker shared by the connect wizard and the connected card.
 * `value === ''` means the empty option (automatic mapping / no discard
 * status). A saved value that is no longer among the discovered statuses is
 * still listed so the current choice stays visible.
 */
export function JiraStatusSelect({
  id,
  value,
  onChange,
  statuses,
  emptyLabel,
  className,
  disabled,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  statuses: readonly { id: string; name: string }[]
  emptyLabel: string
  className?: string
  disabled?: boolean
  'aria-label'?: string
  'data-testid'?: string
}) {
  const names = statuses.map((status) => status.name)
  const showOrphan = value !== '' && !names.includes(value)
  return (
    <Select
      value={value === '' ? EMPTY_VALUE : value}
      onValueChange={(next) => onChange(next === EMPTY_VALUE ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id} className={cn('h-8 text-sm', className)} aria-label={ariaLabel} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={EMPTY_VALUE}>{emptyLabel}</SelectItem>
        {statuses.map((status) => (
          <SelectItem key={status.id} value={status.name}>{status.name}</SelectItem>
        ))}
        {showOrphan && <SelectItem value={value}>{value}</SelectItem>}
      </SelectContent>
    </Select>
  )
}
