/**
 * pr-ci-loop "Fix CI" from a PR decision card: the same launch as the
 * mission's CI offer card, available only for a CI-fixable open PR.
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FEATURE_PR_CI_CARD } from '../../../../lib/feature-flags'
import { postPrCiLaunch, prCiFixable, usePrCiAvailability } from '../../../delivery/lib/pr-ci'
import type { AgentPrDecisionEnvelope } from '../../lib/agent-api'

export function usePrCiFix(args: {
  envelope: AgentPrDecisionEnvelope
  conversationId: string | null | undefined
  anyBusyRef: MutableRefObject<boolean>
}) {
  const { envelope, conversationId, anyBusyRef } = args
  const { t } = useTranslation('agent')
  const { decision, prUrl } = envelope
  // pr-ci-loop: "Fix CI" — the same launch as the mission's CI offer card.
  const ciAvailable = usePrCiAvailability(FEATURE_PR_CI_CARD ? envelope.projectId : null)
  const ciInFlight = useRef(false)
  const [ciStarting, setCiStarting] = useState(false)
  const [ciError, setCiError] = useState<string | null>(null)
  useEffect(() => { setCiError(null) }, [envelope.prDeliveryId])

  const fixCi = async () => {
    if (ciInFlight.current || anyBusyRef.current) return
    ciInFlight.current = true
    setCiStarting(true); setCiError(null)
    const outcome = await postPrCiLaunch(envelope.projectId, envelope.railIndex, { prDeliveryId: envelope.prDeliveryId, originConversationId: conversationId })
    if (outcome.kind === 'started') toast.success(t('prCi.startedToast', { index: envelope.railIndex + 1 }))
    else setCiError(outcome.detail || t('prCi.startFailed'))
    ciInFlight.current = false
    setCiStarting(false)
  }
  const canFixCi = ciAvailable && prCiFixable({ decision, prUrl, repositoryDeliveries: envelope.repositoryDeliveries })

  return { ciStarting, ciError, fixCi, canFixCi }
}
