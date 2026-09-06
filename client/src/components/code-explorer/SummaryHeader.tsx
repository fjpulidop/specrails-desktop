import { ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { useTicketDetailModal } from '../../context/TicketDetailModalContext'

export interface SummaryPayload {
  summary: string
  generatedAt?: string
  model?: string
  language?: string
  generatedBy?: { model?: string; promptVersion?: number; truncated?: boolean }
  triggeredBy?: {
    ticketId?: number | null
    modifiedTicketIds?: number[]
  }
}

interface SummaryHeaderProps {
  path: string
  summary: SummaryPayload | null
  stale: boolean
  regenerating: boolean
  generateDisabledReason?: string | null
  onCollapse?: () => void
}

function humanise(iso: string | undefined, locale: string): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const deltaSec = Math.round((t - Date.now()) / 1000)
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const abs = Math.abs(deltaSec)
  if (abs < 60) return fmt.format(deltaSec, 'second')
  if (abs < 3600) return fmt.format(Math.round(deltaSec / 60), 'minute')
  if (abs < 86400) return fmt.format(Math.round(deltaSec / 3600), 'hour')
  return fmt.format(Math.round(deltaSec / 86400), 'day')
}

export function SummaryHeader({ path, summary, stale, regenerating, generateDisabledReason, onCollapse }: SummaryHeaderProps) {
  const { t, i18n } = useTranslation('code')
  const { openTicketDetail } = useTicketDetailModal()

  if (!summary) {
    return (
      <div className="border-b border-border px-4 py-3 bg-surface" data-testid="summary-header-empty">
        <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-xs text-muted-foreground truncate">{path}</span>
          <p className="text-sm text-muted-foreground">
            {generateDisabledReason ? t('summary.unavailable', { reason: generateDisabledReason }) : t('summary.empty')}
          </p>
        </div>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            >
              <ChevronUp className="h-3.5 w-3.5" />
              {t('summary.hide')}
            </button>
          )}
        </div>
      </div>
    )
  }

  const ts = humanise(summary.generatedAt, i18n.language)
  const model = summary.generatedBy?.model ?? summary.model
  const absoluteDate = summary.generatedAt && Number.isFinite(Date.parse(summary.generatedAt)) ? new Date(summary.generatedAt).toLocaleString(i18n.language) : undefined
  const triggered = summary.triggeredBy?.ticketId
  const modified = summary.triggeredBy?.modifiedTicketIds ?? []

  return (
    <div className="border-b border-border px-4 py-3 bg-surface" data-testid="summary-header">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground truncate">{path}</span>
            {stale && (
              <span
                className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded bg-accent-warning/20 text-accent-warning font-medium',
                )}
                data-testid="summary-stale-badge"
              >
                {t('summary.stale')}
              </span>
            )}
            {regenerating && (
              <span className="w-1.5 h-1.5 rounded-full bg-accent-primary animate-pulse" aria-hidden />
            )}
          </div>
          <p className="text-sm text-foreground mt-1 whitespace-pre-wrap break-words">{summary.summary}</p>
          {summary.generatedBy?.truncated && <p className="mt-2 text-xs text-accent-warning">{t('reader.summaryPartial', { defaultValue: 'Generated from a partial source snapshot. This summary may not cover the entire file.' })}</p>}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {model && <span className="text-[10px] text-muted-foreground">{t('story.explainedBy', { model })}</span>}
            {typeof triggered === 'number' && (
              <button
                type="button"
                onClick={() => openTicketDetail(triggered)}
                className="text-[10px] px-1.5 py-0.5 rounded bg-accent-success/20 text-accent-success"
              >
                #{triggered}
              </button>
            )}
            {modified.map((tid) => (
              <button
                type="button"
                key={tid}
                onClick={() => openTicketDetail(tid)}
                className="text-[10px] px-1.5 py-0.5 rounded bg-accent-info/15 text-accent-info"
              >
                #{tid}
              </button>
            ))}
            {ts && <time className="text-[10px] text-muted-foreground" dateTime={summary.generatedAt} title={absoluteDate}>{ts}</time>}
          </div>
        </div>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            <ChevronUp className="h-3.5 w-3.5" />
            {t('summary.hide')}
          </button>
        )}
      </div>
    </div>
  )
}

export default SummaryHeader
