/**
 * PR review follow-up (pr-follow-up-fixes) — the Node half.
 *
 * "Resolve the review comments on this PR" is a DELTA on work that already
 * exists: the selected comments, the outcome each one requires, what must NOT
 * change, and how the fix is verified. Before this module the only carrier for
 * that delta was the spec itself — the operator rewrote the ticket description
 * (which Jira-backed projects sync to Jira) so the executor would understand the
 * scope, and the run still re-planned the whole feature. The scope now travels as
 * a typed, frozen object that is:
 *
 *  · validated and bounded at the launch route (never free-form metadata),
 *  · persisted on the delivery row (`follow_up`, migration 62) with an id,
 *    version and content hash — so what was approved is provable,
 *  · appended VERBATIM to every ai-step prompt of the run (implementation,
 *    verification, delivery) — not only to templates that reference a
 *    constant, so no phase can miss it,
 *  · rendered on the review packet with the run's per-comment report,
 *  · and NEVER written to the spec, its description, or Jira.
 *
 * Comment bodies are UNTRUSTED evidence of a problem, never instructions: the
 * briefing says so explicitly and the run's permissions do not widen.
 *
 * The pure contract (types, validation, briefing, report parser) is
 * `./pr-follow-up-scope` (mirrored into the client); this file adds freezing
 * and the persisted-column reader.
 */
import { createHash } from 'crypto'
import { newId } from '../../../ids'
import { canonicalContent, parseFollowUpInput, type PrFollowUp } from './pr-follow-up-scope'

export * from './pr-follow-up-scope'

export function followUpHash(input: Omit<PrFollowUp, 'id' | 'hash'>): string {
  return createHash('sha256').update(canonicalContent(input)).digest('hex')
}

/** Freeze a validated follow-up: assign its id and content hash. */
export function freezeFollowUp(input: Omit<PrFollowUp, 'id' | 'hash'>, id: string = newId()): PrFollowUp {
  return { id, ...input, hash: followUpHash(input) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a persisted follow-up; a malformed column reads as absent, never throws. */
export function readFollowUp(raw: string | null | undefined): PrFollowUp | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed) || typeof parsed.id !== 'string' || typeof parsed.hash !== 'string') return null
    const content = parseFollowUpInput(parsed)
    return { id: parsed.id, ...content, hash: parsed.hash }
  } catch {
    return null
  }
}

