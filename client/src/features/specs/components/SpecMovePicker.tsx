import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MoveRight } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Kbd } from '../../../components/ui/kbd'
import type { LocalTicket, TicketStatus } from '../../../types'
import type { RailState } from '../../rails/components/RailsBoard'
import { MANUAL_STATUS_TARGETS, STATUS_LABEL_KEY, isJiraBackedTicket } from '../lib/ticket-status-moves'
import type { SpecBulkHandlers } from '../lib/bulk-actions'

interface SpecMovePickerProps {
  /** The specs to move (the focused card, or the whole selection it belongs to); empty closes the picker. */
  tickets: readonly LocalTicket[]
  rails: readonly RailState[]
  handlers: SpecBulkHandlers
  onClose: () => void
}

const optionClass = 'flex w-full items-center justify-between gap-3 rounded-control px-3 py-2 text-left text-body text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

/**
 * Keyboard equivalent of drag and drop (BB4): `m` on a focused spec card opens
 * this picker with the status targets and the rails. Every choice runs the SAME
 * handler as the bulk bar (`SpecBulkHandlers`): local statuses, Jira workflow
 * statuses through the Jira outbox, and Add to rail through the board's
 * `onMoveToRail`, so undo, rail gating and Jira semantics are unchanged.
 */
export function SpecMovePicker({ tickets, rails, handlers, onClose }: SpecMovePickerProps) {
  const { t } = useTranslation('specs')
  const { t: tTickets } = useTranslation('tickets')
  const open = tickets.length > 0
  const ids = tickets.map((tk) => tk.id)
  const jiraIds = tickets.filter((tk) => isJiraBackedTicket(tk, handlers.jiraConnected)).map((tk) => tk.id)
  const localIds = ids.filter((id) => !jiraIds.includes(id))

  const [jira, setJira] = useState<{ state: 'idle' | 'loading' | 'error' | 'ready'; names: string[] }>({ state: 'idle', names: [] })
  const loadJira = handlers.loadJiraStatuses
  const needsJira = open && jiraIds.length > 0
  useEffect(() => {
    if (!needsJira) { setJira({ state: 'idle', names: [] }); return }
    let live = true
    setJira({ state: 'loading', names: [] })
    loadJira().then(
      (names) => { if (live) setJira({ state: 'ready', names }) },
      () => { if (live) setJira({ state: 'error', names: [] }) },
    )
    return () => { live = false }
  }, [needsJira, loadJira])

  const listRef = useRef<HTMLDivElement>(null)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLElement)
    e.preventDefault()
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  const moveLocal = (status: TicketStatus) => {
    onClose()
    void handlers.onStatus(localIds, { kind: 'local', status })
  }
  const moveJira = (status: string) => {
    onClose()
    void handlers.onStatus(jiraIds, { kind: 'jira', status })
  }
  const moveRail = (railId: string) => {
    onClose()
    handlers.onMoveToRail(ids, railId)
  }

  const title = tickets.length === 1
    ? t('movePicker.titleOne', { id: tickets[0].id })
    : t('movePicker.titleMany', { count: tickets.length })

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        size="confirm"
        data-testid="spec-move-picker"
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(e) => {
          // Land on the first usable option, not the close button, so arrows work at once.
          e.preventDefault()
          listRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><MoveRight className="h-4 w-4 text-accent-primary" aria-hidden />{title}</DialogTitle>
          <DialogDescription>{tickets.length === 1 ? t('movePicker.descriptionOne', { title: tickets[0].title }) : t('movePicker.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div ref={listRef} className="flex flex-col gap-3">
            <section aria-labelledby="move-picker-status" className="flex flex-col gap-0.5">
              <h3 id="move-picker-status" className="px-3 pb-1 text-caption font-semibold text-muted-foreground">{t('movePicker.statusHeading')}</h3>
              {localIds.length > 0 && MANUAL_STATUS_TARGETS.map((st) => (
                <button
                  key={st}
                  type="button"
                  className={optionClass}
                  data-testid={`move-picker-status-${st}`}
                  disabled={tickets.length === 1 && tickets[0].status === st}
                  onClick={() => moveLocal(st)}
                >
                  {tTickets(STATUS_LABEL_KEY[st])}
                  {tickets.length === 1 && tickets[0].status === st && <span className="shrink-0 text-caption text-muted-foreground">{t('movePicker.current')}</span>}
                </button>
              ))}
              {jiraIds.length > 0 && jira.state === 'loading' && (
                <p className="px-3 py-1 text-caption text-muted-foreground" role="status">{t('movePicker.jiraLoading')}</p>
              )}
              {jiraIds.length > 0 && jira.state === 'error' && (
                <p className="px-3 py-1 text-caption text-destructive" role="alert">{t('movePicker.jiraFailed')}</p>
              )}
              {jiraIds.length > 0 && jira.state === 'ready' && jira.names.map((name) => (
                <button key={`jira-${name}`} type="button" className={optionClass} data-testid={`move-picker-jira-${name}`} onClick={() => moveJira(name)}>
                  {t('movePicker.jiraStatus', { status: name })}
                </button>
              ))}
            </section>
            <section aria-labelledby="move-picker-rail" className="flex flex-col gap-0.5">
              <h3 id="move-picker-rail" className="px-3 pb-1 text-caption font-semibold text-muted-foreground">{t('movePicker.railHeading')}</h3>
              {rails.length === 0 && <p className="px-3 py-1 text-caption text-muted-foreground">{t('movePicker.noRails')}</p>}
              {rails.map((rail) => (
                <button key={rail.id} type="button" className={optionClass} data-testid={`move-picker-rail-${rail.id}`} onClick={() => moveRail(rail.id)}>
                  <span className="truncate">{rail.label}</span>
                  {rail.status === 'running' && <span className={cn('shrink-0 text-caption text-muted-foreground')}>{t('movePicker.running')}</span>}
                </button>
              ))}
            </section>
            <p className="px-3 text-caption text-muted-foreground">
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> {t('movePicker.hintNavigate')} · <Kbd>↵</Kbd> {t('movePicker.hintChoose')} · <Kbd>Esc</Kbd> {t('movePicker.hintClose')}
            </p>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
