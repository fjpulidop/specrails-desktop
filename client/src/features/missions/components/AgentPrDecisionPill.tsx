import { useTranslation } from 'react-i18next'
import { RunStatePill } from '../../../components/ui/run-state/run-state-pill'
import { deliveryLook } from '../../delivery/lib/delivery-run-state'
import type { AgentPrDecisionValue } from '../lib/agent-api'

/** Compact decision-state pill (the project builder's milestone rows), in the status vocabulary. */
export function PrDecisionPill({ decision }: { decision: AgentPrDecisionValue }) {
  const { t } = useTranslation('agent')
  const look = deliveryLook(decision)
  return (
    <RunStatePill
      data-testid="pr-decision-pill"
      state={look.state}
      objectIcon={look.objectIcon}
      label={t(`prCard.pinned.state.${decision}`)}
      className="px-1.5 py-px"
    />
  )
}
