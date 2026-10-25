import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowRight, ArrowUp, AlertCircle, ChevronUp, Rocket, Tag, Trash2, X } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { Kbd } from '../../../components/ui/kbd'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu'
import type { LocalTicket, TicketPriority } from '../../../types'
import type { RailState } from '../../rails/components/RailsBoard'
import { MANUAL_STATUS_TARGETS, STATUS_LABEL_KEY, isJiraBackedTicket } from '../lib/ticket-status-moves'
import { BULK_PRIORITIES, labelsOf, type SpecBulkHandlers } from '../lib/bulk-actions'

interface SpecsBulkBarProps {
  selected: LocalTicket[]
  handlers: SpecBulkHandlers
  rails: RailState[]
  onClear: () => void
}

const PRIORITY_ICON: Record<TicketPriority, React.ReactNode> = {
  critical: <AlertCircle className="h-3.5 w-3.5 text-destructive" aria-hidden />,
  high: <ArrowUp className="h-3.5 w-3.5 text-accent-warning" aria-hidden />,
  medium: <ArrowRight className="h-3.5 w-3.5 text-accent-warning" aria-hidden />,
  low: <ArrowDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />,
}

const barButton = 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-caption font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

function Heading({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pb-1 pt-1.5 text-caption font-semibold text-muted-foreground" aria-hidden>{children}</div>
}

/**
 * Floating bulk bar of the specs board: shown while at least one spec is
 * selected. Every action is a menu or button that hands the selected ids to the
 * host's handlers (see SpecBulkHandlers) — nothing here talks to the server.
 */
export function SpecsBulkBar({ selected, handlers, rails, onClear }: SpecsBulkBarProps) {
  const { t } = useTranslation('specs')
  const { t: tTickets } = useTranslation('tickets')
  const ids = selected.map((s) => s.id)
  const count = ids.length
  const jiraIds = selected.filter((s) => isJiraBackedTicket(s, handlers.jiraConnected)).map((s) => s.id)
  const localIds = ids.filter((id) => !jiraIds.includes(id))
  const present = labelsOf(selected)
  const addable = handlers.allLabels.filter((l) => !selected.every((s) => (s.labels ?? []).includes(l)))

  // Jira workflow statuses load when the Move to menu opens with Jira-backed specs selected.
  const [jiraStatuses, setJiraStatuses] = useState<{ state: 'idle' | 'loading' | 'error' | 'ready'; names: string[] }>({ state: 'idle', names: [] })
  const loadingRef = useRef(false)
  const loadJira = useCallback(() => {
    if (loadingRef.current) return
    loadingRef.current = true
    setJiraStatuses((s) => ({ ...s, state: 'loading' }))
    handlers.loadJiraStatuses().then(
      (names) => setJiraStatuses({ state: 'ready', names }),
      () => setJiraStatuses({ state: 'error', names: [] }),
    ).finally(() => { loadingRef.current = false })
  }, [handlers])

  // Arrow keys move between the bar's controls (WAI-ARIA toolbar).
  const barRef = useRef<HTMLDivElement>(null)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    const items = Array.from(barRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (index === -1) return
    e.preventDefault()
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label={t('bulk.toolbarLabel', { count })}
      aria-orientation="horizontal"
      data-testid="specs-bulk-bar"
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      className="absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-panel border border-border bg-popover p-1 text-popover-foreground shadow-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2"
    >
      <span className="shrink-0 px-2.5 text-caption font-semibold tabular-nums text-foreground" role="status" data-testid="specs-bulk-count">
        {t('bulk.count', { count })}
      </span>
      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />

      <DropdownMenu onOpenChange={(open) => { if (open && jiraIds.length > 0 && jiraStatuses.state === 'idle') loadJira() }}>
        <DropdownMenuTrigger className={barButton} data-testid="specs-bulk-move">
          {t('bulk.moveTo')}
          <ChevronUp className="h-3 w-3 text-muted-foreground" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" aria-label={t('bulk.moveTo')} className="max-h-72 min-w-[13rem] overflow-y-auto">
          {localIds.length > 0 && (
            <>
              <Heading>{t('bulk.statusLocal', { count: localIds.length })}</Heading>
              {MANUAL_STATUS_TARGETS.map((status) => (
                <DropdownMenuItem
                  key={status}
                  data-testid={`specs-bulk-move-local-${status}`}
                  onSelect={() => { void handlers.onStatus(localIds, { kind: 'local', status }) }}
                >
                  {tTickets(STATUS_LABEL_KEY[status])}
                </DropdownMenuItem>
              ))}
            </>
          )}
          {localIds.length > 0 && jiraIds.length > 0 && <DropdownMenuSeparator />}
          {jiraIds.length > 0 && (
            <>
              <Heading>{t('bulk.statusJira', { count: jiraIds.length })}</Heading>
              {jiraStatuses.state === 'loading' && <p className="px-2 py-1.5 text-caption text-muted-foreground" role="status">{t('bulk.loadingStatuses')}</p>}
              {jiraStatuses.state === 'error' && <p className="px-2 py-1.5 text-caption text-destructive" role="alert">{t('bulk.statusesFailed')}</p>}
              {jiraStatuses.state === 'ready' && jiraStatuses.names.length === 0 && <p className="px-2 py-1.5 text-caption text-muted-foreground">{t('bulk.noStatuses')}</p>}
              {jiraStatuses.state === 'ready' && jiraStatuses.names.map((name) => (
                <DropdownMenuItem
                  key={name}
                  data-testid={`specs-bulk-move-jira-${name}`}
                  onSelect={() => { void handlers.onStatus(jiraIds, { kind: 'jira', status: name }) }}
                >
                  {name}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger className={barButton} data-testid="specs-bulk-label">
          <Tag className="h-3.5 w-3.5" aria-hidden />
          {t('bulk.label')}
          <ChevronUp className="h-3 w-3 text-muted-foreground" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" aria-label={t('bulk.label')} className="max-h-72 min-w-[13rem] overflow-y-auto">
          {addable.length === 0 && present.length === 0 && <p className="px-2 py-1.5 text-caption text-muted-foreground">{t('bulk.noLabels')}</p>}
          {addable.length > 0 && <Heading>{t('bulk.labelAdd')}</Heading>}
          {addable.map((label) => (
            <DropdownMenuItem key={`add-${label}`} data-testid={`specs-bulk-label-add-${label}`} onSelect={() => { void handlers.onLabel(ids, label, 'add') }}>
              {label}
            </DropdownMenuItem>
          ))}
          {addable.length > 0 && present.length > 0 && <DropdownMenuSeparator />}
          {present.length > 0 && <Heading>{t('bulk.labelRemove')}</Heading>}
          {present.map((label) => (
            <DropdownMenuItem key={`rm-${label}`} data-testid={`specs-bulk-label-remove-${label}`} onSelect={() => { void handlers.onLabel(ids, label, 'remove') }}>
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger className={barButton} data-testid="specs-bulk-priority">
          {t('bulk.priority')}
          <ChevronUp className="h-3 w-3 text-muted-foreground" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" aria-label={t('bulk.priority')}>
          {BULK_PRIORITIES.map((priority) => (
            <DropdownMenuItem key={priority} data-testid={`specs-bulk-priority-${priority}`} onSelect={() => { void handlers.onPriority(ids, priority) }}>
              {PRIORITY_ICON[priority]}
              <span className="capitalize">{t(`priority.${priority}`)}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger className={barButton} data-testid="specs-bulk-rail">
          {t('bulk.addToRail')}
          <ChevronUp className="h-3 w-3 text-muted-foreground" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" aria-label={t('bulk.addToRail')} className="max-h-72 min-w-[12rem] overflow-y-auto">
          {rails.length === 0 && <p className="px-2 py-1.5 text-caption text-muted-foreground">{t('bulk.noRails')}</p>}
          {rails.map((rail) => (
            <DropdownMenuItem
              key={rail.id}
              disabled={rail.status === 'running'}
              data-testid={`specs-bulk-rail-${rail.id}`}
              onSelect={() => handlers.onMoveToRail(ids, rail.id)}
            >
              <span className="flex-1 truncate">{rail.label}</span>
              <span className="text-caption text-muted-foreground">
                {rail.status === 'running' ? t('bulk.railRunning') : t('bulk.railSpecs', { count: rail.ticketIds.length })}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
      <button type="button" className={cn(barButton, 'text-accent-success hover:text-accent-success')} onClick={() => handlers.onLaunch(ids)} data-testid="specs-bulk-launch">
        <Rocket className="h-3.5 w-3.5" aria-hidden />
        {t('bulk.launchAll')}
      </button>
      <button type="button" className={cn(barButton, 'text-destructive hover:text-destructive')} onClick={() => { void handlers.onDelete(ids) }} data-testid="specs-bulk-delete">
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
        {t('bulk.delete')}
      </button>
      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
      <button type="button" className={barButton} onClick={onClear} data-testid="specs-bulk-clear" title={t('bulk.clearTitle')}>
        <X className="h-3.5 w-3.5" aria-hidden />
        {t('bulk.clear')}
        <Kbd aria-hidden>Esc</Kbd>
      </button>
    </div>
  )
}
