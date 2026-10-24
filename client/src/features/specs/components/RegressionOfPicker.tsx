import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getApiBase } from '../../../lib/api'

export interface RecentDelivery {
  id: string
  loopId: string | null
  loopName: string
  decision: string
  ticketIds: number[]
  createdAt: string
}

/** Bug tickets carry the escaped-defect link; the label is the convention. */
export function isBugTicket(labels: readonly string[]): boolean {
  return labels.some((label) => label.trim().toLowerCase() === 'bug')
}

interface Props {
  value: string | null
  onChange: (deliveryId: string | null) => void
  disabled?: boolean
}

/**
 * "Regression of" picker (loop-economics-analytics): links a bug ticket to the
 * recent delivery that introduced it, counted as an escaped defect of that
 * delivery's loop. Stored as `ticket.metadata.regressionOf`.
 */
export function RegressionOfPicker({ value, onChange, disabled }: Props) {
  const { t } = useTranslation('tickets')
  const [state, setState] = useState<{ loading: boolean; error: boolean; deliveries: RecentDelivery[] }>({ loading: true, error: false, deliveries: [] })

  useEffect(() => {
    let current = true
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(`${getApiBase()}/analytics/loop-economics/deliveries?limit=50`, { signal: controller.signal })
        if (!response.ok) throw new Error('deliveries unavailable')
        const body = await response.json() as { deliveries?: unknown }
        const deliveries = Array.isArray(body.deliveries)
          ? (body.deliveries as RecentDelivery[]).filter((d) => d && typeof d.id === 'string')
          : []
        if (current) setState({ loading: false, error: false, deliveries })
      } catch {
        if (current) setState({ loading: false, error: true, deliveries: [] })
      }
    })()
    return () => { current = false; controller.abort() }
  }, [])

  const optionLabel = (delivery: RecentDelivery) => {
    const date = delivery.createdAt ? new Date(delivery.createdAt.includes('T') ? delivery.createdAt : `${delivery.createdAt.replace(' ', 'T')}Z`).toLocaleDateString() : ''
    const base = t('regressionOf.option', { loop: delivery.loopName || delivery.loopId || delivery.id, date })
    return delivery.ticketIds.length > 0 ? `${base} · ${t('regressionOf.tickets', { ids: delivery.ticketIds.join(', #') })}` : base
  }
  const known = value === null || state.deliveries.some((d) => d.id === value)

  return (
    <div data-testid="regression-of-picker">
      <label htmlFor="regression-of-select" className="text-label text-muted-foreground block mb-1">
        {t('regressionOf.label')}
      </label>
      <select
        id="regression-of-select"
        value={value ?? ''}
        disabled={disabled || state.loading}
        onChange={(event) => onChange(event.target.value || null)}
        className="w-full h-7 rounded border border-border bg-input px-2 text-xs text-foreground"
      >
        <option value="">{state.loading ? t('regressionOf.loading') : t('regressionOf.none')}</option>
        {!known && value !== null && <option value={value}>{t('regressionOf.missing', { id: value })}</option>}
        {state.deliveries.map((delivery) => (
          <option key={delivery.id} value={delivery.id}>{optionLabel(delivery)}</option>
        ))}
      </select>
      <span className="text-caption text-muted-foreground mt-0.5 block">
        {state.error ? t('regressionOf.unavailable') : !state.loading && state.deliveries.length === 0 ? t('regressionOf.empty') : t('regressionOf.hint')}
      </span>
    </div>
  )
}
