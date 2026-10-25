import { useTranslation } from 'react-i18next'
import { AlertTriangle, FileWarning, MessageSquareQuote, ShieldAlert, Sparkles } from 'lucide-react'
import { cn } from '../../../../../lib/utils'
import type { ChangeAnnotation } from '../../../lib/changes-model'

const SOURCE_ICON = {
  'reviewer-finding': Sparkles,
  'review-risk': ShieldAlert,
  'review-untested': FileWarning,
  'follow-up-comment': MessageSquareQuote,
} as const

/** Lamp canon: severity is a lamp (dot plus label), never colour alone. */
const SEVERITY_TONE = {
  high: 'border-destructive/40 bg-destructive/5',
  medium: 'border-accent-warning/40 bg-accent-warning/5',
  low: 'border-border bg-surface/60',
} as const

export function locationLabel(location: NonNullable<ChangeAnnotation['location']>): string {
  if (location.line === null) return location.path
  return `${location.path}:${location.endLine ? `${location.line}-${location.endLine}` : location.line}`
}

/**
 * One reviewer note. Agent-directed only: the single action is to hand it to the
 * agent as a spec addendum, never to reply to a person.
 */
export function AnnotationCard({ annotation, active, showLocation, indented, onAsk, askDisabled }: {
  annotation: ChangeAnnotation
  active?: boolean
  /** Unanchored lists name the place; an anchored card sits under its line. */
  showLocation?: boolean
  /** Under a diff line: clear the line-number gutters. */
  indented?: boolean
  onAsk?: (annotation: ChangeAnnotation) => void
  askDisabled?: boolean
}) {
  const { t } = useTranslation('packet')
  const Icon = SOURCE_ICON[annotation.source]
  const label = t(`changes.annotations.source.${annotation.source}`)
  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={`${label}${annotation.location ? ` — ${locationLabel(annotation.location)}` : ''}`}
      data-annotation-id={annotation.id}
      data-active={active ? 'true' : undefined}
      className={cn(
        'my-1 mr-3 flex max-w-3xl flex-col gap-1 rounded-card border px-3 py-2 text-body outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring data-[active=true]:ring-2 data-[active=true]:ring-ring',
        indented && 'ml-24',
        annotation.severity ? SEVERITY_TONE[annotation.severity] : 'border-border bg-surface/60',
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium text-foreground">{label}</span>
        {annotation.severity ? (
          <span className="inline-flex items-center gap-1">
            <AlertTriangle className="size-3" aria-hidden />
            {t(`changes.annotations.severity.${annotation.severity}`)}
          </span>
        ) : null}
        {annotation.author ? <span>{annotation.author}</span> : null}
        {showLocation && annotation.location ? <code className="font-mono">{locationLabel(annotation.location)}</code> : null}
      </div>
      {annotation.text ? <p className="whitespace-pre-wrap break-words text-foreground">{annotation.text}</p> : null}
      {onAsk ? (
        <button
          type="button"
          onClick={() => onAsk(annotation)}
          disabled={askDisabled}
          className="w-fit rounded-control border border-border px-2 py-0.5 text-caption text-foreground hover:bg-surface disabled:opacity-50"
        >
          {t('changes.annotations.ask')}
        </button>
      ) : null}
    </div>
  )
}
