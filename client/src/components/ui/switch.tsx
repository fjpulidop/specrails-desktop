import * as React from 'react'
import { cn } from '../../lib/utils'

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role' | 'aria-checked'> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Track colour when on. Defaults to the primary token. */
  onClassName?: string
}

/**
 * Shared on/off switch: a real button with role="switch" and aria-checked,
 * the same focus ring as ui/button, and a knob drawn from the background token
 * so it stays legible in every theme.
 */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, onClassName, className, disabled, onClick, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) onCheckedChange(!checked)
      }}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors',
        'ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? (onClassName ?? 'bg-primary') : 'bg-muted-foreground/30',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  ),
)
Switch.displayName = 'Switch'
