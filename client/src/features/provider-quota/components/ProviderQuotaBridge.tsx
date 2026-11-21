/**
 * Mounted once in the main window: keeps the quota and subscription-usage
 * stores live from the server's pushes and announces escalations (≥80 %,
 * ≥90 %, refused) through the attention pipeline (category `budget`).
 */
import { useEffect, useRef } from 'react'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import i18n from '../../../lib/i18n'
import { appAttention } from '../../../lib/attention/app-attention'
import type { AttentionCenter } from '../../../lib/attention/attention-center'
import { requestOpenInbox } from '../../../lib/inbox-events'
import { usageStore } from '../../subscription-usage/lib/store'
import { quotaStore } from '../lib/quota-store'
import { quotaEscalations } from '../lib/quota-attention'
import { formatResetTime } from '../lib/format-reset'
import { providerLabel, windowLabel } from '../lib/labels'
import type { ProviderQuota } from '../lib/types'

export function ProviderQuotaBridge({ center = appAttention }: { center?: AttentionCenter }) {
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const previous = useRef<ProviderQuota[] | null>(null)
  useEffect(() => {
    void quotaStore.load()
    return quotaStore.subscribe(() => {
      const current = quotaStore.getSnapshot().providers
      // The first read is the baseline: only changes after it are news.
      if (previous.current !== null) for (const escalation of quotaEscalations(previous.current, current)) {
        const provider = providerLabel(escalation.providerId)
        const { quota } = escalation
        const refused = escalation.level === 'rejected'
        const time = quota.rejectedUntil ? formatResetTime(quota.rejectedUntil, i18n.language) : null
        const title = refused ? i18n.t('providerQuota:attention.rejectedTitle', { provider }) : i18n.t('providerQuota:attention.warningTitle', { provider, percent: Math.round(quota.usedPercent ?? 0) })
        void center.dispatch({
          key: escalation.key,
          subjectKey: `budget:quota:${escalation.providerId}`,
          category: 'budget',
          projectId: null,
          title,
          copy: { kind: 'generic', message: title },
          body: refused
            ? time ? i18n.t('providerQuota:attention.rejectedBody', { provider, time }) : i18n.t('providerQuota:attention.rejectedBodyNoReset', { provider })
            : i18n.t('providerQuota:attention.warningBody', { provider, percent: Math.round(quota.usedPercent ?? 0), window: windowLabel(quota.windowId) }),
          open: requestOpenInbox,
        })
      }
      previous.current = current
    })
  }, [center])
  useEffect(() => {
    registerHandler('provider-quota', (message) => {
      const msg = message as { type?: string; snapshot?: unknown } | null
      if (msg?.type === 'provider_quota.updated') quotaStore.accept(msg)
      else if (msg?.type === 'subscription_usage.updated') usageStore.push(msg.snapshot)
    })
    return () => unregisterHandler('provider-quota')
  }, [registerHandler, unregisterHandler])
  return null
}
