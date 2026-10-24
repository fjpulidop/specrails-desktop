// ─── Flow failure vocabulary (pure) ───────────────────────────────────────────
// A Flow → Spec run that failed outright is explained in the person's words:
// a localized headline per failing step (`flow.failure.step.<group>`) and the
// runtime's own error as the cause. Server codes and English details stay
// under "Technical details". Flow API errors map by code the same way.

import type { TFunction } from 'i18next'
import { FlowApiError } from './flow-api'

/** The steps of `factory:flow-spec` grouped by what the person understands. */
export type FlowFailureStep = 'derive' | 'verify' | 'review' | 'fix' | 'archive' | 'settle' | 'unknown'

/** Exact step ids of the Flow → Spec recipe (server loop-flow-spec-recipe.ts). */
const STEP_GROUPS: Readonly<Record<string, FlowFailureStep>> = Object.freeze({
  init: 'derive',
  derive: 'derive',
  'repair-guard': 'derive',
  'repair-count': 'derive',
  check: 'verify',
  'check-findings': 'verify',
  verify: 'verify',
  review: 'review',
  'review-policy': 'review',
  'review-findings': 'review',
  'correction-budget': 'fix',
  'begin-correction': 'fix',
  fix: 'fix',
  'fix-progress': 'fix',
  archive: 'archive',
})

/** Delivery codes that fail after the run itself (handing the result back). */
const SETTLE_CODES = new Set(['branch_verification_failed', 'delivery_failed', 'push_failed', 'settlement_failed'])

/** The step group a failure belongs to (`unknown` when nothing names it). */
export function flowFailureStep(stepId: string | null | undefined, codes: ReadonlyArray<string | null | undefined> = []): FlowFailureStep {
  const id = stepId?.trim().toLowerCase() ?? ''
  if (id) {
    const exact = STEP_GROUPS[id]
    if (exact) return exact
    if (id.includes('deriv')) return 'derive'
    if (id.includes('review')) return 'review'
    if (id.includes('archive')) return 'archive'
    if (id.includes('fix') || id.includes('correction')) return 'fix'
    if (id.includes('verif') || id.includes('check')) return 'verify'
  }
  if (codes.some((code) => !!code && SETTLE_CODES.has(code))) return 'settle'
  return 'unknown'
}

/** The first non-empty line of an error text, bounded (null when there is none). */
export function firstLine(text: string | null | undefined, cap = 240): string | null {
  const line = (text ?? '').split('\n').map((entry) => entry.trim()).find(Boolean)
  if (!line) return null
  return line.length <= cap ? line : `${line.slice(0, cap - 1).trimEnd()}…`
}

/**
 * A Flow API failure in the person's language: the message by code (generic
 * when the code is unknown) and the server's own detail as a secondary line.
 */
export function flowErrorMessage(t: TFunction, error: unknown): { message: string; detail: string | null } {
  if (error instanceof FlowApiError) {
    const message = t(`flow.errors.${error.code}`, { defaultValue: '' }) || t('flow.errors.generic')
    const detail = error.detail && error.detail !== error.code ? firstLine(error.detail) : null
    return { message, detail }
  }
  return { message: t('flow.errors.generic'), detail: error instanceof Error ? firstLine(error.message) : null }
}
