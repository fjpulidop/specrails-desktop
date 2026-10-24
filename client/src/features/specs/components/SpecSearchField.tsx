import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'
import { cn } from '../../../lib/utils'

interface SpecSearchFieldProps {
  value: string
  onChange: (v: string) => void
  className?: string
}

/**
 * Inline spec search for the Specs toolbar. `/` (wired by SpecsBoard) focuses
 * it; Escape clears the text first and blurs on a second press.
 */
export const SpecSearchField = forwardRef<HTMLInputElement, SpecSearchFieldProps>(
  function SpecSearchField({ value, onChange, className }, forwardedRef) {
    const { t } = useTranslation('specs')
    const inputRef = useRef<HTMLInputElement>(null)
    const [focused, setFocused] = useState(false)
    useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement)

    return (
      <div className={cn('relative flex-[0_1_320px] min-w-[96px]', className)}>
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground"
          aria-hidden
        />
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            if (value) {
              e.preventDefault()
              e.stopPropagation()
              onChange('')
            } else {
              e.currentTarget.blur()
            }
          }}
          aria-label={t('search.ariaLabel')}
          placeholder={t('search.placeholder')}
          data-testid="specs-search-input"
          autoComplete="off"
          spellCheck={false}
          className="h-8 w-full rounded-md border border-border/60 bg-muted/20 pl-8 pr-7 text-xs text-foreground placeholder:text-muted-foreground transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background [&::-webkit-search-cancel-button]:appearance-none"
        />
        {!value && !focused && (
          <kbd
            aria-hidden
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border/60 px-1 text-xs leading-4 font-mono text-muted-foreground"
          >
            /
          </kbd>
        )}
        {value && (
          <button
            type="button"
            aria-label={t('search.clear')}
            data-testid="specs-search-clear"
            onClick={() => {
              onChange('')
              inputRef.current?.focus()
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="w-3.5 h-3.5" aria-hidden />
          </button>
        )}
      </div>
    )
  },
)
