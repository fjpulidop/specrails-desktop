import * as React from 'react'
import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { RailMark } from './RailMark'
import { prefersReducedMotion } from '../../lib/a11y-prefs'

/** Deliveries whose arrival already played in this session (never replays on remount). */
const played = new Set<string>()


export interface DeliveryArrivalProps {
  /** Delivery identity: the arrival plays once per id. */
  deliveryId: string
  prNumber: string | number | null
  prUrl: string
  onOpen?: (event: React.MouseEvent<HTMLAnchorElement>) => void
  compact?: boolean
  linkTestId?: string
  className?: string
}

/**
 * Peak: "Arrived at review". The spec pill decelerates into the end station
 * (`--duration-peak`), a check draws in and the PR number becomes the link.
 * Announced politely; static under reduced motion and on replays.
 */
export function DeliveryArrival({ deliveryId, prNumber, prUrl, onOpen, compact = false, linkTestId = 'delivery-arrival-link', className }: DeliveryArrivalProps) {
  const { t } = useTranslation('agent')
  const [animate] = React.useState(() => !played.has(deliveryId) && !prefersReducedMotion())
  React.useEffect(() => { played.add(deliveryId) }, [deliveryId])
  const number = String(prNumber ?? '').replace(/^#/, '')
  const announcement = number ? t('delivery.arrived', { number }) : t('delivery.arrivedNoNumber')

  return (
    <div
      data-testid="delivery-arrival"
      data-animated={animate ? 'true' : 'false'}
      className={cn('inline-flex items-center', compact ? 'gap-1.5' : 'gap-2.5', className)}
    >
      <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
      <span aria-hidden className="inline-flex items-center gap-1.5">
        <RailMark size={compact ? 26 : 34} state={animate ? 'arrive' : 'idle'} />
        <Check
          className={cn('text-accent-success', compact ? 'h-3 w-3' : 'h-3.5 w-3.5', animate && 'u-arrive-check')}
          strokeWidth={2.5}
        />
      </span>
      <a
        href={prUrl}
        target="_blank"
        rel="noreferrer"
        onClick={onOpen}
        title={prUrl}
        data-agent-interactive
        data-testid={linkTestId}
        className={cn(
          'num font-semibold leading-none text-accent-info transition-colors hover:text-accent-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-info/50 rounded-sm',
          compact ? 'text-strong' : 'text-display',
        )}
      >
        {number ? `#${number}` : t('delivery.openPr')}
      </a>
    </div>
  )
}
