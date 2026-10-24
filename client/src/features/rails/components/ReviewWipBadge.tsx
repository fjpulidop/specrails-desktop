import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Inbox } from 'lucide-react'
import type { PendingReview } from '../../../lib/review-wip'
import { compactRelativeTime } from '../../../lib/relative-time'

interface Props {
  limit: number
  pending: PendingReview[]
  /** Rail label for a server railIndex (custom names included). */
  railLabel: (railIndex: number) => string
  /** Spec title for a ticket id, when known. */
  ticketTitle: (ticketId: number) => string | undefined
}

/**
 * Board header badge for the review WIP limit: "In review 3/5". Clicking it
 * lists the deliveries that count against the limit (oldest first). Turns to
 * the warning tone once the limit is reached.
 */
export function ReviewWipBadge({ limit, pending, railLabel, ticketTitle }: Props) {
  const { t } = useTranslation('dashboard')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const reached = pending.length >= limit

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="review-wip-badge"
        data-reached={reached ? 'true' : 'false'}
        title={reached ? t('reviewWip.reachedTitle', { limit }) : t('reviewWip.title', { limit })}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 h-6 rounded-full px-2 text-[11px] font-medium whitespace-nowrap border transition-colors ${
          reached
            ? 'border-accent-warning/50 bg-accent-warning/10 text-accent-warning hover:bg-accent-warning/20'
            : 'border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground'
        }`}
      >
        <Inbox className="w-3 h-3" aria-hidden />
        {t('reviewWip.badge', { pending: pending.length, limit })}
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={t('reviewWip.panelTitle')}
          className="absolute left-0 top-full z-50 mt-1.5 w-72 rounded-lg border border-border/60 bg-popover p-3 text-xs shadow-xl"
        >
          <p className="font-semibold text-foreground">{t('reviewWip.panelTitle')}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {reached ? t('reviewWip.panelReached', { limit }) : t('reviewWip.panelBody', { limit })}
          </p>
          {pending.length === 0 ? (
            <p className="mt-2 text-[11px] text-muted-foreground" data-testid="review-wip-empty">{t('reviewWip.empty')}</p>
          ) : (
            <ul className="mt-2 space-y-1.5" data-testid="review-wip-list">
              {pending.map((item) => {
                const since = item.since ? compactRelativeTime(item.since) : ''
                return (
                  <li key={item.deliveryId} className="rounded-md border border-border/40 bg-muted/20 px-2 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground truncate">{railLabel(item.railIndex)}</span>
                      {since && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{since}</span>}
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {item.ticketIds.map((id) => {
                        const title = ticketTitle(id)
                        return title ? `#${id} ${title}` : `#${id}`
                      }).join(' · ')}
                    </p>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
