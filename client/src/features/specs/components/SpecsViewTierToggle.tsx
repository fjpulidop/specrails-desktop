import { List, StickyNote } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../../../components/ui/tooltip'
import { cn } from '../../../lib/utils'
import type { SpecsViewTier } from '../lib/specs-view-tier'

interface SpecsViewTierToggleProps {
  tier: SpecsViewTier
  onChange: (tier: SpecsViewTier) => void
  className?: string
}

interface Option {
  value: SpecsViewTier
  Icon: typeof List
  /** i18n key (specs namespace) for the tooltip / aria-label. */
  labelKey: string
}

const OPTIONS: Option[] = [
  { value: 'row', Icon: List, labelKey: 'viewTier.listView' },
  { value: 'postit', Icon: StickyNote, labelKey: 'viewTier.postitView' },
]

export function SpecsViewTierToggle({ tier, onChange, className }: SpecsViewTierToggleProps) {
  const { t } = useTranslation('specs')
  return (
    <TooltipProvider delayDuration={300}>
      <div
        role="radiogroup"
        aria-label={t('viewTier.ariaLabel')}
        className={cn('inline-flex items-center gap-0.5 shrink-0', className)}
      >
        {OPTIONS.map(({ value, Icon, labelKey }) => {
          const active = tier === value
          return (
            <Tooltip key={value}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={t(labelKey)}
                  onClick={() => onChange(value)}
                  className={cn(
                    'inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-background text-foreground shadow-sm ring-1 ring-border/70'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
                  )}
                  data-testid={`specs-view-tier-${value}`}
                >
                  <Icon className="w-3.5 h-3.5" aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t(labelKey)}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </TooltipProvider>
  )
}
