import { useTranslation } from 'react-i18next'
import { formatUsd } from '../../../lib/format-usd'
import { useDiagnosisText } from '../../recovery/components/FailureDiagnosisCard'
import type { FailureDiagnosis } from '../../recovery/lib/failure-diagnosis'
import type { InboxItem } from '../lib/inbox-model'
import { providerLabel } from '../../provider-quota/lib/labels'
import { formatResetTime } from '../../provider-quota/lib/format-reset'

const NO_DIAGNOSIS: FailureDiagnosis = { kind: 'unknown', confidence: 'low', phase: null, rounds: null, resetAt: null, detail: null, resumablePhase: null, blocker: null, source: 'desktop', remedies: [] }

export interface InboxItemText {
  /** The item's title (a reached cap is worded here, in the app's language). */
  title: string
  /** The kind's words ("Review ready", "Waiting for your answer", "Spend limit reached"…). */
  kindLabel: string
  /** One line of why: the diagnosis headline, the cap figures, or the server's detail. */
  detail: string | null
  /** The raw outcome kept for a hover when the cause is unknown. */
  rawDetail: string | null
}

/**
 * How an inbox item reads, wherever it is shown (the inbox row, a live board
 * card): a failed or blocked run says WHY in plain words (its diagnosis card's
 * sentence), an unknown cause says so in the app's language, a reached cap
 * shows its figures.
 */
export function useInboxItemText(item: InboxItem): InboxItemText {
  const { t } = useTranslation('inbox')
  const { t: tQuota, i18n } = useTranslation('providerQuota')
  const diagnosis = useDiagnosisText(item.diagnosis ?? NO_DIAGNOSIS)
  const cause = item.diagnosis && item.diagnosis.kind !== 'unknown' ? diagnosis.headline : null
  const rawNoCause = !cause && item.kind === 'failed'
  const cap = item.cap
  // provider-quota: a run paused at a usage limit (`usage_limit:<provider>:<resumeAt|''>`).
  const limit = item.kind === 'budget' && item.detail?.startsWith('usage_limit:') ? item.detail.split(':') : null
  const limitDetail = limit ? (() => {
    const provider = providerLabel(limit[1] ?? '')
    const resumeAt = limit.slice(2).join(':')
    return resumeAt && Number.isFinite(Date.parse(resumeAt)) ? `${tQuota('pause.title', { provider })} — ${tQuota('mission.scheduled', { time: formatResetTime(resumeAt, i18n.language) })}` : tQuota('pause.title', { provider })
  })() : null
  return {
    title: cap ? t(`cap.title.${cap.scope}.${cap.period}`) : item.title,
    kindLabel: item.action === 'raise-cap' ? t('kinds.capReached') : t(`kinds.${item.kind}`),
    detail: limitDetail ?? (cap ? t('cap.detail', { spent: formatUsd(cap.spentUsd), budget: formatUsd(cap.budgetUsd) }) : cause ?? (rawNoCause ? t('kinds.failedNoCause') : item.detail)),
    rawDetail: rawNoCause ? item.detail : null,
  }
}
