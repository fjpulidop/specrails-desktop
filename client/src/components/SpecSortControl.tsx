import { ArrowUp, ArrowDown, ArrowDownUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from './ui/select'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from './ui/tooltip'
import { cn } from '../lib/utils'
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

  return (
    <TooltipProvider delayDuration={300}>
      <div className={cn('flex items-center gap-1 shrink-0', className)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <Select
                value={mode}
                onValueChange={(v) => onChange(v as SpecSortMode, dir)}
              >
                <SelectTrigger
                  aria-label={t('sortControl.modeAriaLabel')}
                  className="h-7 w-auto gap-1.5 px-2 text-xs bg-accent-secondary/10 border-accent-secondary/30 hover:bg-accent-secondary/20"
                >
                  <ArrowDownUp className="w-3 h-3 text-muted-foreground" />
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
                className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-accent-secondary/30 bg-accent-secondary/10 hover:bg-accent-secondary/20 text-muted-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                {dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{dir === 'asc' ? t('sortControl.ascending') : t('sortControl.descending')}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  )
}
