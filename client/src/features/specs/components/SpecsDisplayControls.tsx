import { useTranslation } from 'react-i18next'
import { ArrowDownUp, Check } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { toolbarButtonClass } from '../../../components/ui/board-toolbar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu'
import { SpecSortControl } from './SpecSortControl'
import { SpecsViewTierToggle } from './SpecsViewTierToggle'
import type { SpecSortMode, SpecSortDir } from '../types/spec-sort'
import type { SpecsViewTier } from '../lib/specs-view-tier'

interface SpecsDisplayControlsProps {
  sortMode: SpecSortMode
  sortDir: SpecSortDir
  onSortChange: (mode: SpecSortMode, dir: SpecSortDir) => void
  /** Offer the Jira-ticket-number sort (Jira-connected projects). */
  showJiraSort: boolean
  viewTier?: SpecsViewTier
  onViewTierChange?: (tier: SpecsViewTier) => void
  /** Narrow toolbar: fold the group into one "Sort and view options" menu. */
  compact: boolean
}

const MODE_LABEL_KEYS: Record<SpecSortMode, string> = {
  'default': 'sortControl.modes.default',
  'ticket-id': 'sortControl.modes.ticketId',
  'priority': 'sortControl.modes.priority',
  'jira-key': 'sortControl.modes.jiraKey',
}

const TIER_LABEL_KEYS: Record<SpecsViewTier, string> = {
  row: 'viewTier.listView',
  postit: 'viewTier.postitView',
}

function MenuHeading({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pt-1.5 pb-1 text-xs font-semibold text-muted-foreground" aria-hidden>{children}</div>
}

function ChoiceItem({ selected, onSelect, testId, children }: { selected: boolean; onSelect: () => void; testId: string; children: React.ReactNode }) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      aria-current={selected || undefined}
      data-testid={testId}
      className={cn('gap-2', selected && 'text-foreground font-medium')}
    >
      <span className="inline-flex w-3.5 justify-center" aria-hidden>
        {selected && <Check className="w-3.5 h-3.5" />}
      </span>
      {children}
    </DropdownMenuItem>
  )
}

/**
 * Sort + view controls for the Specs toolbar: one bordered display group, or a
 * single "Sort and view options" menu when the toolbar is narrow.
 */
export function SpecsDisplayControls({
  sortMode, sortDir, onSortChange, showJiraSort, viewTier = 'postit', onViewTierChange, compact,
}: SpecsDisplayControlsProps) {
  const { t } = useTranslation('specs')

  if (!compact) {
    return (
      <div
        role="group"
        aria-label={t('display.ariaLabel')}
        data-testid="specs-display-group"
        className="inline-flex items-center gap-0.5 h-8 shrink-0 rounded-md border border-border/60 bg-muted/20 p-0.5"
      >
        <SpecSortControl mode={sortMode} dir={sortDir} onChange={onSortChange} showJiraSort={showJiraSort} />
        {onViewTierChange && (
          <>
            <span aria-hidden className="w-px h-4 bg-border/60 mx-0.5" />
            <SpecsViewTierToggle tier={viewTier} onChange={onViewTierChange} />
          </>
        )}
      </div>
    )
  }

  const modes: SpecSortMode[] = ['default', 'ticket-id', 'priority']
  if (showJiraSort || sortMode === 'jira-key') modes.push('jira-key')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('display.menuLabel')}
        title={t('display.menuLabel')}
        data-testid="specs-display-menu-trigger"
        className={cn(toolbarButtonClass, 'w-8 px-0')}
      >
        <ArrowDownUp className="w-3.5 h-3.5" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={t('display.menuLabel')} className="min-w-[12rem]">
        <MenuHeading>{t('display.sortBy')}</MenuHeading>
        {modes.map((m) => (
          <ChoiceItem
            key={m}
            selected={sortMode === m}
            onSelect={() => onSortChange(m, sortDir)}
            testId={`specs-display-sort-${m}`}
          >
            {t(MODE_LABEL_KEYS[m])}
          </ChoiceItem>
        ))}
        {sortMode !== 'default' && (
          <>
            <DropdownMenuSeparator />
            <MenuHeading>{t('display.direction')}</MenuHeading>
            <ChoiceItem selected={sortDir === 'asc'} onSelect={() => onSortChange(sortMode, 'asc')} testId="specs-display-dir-asc">
              {t('sortControl.ascending')}
            </ChoiceItem>
            <ChoiceItem selected={sortDir === 'desc'} onSelect={() => onSortChange(sortMode, 'desc')} testId="specs-display-dir-desc">
              {t('sortControl.descending')}
            </ChoiceItem>
          </>
        )}
        {onViewTierChange && (
          <>
            <DropdownMenuSeparator />
            <MenuHeading>{t('display.view')}</MenuHeading>
            {(['row', 'postit'] as const).map((tier) => (
              <ChoiceItem
                key={tier}
                selected={viewTier === tier}
                onSelect={() => onViewTierChange(tier)}
                testId={`specs-display-view-${tier}`}
              >
                {t(TIER_LABEL_KEYS[tier])}
              </ChoiceItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
