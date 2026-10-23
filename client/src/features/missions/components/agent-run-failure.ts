// ─── Mission run-failure rows + card focus bus (mission-rail-cards) ──────────
// When a mission-originated run fails/stalls, the server posts a `system` row
// `{ kind:'run-failure', … }` into the origin mission and (optionally) an
// automatic briefing turn persisted as a `user` row whose first context ref is
// `{ kind:'system-briefing', id:<runId> }`. This module parses both shapes and
// owns the tiny window-event bus that lets any surface (the failure marker, the
// launch card's "View run" stub) focus the matching run/PR card in the dock.

import type { AgentContextReference } from '../lib/agent-context-palette'
import type { AgentMessage } from '../lib/agent-api'

export interface RunFailureRow {
  kind: 'run-failure'
  runId: string
  railIndex: number
  projectId: string
  /** Stable failure code (implementation_failed | stalled | provider_limit | stuck | launch_failed | …). */
  code: string
  detail: string | null
  stepId: string | null
  at: string | null
  /** Present for delivery-backed runs; null/absent for shared-cwd runs. */
  prDeliveryId?: string | null
}

/** Parse a system row's content; null when it is not a run-failure row. */
export function parseRunFailureRow(content: string): RunFailureRow | null {
  let v: unknown
  try { v = JSON.parse(content) } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (o.kind !== 'run-failure') return null
  if (typeof o.runId !== 'string' || !o.runId) return null
  if (typeof o.railIndex !== 'number' || !Number.isInteger(o.railIndex) || o.railIndex < 0) return null
  if (typeof o.projectId !== 'string' || !o.projectId) return null
  if (typeof o.code !== 'string' || !o.code) return null
  return {
    kind: 'run-failure',
    runId: o.runId,
    railIndex: o.railIndex,
    projectId: o.projectId,
    code: o.code,
    detail: typeof o.detail === 'string' && o.detail.trim() ? o.detail : null,
    stepId: typeof o.stepId === 'string' && o.stepId ? o.stepId : null,
    at: typeof o.at === 'string' ? o.at : null,
    ...(typeof o.prDeliveryId === 'string' ? { prDeliveryId: o.prDeliveryId } : o.prDeliveryId === null ? { prDeliveryId: null } : {}),
  }
}

/** A `user` row the SERVER wrote as the automatic failure briefing (not typed by the person). */
export function systemBriefingRunId(message: Pick<AgentMessage, 'role' | 'context_refs'>): string | null {
  if (message.role !== 'user') return null
  const first = (message.context_refs ?? [])[0] as AgentContextReference | undefined
  if (!first || (first.kind as string) !== 'system-briefing') return null
  return typeof first.id === 'string' && first.id ? first.id : null
}

// ── Focus bus ─────────────────────────────────────────────────────────────────
// Dispatched by: the history's event lines (launched, failed), the launch
// card's launched stub ("Go to card"), the Flow offer's "View run". Listened
// by: the run strip, which shows the matching live run and opens its panel
// (a hidden card cannot take focus) and re-dispatches; a settled Flow → Spec
// event line, which expands its card and re-dispatches; and every mounted
// AgentPrDecisionCard, which scrolls itself into view, takes keyboard focus
// and pulses when it matches.
export const FOCUS_PR_CARD_EVENT = 'specrails:focus-pr-card'

export interface FocusPrCardDetail {
  prDeliveryId?: string | null
  runIds?: string[]
  /** Scope to one mission (split panes show several); absent = any. */
  conversationId?: string | null
  /** Set by the strip / an event line when it re-dispatches after expanding: never handled twice. */
  expanded?: boolean
}

/** True when a focus request is not scoped to another conversation. */
export function focusInConversation(detail: FocusPrCardDetail | null | undefined, conversationId: string): boolean {
  return !detail?.conversationId || detail.conversationId === conversationId
}

/** Smooth unless the person asked the OS for reduced motion. */
export function focusScrollBehavior(): ScrollBehavior {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  } catch {
    return 'smooth'
  }
}

export function focusPrCard(detail: FocusPrCardDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<FocusPrCardDetail>(FOCUS_PR_CARD_EVENT, { detail }))
}

/** True when a focus request targets the given card (by delivery id or any run id). */
export function focusMatchesCard(detail: FocusPrCardDetail | null | undefined, card: { prDeliveryId: string; runIds?: string[] }): boolean {
  if (!detail) return false
  if (detail.prDeliveryId && detail.prDeliveryId === card.prDeliveryId) return true
  const runs = card.runIds ?? []
  return (detail.runIds ?? []).some((id) => runs.includes(id) || `run:${id}` === card.prDeliveryId)
}

// ── Run strip bus ─────────────────────────────────────────────────────────────
// Opens a run of the strip that has no delivery id (an undecided launch
// proposal) from its history line.
export const OPEN_RUN_STRIP_EVENT = 'specrails:open-run-strip'

export interface OpenRunStripDetail {
  conversationId: string | null
  /** The strip entry key (mission-run-strip.ts). */
  key: string
}

export function openRunStrip(detail: OpenRunStripDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<OpenRunStripDetail>(OPEN_RUN_STRIP_EVENT, { detail }))
}

// ── Mission-mode notification routing ────────────────────────────────────────
// OS/toast notification clicks in Mission mode must NOT navigate to `/jobs/:id`
// (that leaves Mission mode). They dispatch this event instead; the workspace
// provider opens the Jobs pane and the pane opens the run's JobDetailModal.
export const MISSION_OPEN_RUN_EVENT = 'specrails:mission-open-run'

export interface MissionOpenRunDetail {
  projectId: string | null
  jobId: string
}

export function requestMissionOpenRun(detail: MissionOpenRunDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<MissionOpenRunDetail>(MISSION_OPEN_RUN_EVENT, { detail }))
}
