import { useTranslation } from 'react-i18next'
import { ArrowRight, Info } from 'lucide-react'
import { cn } from '../lib/utils'
import { openDocs } from '../lib/docs-events'
import { helpTarget, type HelpTopicId } from '../lib/help-topics'

interface HelpHintProps {
  topic: HelpTopicId
  /** `icon`: a quiet ⓘ beside a heading or control. `link`: "Learn more →" as text. */
  variant?: 'icon' | 'link'
  className?: string
}

/**
 * "Learn more" at the point of need: opens the in-app guide on the topic's
 * section without leaving the current context (the Docs dialog layers over
 * it). The accessible name always names the topic.
 */
export function HelpHint({ topic, variant = 'icon', className }: HelpHintProps) {
  const { t } = useTranslation('common')
  const label = t('help.learnMoreAbout', { topic: t(`help.topics.${topic}`) })
  const open = (event: React.MouseEvent) => {
    // Often sits inside a clickable header or draggable rail row.
    event.stopPropagation()
    openDocs(helpTarget(topic))
  }
  const shared = 'rounded-control text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
  if (variant === 'link') {
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        data-help-topic={topic}
        data-agent-interactive
        onClick={open}
        onMouseDown={(event) => event.stopPropagation()}
        className={cn('inline-flex items-center gap-1 text-caption', shared, className)}
      >
        <span aria-hidden>{t('help.learnMore')}</span>
        <ArrowRight className="size-3" aria-hidden />
      </button>
    )
  }
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-help-topic={topic}
      data-agent-interactive
      onClick={open}
      onMouseDown={(event) => event.stopPropagation()}
      className={cn('inline-grid size-6 shrink-0 place-items-center', shared, className)}
    >
      <Info className="size-3.5" aria-hidden />
    </button>
  )
}
