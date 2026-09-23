import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../../lib/utils'

interface PanelChevronButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Whether the panel is currently open (affects icon orientation). */
  isOpen: boolean
}

/**
 * Shared chevron button used both in the StatusBar (when panel is hidden) and in
 * the panel's own top bar (when panel is open). Both instances share identical
 * geometry so that toggling the panel does not visually shift the chevron —
 * only the arrow orientation changes.
 */
export const PanelChevronButton = forwardRef<HTMLButtonElement, PanelChevronButtonProps>(
  function PanelChevronButton({ isOpen, className, ...rest }, ref) {
    const { t } = useTranslation('terminal')
    return (
      <button
        ref={ref}
        type="button"
        aria-label={isOpen ? t('panelChevron.collapse') : t('panelChevron.expand')}
        aria-expanded={isOpen}
        className={cn(
          'panel-chevron',
          'inline-flex items-center justify-center',
          'h-5 w-6 mr-1.5',
          'rounded text-muted-foreground',
          'hover:bg-border/40 hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary/60',
          'transition-colors duration-120',
          className,
        )}
        {...rest}
      >
        <svg
          width="14"
          height="10"
          viewBox="0 0 14 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* Panel frame */}
          <rect x="1" y="1" width="12" height="8" rx="1.5" />
          {isOpen ? (
            // Down-pointing chevron (collapse)
            <path d="M5 3.5 L7 5.5 L9 3.5" />
          ) : (
            // Up-pointing chevron (expand)
            <path d="M5 6.5 L7 4.5 L9 6.5" />
          )}
        </svg>
      </button>
    )
  },
)
