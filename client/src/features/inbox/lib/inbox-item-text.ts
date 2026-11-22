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
/** A run held by a restart, an interruption, a plain pause or the person's Pause (`held:<kind>[:<step>]`), worded like the run window. */
function heldOf(item: InboxItem, t: Translate): { kindLabel: string; detail: string } | null {
  if (item.kind !== 'blocked' || !item.detail?.startsWith('held:')) return null
  const [, kind = 'paused', ...rest] = item.detail.split(':')
  const step = rest.join(':')
  const known = ['restart', 'interrupted', 'paused', 'pausedByYou'].includes(kind) ? kind : 'paused'
  // A plain pause or the person's own Pause says no step ("Paused by you. Nothing runs until you resume it.").
  const stepless = known === 'paused' || known === 'pausedByYou'
  const stepName = step ? String(t(`agentRuntime:roles.${step}`, { defaultValue: '' })) : ''
  const detail = stepName && !stepless ? t(`jobs:held.reason.${known}`, { step: stepName }) : t(`jobs:held.reason.${known}${stepless ? '' : 'NoStep'}`)
  return { kindLabel: String(t(`jobs:held.label.${known}`)), detail: String(detail) }
}

const CHAIN_REASONS = ['chunk_failed', 'chunk_stalled', 'chunk_stopped', 'provider_limit', 'head_missing', 'head_discarded', 'run_lost', 'rail_limit_reached', 'launch_rejected', 'integration_failed']
const CARD_KEYS = { 'rail-launch': 'railLaunch', 'flow-offer': 'flowOffer', 'pr-ci-offer': 'prCiOffer' } as const

/** A milestone chain that stopped: named by its milestone, worded by why it stopped (or where it stands at a checkpoint). */
function chainText(item: InboxItem, t: Translate): InboxItemText | null {
  const chain = item.chain
  if (item.kind !== 'chain' || !chain) return null
  const checkpoint = chain.status === 'awaiting_approval'
  const code = chain.pauseReason?.split(':')[0] ?? null
  const reason = code ? String(t(`inbox:chain.reason.${CHAIN_REASONS.includes(code) ? code : 'paused'}`)) : null
  const progress = chain.totalChunks > 0 ? String(t('inbox:chain.progress', { done: Math.min(chain.nextChunk, chain.totalChunks), total: chain.totalChunks })) : null
  return {
    title: String(t('inbox:chain.title', { n: chain.milestoneN })),
    kindLabel: String(t(checkpoint ? 'inbox:kinds.chainCheckpoint' : 'inbox:kinds.chain')),
    // A rail-caused pause carries that rail's diagnosis: its cause is the reason.
    detail: checkpoint ? progress : causeOf(item, t) ?? reason ?? progress,
    rawDetail: null,
  }
}

/** A mission card waiting for a decision: the mission, what the card proposes, and its subject. */
function missionText(item: InboxItem, t: Translate): InboxItemText | null {
  const card = item.card
  if (item.kind !== 'mission' || !card) return null
  const detail = card.kind === 'pr-ci-offer' ? (card.prNumber ? String(t('inbox:card.pr', { number: card.prNumber })) : null) : item.detail
  return { title: item.title, kindLabel: String(t(`inbox:missionCard.${CARD_KEYS[card.kind]}`)), detail, rawDetail: null }
}

export function inboxItemText(item: InboxItem, t: Translate, language: string): InboxItemText {
  const own = chainText(item, t) ?? missionText(item, t)
  if (own) return own
  const held = heldOf(item, t)
  if (held) return { title: item.attempt ? `${item.title} · ${String(t('inbox:attempt', { number: item.attempt.number }))}` : item.title, kindLabel: held.kindLabel, detail: held.detail, rawDetail: null }
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
