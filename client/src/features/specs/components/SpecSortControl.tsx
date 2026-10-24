import { ArrowUp, ArrowDown, ArrowDownUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '../../../components/ui/select'
import { Tooltip, TooltipTrigger, TooltipContent } from '../../../components/ui/tooltip'
import { cn } from '../../../lib/utils'
import type { SpecSortMode, SpecSortDir } from '../types/spec-sort'

interface SpecSortControlProps {
  mode: SpecSortMode
  dir: SpecSortDir
  onChange: (mode: SpecSortMode, dir: SpecSortDir) => void
  /** When true, expose the Jira-ticket-number sort option (Jira-connected projects). */
  showJiraSort?: boolean
  className?: string
}

/** i18n keys (specs namespace) per sort mode. */
const MODE_LABEL_KEYS: Record<SpecSortMode, string> = {
  'default': 'sortControl.modes.default',
  'ticket-id': 'sortControl.modes.ticketId',
  'priority': 'sortControl.modes.priority',
  'jira-key': 'sortControl.modes.jiraKey',
}

export function SpecSortControl({ mode, dir, onChange, showJiraSort = false, className }: SpecSortControlProps) {
  const { t } = useTranslation('specs')
  const showArrow = mode !== 'default'

  // Tooltip context comes from the toolbar (BoardToolbar) or the app shell.
  return (
    <div className={cn('flex items-center gap-0.5 shrink-0', className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <Select
              value={mode}
              onValueChange={(v) => onChange(v as SpecSortMode, dir)}
            >
              <SelectTrigger
                aria-label={t('sortControl.modeAriaLabel')}
                className="h-7 w-auto gap-1.5 px-2 text-xs border-0 bg-transparent shadow-none hover:bg-muted/40"
              >
                <ArrowDownUp className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
                <SelectValue>{t(MODE_LABEL_KEYS[mode])}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t('sortControl.modes.default')}</SelectItem>
                <SelectItem value="ticket-id">{t('sortControl.modes.ticketId')}</SelectItem>
                <SelectItem value="priority">{t('sortControl.modes.priority')}</SelectItem>
                {/* Offered for Jira-linked projects; also rendered whenever it
                    is the current value so the Select never holds a value with
                    no matching item (e.g. a persisted mode during initial load,
                    before DashboardPage resets it). */}
                {(showJiraSort || mode === 'jira-key') && (
                  <SelectItem value="jira-key">{t('sortControl.modes.jiraKey')}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
        </TooltipTrigger>
        <TooltipContent>{t('sortControl.tooltip', { mode: t(MODE_LABEL_KEYS[mode]) })}</TooltipContent>
      </Tooltip>

      {showArrow && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('sortControl.toggleDirAriaLabel')}
              onClick={() => onChange(mode, dir === 'asc' ? 'desc' : 'asc')}
              className="inline-flex items-center justify-center h-7 w-7 rounded-md border-0 bg-transparent hover:bg-muted/40 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {dir === 'asc' ? <ArrowUp className="w-3.5 h-3.5" aria-hidden /> : <ArrowDown className="w-3.5 h-3.5" aria-hidden />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{dir === 'asc' ? t('sortControl.ascending') : t('sortControl.descending')}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
