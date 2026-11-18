// ─── How an inbox item reads, everywhere ─────────────────────────────────────
// One wording per item: the inbox row, a live board card and the notification
// (OS notification, toast) all read the item through this function, so the
// same item never says two different things in two places. Pure: the caller
// passes its translate function and language (a hook binds them in React, the
// attention pipeline binds the app's i18n).

import type { TFunction } from 'i18next'
import { formatUsd } from '../../../lib/format-usd'
import { headlineKey, humanizePhase } from '../../recovery/lib/failure-diagnosis'
import { providerLabel } from '../../provider-quota/lib/labels'
import { formatResetTime } from '../../provider-quota/lib/format-reset'
import type { InboxItem } from './inbox-model'

export interface InboxItemText {
  /** The item's title (a reached cap is worded here, in the app's language). */
  title: string
  /** The kind's words ("Review ready", "Waiting for your answer", "Work paused"…). */
  kindLabel: string
  /** One line of why: the diagnosis headline, the cap figures, the usage limit, or the server's detail. */
  detail: string | null
  /** The raw outcome kept for a hover when the cause is unknown. */
  rawDetail: string | null
}

type Translate = TFunction | ((key: string, options?: Record<string, unknown>) => string)

/** The plain-language cause of a failed or blocked run, when its diagnosis knows one. */
function causeOf(item: InboxItem, t: Translate): string | null {
  const diagnosis = item.diagnosis
  if (!diagnosis || diagnosis.kind === 'unknown') return null
  const phase = diagnosis.phase
  const phaseLabel = phase ? String(t(`agentRuntime:roles.${phase}`, { defaultValue: humanizePhase(phase) ?? phase })) : null
  const head = headlineKey(diagnosis, phaseLabel)
  return String(t(`recovery:${head.key}`, head.params))
}

/**
 * provider-quota: a run paused at a usage limit (`usage_limit:<provider>:<resumeAt|''>`) is named by
 * that limit ("Paused at the Claude usage limit"), not by a spend limit, and says when it continues.
 */
function usageLimitOf(item: InboxItem, t: Translate, language: string): { kindLabel: string; detail: string | null } | null {
  if (item.kind !== 'budget' || !item.detail?.startsWith('usage_limit:')) return null
  const parts = item.detail.split(':')
  const provider = providerLabel(parts[1] ?? '')
  const resumeAt = parts.slice(2).join(':')
  const when = resumeAt && Number.isFinite(Date.parse(resumeAt))
    ? String(t('providerQuota:mission.scheduled', { time: formatResetTime(resumeAt, language) })).replace(/[.。]$/, '')
    : null
  return { kindLabel: String(t('providerQuota:pause.title', { provider })), detail: when }
}

/**
 * The item's words: a failed or blocked run says WHY (its diagnosis card's
 * sentence), an unknown cause says so in the app's language (the raw outcome
 * stays for a hover), a reached cap names the cap and shows its figures, a run
 * paused at a provider's usage limit names that limit and says when it continues.
 */
export function inboxItemText(item: InboxItem, t: Translate, language: string): InboxItemText {
  const cause = causeOf(item, t)
  const rawNoCause = !cause && item.kind === 'failed'
  const limit = usageLimitOf(item, t, language)
  const cap = item.cap
  const capDetail = cap ? String(t('inbox:cap.detail', { spent: formatUsd(cap.spentUsd), budget: formatUsd(cap.budgetUsd) })) : null
  return {
    title: cap ? String(t(`inbox:cap.title.${cap.scope}.${cap.period}`))
      : item.attempt ? `${item.title} · ${String(t('inbox:attempt', { number: item.attempt.number }))}` : item.title,
    kindLabel: limit?.kindLabel ?? String(t(item.action === 'raise-cap' ? 'inbox:kinds.capReached' : `inbox:kinds.${item.kind}`)),
    detail: limit ? limit.detail : capDetail ?? cause ?? (rawNoCause ? String(t('inbox:kinds.failedNoCause')) : item.detail),
    rawDetail: rawNoCause ? item.detail : null,
  }
}
