/**
 * "Needs you" inbox: pure vocabulary. The inbox is a read-model projected from
 * state other capabilities already own (deliveries, loop runs, the Jira
 * outbox); it has no store of its own. Dismissal (Snooze / Done) is a
 * per-viewer concern of the client and never reaches the server.
 */

/**
 * Why a failed/blocked run stopped, as the recovery module presents it. Declared
 * structurally so the inbox vocabulary stays dependency-free.
 */
import type { RunQuestion } from '../../shared/run-question'

export interface InboxDiagnosis {
  kind: string
  confidence: 'high' | 'low'
  phase: string | null
  rounds: number | null
  resetAt: string | null
  detail: string | null
  resumablePhase: string | null
  source: string
  remedies: string[]
}

export const INBOX_KINDS = ['review', 'question', 'failed', 'blocked', 'budget', 'jira', 'chain', 'mission'] as const
export type InboxKind = (typeof INBOX_KINDS)[number]

/** What the primary inline action does (the client maps each to the existing handler/route). */
export const INBOX_ACTIONS = ['open-review', 'open-run', 'resume-run', 'retry-jira', 'raise-cap', 'resume-chain', 'open-mission'] as const
export type InboxAction = (typeof INBOX_ACTIONS)[number]

export interface InboxItem {
  /** Stable identity of the thing that needs the person: `<projectId>:<kind>:<sourceId>`. */
  id: string
  projectId: string
  projectName: string
  kind: InboxKind
  title: string
  /** One short plain-language line (outcome, failure code, dead reason), never a log tail. */
  detail: string | null
  /** When the item started waiting (ISO). */
  at: string
  /**
   * Changes whenever the underlying state changes in a way that deserves a
   * fresh look. "Done" hides an item only while its version is unchanged.
   */
  version: string
  action: InboxAction
  /** Source row the action addresses (delivery id, loop-run id, outbox id). */
  subjectId: string
  /** Mission that launched the work, when known (deep link target). */
  conversationId: string | null
  /** Why a failed/blocked run stopped, with ranked remedies; null for every other item. */
  diagnosis: InboxDiagnosis | null
  /** Present only on a "spend cap reached" item (`raise-cap`): which cap and where it stands. */
  cap?: InboxCap
  /** The specs the work is about (a delivery or a run), when known: the title names the first. */
  ticketIds?: number[]
  /** Rail the work ran on, when the item addresses one (a delivery or a run); lets a remote surface retry it. */
  railIndex?: number
  /** Where the run stands in its attempt chain, when it continued an earlier attempt ("attempt 3 of #14"). */
  attempt?: { number: number; of: number }
  /** A question item (a run paused on the person): the question card every surface renders. */
  question?: RunQuestion
  /** A delivery item's decision state (`on_review`, `pr_failed`, ...): the optimistic-concurrency token of a PR decision. */
  decision?: string
  /** A `chain` item: the milestone chain that stopped for the person (paused, or at a checkpoint). */
  chain?: InboxChain
  /** A `mission` item: the mission card that waits for the person's decision. */
  card?: InboxMissionCard
}

/** A milestone launch chain that waits for the person (`resume-chain`). */
export interface InboxChain {
  milestoneN: number
  /** `paused` (a failure, a limit, a conflict, or the person's pause) or `awaiting_approval` (a checkpoint between rails). */
  status: 'paused' | 'awaiting_approval'
  /** The chain's pause reason code (`chunk_failed`, `provider_limit`, `integration_failed:conflict`, ...); null at a checkpoint. */
  pauseReason: string | null
  autoAdvance: boolean
  /** Rails launched so far, and the plan's total. */
  nextChunk: number
  totalChunks: number
  /** 0-based rail that failed (Resume can continue it from the failed step), else null. */
  retryChunk: number | null
}

export const INBOX_CARD_KINDS = ['rail-launch', 'flow-offer', 'pr-ci-offer'] as const
export type InboxCardKind = (typeof INBOX_CARD_KINDS)[number]

/** A mission card that waits for the person (`open-mission`): a launch proposal, an Intent offer or a CI-fix offer. */
export interface InboxMissionCard {
  /** `<messageId>:<kind>:<index>`, the id `specrails_missions(card_decide)` takes. */
  id: string
  kind: InboxCardKind
  /** rail-launch: the specs it would launch. */
  ticketIds?: number[]
  /** pr-ci-offer: the PR whose CI failed. */
  prNumber?: number
  prDeliveryId?: string
}

/** A spend cap that is reached right now (CD5). */
export interface InboxCap {
  scope: 'project' | 'desktop'
  period: 'day' | 'week' | 'month'
  budgetUsd: number
  spentUsd: number
  resetsAt: string
}

export interface ProjectInbox {
  projectId: string
  projectName: string
  count: number
}

export interface InboxSnapshot {
  items: InboxItem[]
  projects: ProjectInbox[]
  generatedAt: string
}

export const MAX_ITEMS_PER_PROJECT = 50

export function inboxItemId(projectId: string, kind: InboxKind, sourceId: string): string {
  return `${projectId}:${kind}:${sourceId}`
}

/** Newest first; ties broken by id so the order is deterministic. */
export function compareInboxItems(a: InboxItem, b: InboxItem): number {
  const delta = Date.parse(b.at) - Date.parse(a.at)
  if (Number.isFinite(delta) && delta !== 0) return delta
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Bound a free-text fragment to a single short line. */
export function oneLine(value: string | null | undefined, max = 140): string | null {
  if (!value) return null
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** SQLite `datetime('now')` is UTC without a zone: make it ISO so clients parse it right. */
export function toIso(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`
  return Number.isNaN(Date.parse(normalized)) ? fallback : new Date(normalized).toISOString()
}
