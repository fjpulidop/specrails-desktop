import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'

/**
 * The app's single date field. A native `<input type="date">` is the accessible picker (keyboard
 * entry, screen-reader roles, the platform calendar), restyled to the shared control skin and
 * given the UI language so the placeholder segments and calendar speak it. The value stays a local
 * calendar day (`YYYY-MM-DD`).
 */
export const DateInput = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(
  ({ className, ...props }, ref) => {
    const { i18n } = useTranslation()
    return (
      <input
        ref={ref}
        type="date"
        lang={i18n.language}
        className={cn(
          'h-7 rounded-control border border-input bg-input px-2 text-caption text-foreground [color-scheme:inherit]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
        {...props}
      />
    )
  },
)
DateInput.displayName = 'DateInput'
