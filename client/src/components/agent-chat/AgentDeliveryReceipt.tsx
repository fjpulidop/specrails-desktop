import { Check, CheckCheck, CircleX, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentDeliveryReceipt as Receipt, AgentMessage } from '../../lib/agent-api'

/** A green receipt requires an explicit read acknowledgement, never just delivery. */
export function AgentDeliveryReceipt({ receipt, status }: {
  receipt?: Receipt
  status?: AgentMessage['delivery_status']
}) {
  const { t } = useTranslation('agent')
  const state = status === 'interrupted' || status === 'cancelled' ? status
    : receipt ?? (status === 'delivered' ? 'received' : 'sent')
  const label = t(`receipt.${state}`)
  const Icon = state === 'interrupted' ? TriangleAlert : state === 'cancelled' ? CircleX
    : state === 'sent' ? Check : CheckCheck
  return (
    <span role="img" aria-label={label} title={label} data-testid="agent-delivery-receipt" data-receipt={state}
      className={`inline-flex shrink-0 items-center align-middle ${state === 'read' ? 'text-emerald-500' : state === 'interrupted' ? 'text-accent-warning' : 'text-foreground/45'}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" strokeWidth={2} />
    </span>
  )
}
