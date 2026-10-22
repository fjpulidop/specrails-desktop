/**
 * The reviewer's risk brief (Core capability `reviewBrief: 1`, contract 5.3):
 * an advisory "what to look at" record the runtime reviewer writes next to its
 * verdict. Desktop harvests it at settle into `settle_evidence`, renders it
 * first in the review packet, summarizes it in the PR body and shows the top
 * risk on the mission / delivery cards.
 *
 * Pure module: tolerant normalization and summaries only. Every field is
 * optional on the wire (older reviewers, custom reviewer definitions), so a
 * malformed entry is dropped and counted rather than failing the harvest; the
 * approval gate never reads the brief, and neither does any Desktop decision.
 */

export const REVIEW_BRIEF_FILE = 'review-brief.json'
export const REVIEW_BRIEF_RISK_LIMIT = 5
const LIST_LIMIT = 20
const TEXT_LIMIT = 2000
const DIAGNOSTIC_LIMIT = 600

export type ReviewRiskSeverity = 'high' | 'medium' | 'low'
export type ReviewInvariantStatus = 'kept' | 'changed' | 'at-risk'
export const REVIEW_RISK_SEVERITIES: readonly ReviewRiskSeverity[] = ['high', 'medium', 'low']
const INVARIANT_STATUSES: readonly ReviewInvariantStatus[] = ['kept', 'changed', 'at-risk']
const SEVERITY_RANK: Record<ReviewRiskSeverity, number> = { high: 0, medium: 1, low: 2 }

export interface ReviewBehaviourChange { what: string; where: string | null; userVisible: boolean | null }
export interface ReviewInvariant { invariant: string; evidence: string | null; status: ReviewInvariantStatus | null }
export interface ReviewUntested { path: string; why: string | null }
export interface ReviewRisk { severity: ReviewRiskSeverity; area: string | null; whatToLookAt: string; ref: string | null }
export interface ReviewDivergence { capability: string; requirement: string; observed: string }

/** Normalized brief: every list present (possibly empty), risks sorted high first. */
export interface DeliveryReviewBrief {
  behaviourChanges: ReviewBehaviourChange[]
  invariantsTouched: ReviewInvariant[]
  untested: ReviewUntested[]
  risks: ReviewRisk[]
  humanChecks: string[]
  divergences: ReviewDivergence[]
}

/** Where the record was read from (provenance stays visible for audits). */
export type ReviewBriefSource = 'pipeline' | 'definition' | 'confidence-score'

/** One unit's brief record as persisted in settle evidence. */
export interface DeliveryReviewBriefRecord {
  source: ReviewBriefSource
  approved: boolean | null
  score: number | null
  recordedAt: string | null
  /** null = the reviewer recorded a verdict without a brief (or it was dropped). */
  brief: DeliveryReviewBrief | null
  /** Core's note when it dropped a malformed brief after the repair turn, or
   *  Desktop's own note when the record could not be read. */
  diagnostic: string | null
  /** Entries Desktop discarded because they did not match the contract. */
  droppedEntries: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, cap = TEXT_LIMIT): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, cap) : null
}

function list<T>(value: unknown, parse: (item: unknown) => T | null, counter: { dropped: number }): T[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) { counter.dropped++; return [] }
  const out: T[] = []
  for (const item of value) {
    const parsed = parse(item)
    if (parsed === null) counter.dropped++
    else if (out.length < LIST_LIMIT) out.push(parsed)
  }
  return out
}

/**
 * Tolerant normalization of a brief object. Returns null when the value is not
 * an object at all; otherwise a brief with every list present. Entries missing
 * their key text (or carrying an unknown severity) are dropped and counted —
 * a risk without a severity cannot be ordered honestly.
 */
export function normalizeReviewBrief(value: unknown): { brief: DeliveryReviewBrief; dropped: number } | null {
  if (!isRecord(value)) return null
  const counter = { dropped: 0 }
  const behaviourChanges = list(value.behaviourChanges, (item) => {
    if (!isRecord(item)) return null
    const what = text(item.what)
    return what ? { what, where: text(item.where), userVisible: typeof item.userVisible === 'boolean' ? item.userVisible : null } : null
  }, counter)
  const invariantsTouched = list(value.invariantsTouched, (item) => {
    if (!isRecord(item)) return null
    const invariant = text(item.invariant)
    const status = INVARIANT_STATUSES.includes(item.status as ReviewInvariantStatus) ? item.status as ReviewInvariantStatus : null
    return invariant ? { invariant, evidence: text(item.evidence), status } : null
  }, counter)
  const untested = list(value.untested, (item) => {
    if (!isRecord(item)) return null
    const filePath = text(item.path)
    return filePath ? { path: filePath, why: text(item.why) } : null
  }, counter)
  const risks = list(value.risks, (item) => {
    if (!isRecord(item)) return null
    const whatToLookAt = text(item.whatToLookAt)
    if (!whatToLookAt || !REVIEW_RISK_SEVERITIES.includes(item.severity as ReviewRiskSeverity)) return null
    return { severity: item.severity as ReviewRiskSeverity, area: text(item.area, 40), whatToLookAt, ref: text(item.ref) }
  }, counter)
  const humanChecks = list(value.humanChecks, (item) => text(item), counter)
  const divergences = list(value.divergences, (item) => {
    if (!isRecord(item)) return null
    const capability = text(item.capability), requirement = text(item.requirement), observed = text(item.observed)
    return capability && requirement && observed ? { capability, requirement, observed } : null
  }, counter)
  return {
    brief: { behaviourChanges, invariantsTouched, untested, risks: sortRisks(risks).slice(0, REVIEW_BRIEF_RISK_LIMIT), humanChecks, divergences },
    dropped: counter.dropped,
  }
}

/** Stable severity order: high, medium, low; original order within a severity. */
export function sortRisks<T extends { severity: ReviewRiskSeverity }>(risks: readonly T[]): T[] {
  return risks.map((risk, index) => ({ risk, index }))
    .sort((a, b) => SEVERITY_RANK[a.risk.severity] - SEVERITY_RANK[b.risk.severity] || a.index - b.index)
    .map((entry) => entry.risk)
}

export function isEmptyReviewBrief(brief: DeliveryReviewBrief): boolean {
  return brief.behaviourChanges.length === 0 && brief.invariantsTouched.length === 0 && brief.untested.length === 0
    && brief.risks.length === 0 && brief.humanChecks.length === 0 && brief.divergences.length === 0
}

function score(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Read Core's `review-brief.json` record (`{schemaVersion:1, change, approved,
 * score, recordedAt, brief|null, diagnostic?}`). Returns null when there is no
 * record; an unreadable or unknown-version record becomes a record without a
 * brief whose diagnostic says so, so the packet never silently loses it.
 */
export function parseReviewBriefRecord(raw: string): DeliveryReviewBriefRecord {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    return unreadableRecord('pipeline', 'The review brief file is not valid JSON.')
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    return unreadableRecord('pipeline', 'The review brief file has an unsupported schema version.')
  }
  return recordFrom('pipeline', parsed.brief, parsed.diagnostic, {
    approved: typeof parsed.approved === 'boolean' ? parsed.approved : null,
    score: score(parsed.score),
    recordedAt: text(parsed.recordedAt, 64),
  })
}

function unreadableRecord(source: ReviewBriefSource, diagnostic: string): DeliveryReviewBriefRecord {
  return { source, approved: null, score: null, recordedAt: null, brief: null, diagnostic, droppedEntries: 0 }
}

function recordFrom(
  source: ReviewBriefSource,
  rawBrief: unknown,
  rawDiagnostic: unknown,
  verdict: { approved: boolean | null; score: number | null; recordedAt: string | null },
): DeliveryReviewBriefRecord {
  const normalized = rawBrief === null || rawBrief === undefined ? null : normalizeReviewBrief(rawBrief)
  const malformed = rawBrief !== null && rawBrief !== undefined && normalized === null
  return {
    source,
    ...verdict,
    brief: normalized?.brief ?? null,
    diagnostic: text(rawDiagnostic, DIAGNOSTIC_LIMIT) ?? (malformed ? 'The review brief is not an object.' : null),
    droppedEntries: normalized?.dropped ?? 0,
  }
}

/**
 * Brief carried by a reviewer output object (engine 2 piece output `review`,
 * a reviewer implementation step, or a reviewer role turn). Returns null when
 * the output carries neither a brief nor a brief diagnostic (older Core).
 */
export function reviewBriefFromReviewerOutput(output: unknown, source: ReviewBriefSource = 'definition'): DeliveryReviewBriefRecord | null {
  if (!isRecord(output)) return null
  if (!('brief' in output) && !('briefDiagnostic' in output)) return null
  return recordFrom(source, output.brief, output.briefDiagnostic, {
    approved: typeof output.approved === 'boolean' ? output.approved : null,
    score: score(output.score),
    recordedAt: null,
  })
}

/** Compact per-delivery risk summary for cards and analytics. */
export interface DeliveryRiskSummary {
  highCount: number
  mediumCount: number
  lowCount: number
  /** The first risk after severity ordering across all units (null = none listed). */
  top: ReviewRisk | null
  /** True when a unit's brief was dropped or unreadable. */
  diagnostic: boolean
}

/** Summarize the brief records of one delivery; null when no unit carries one. */
export function summarizeReviewBriefs(records: ReadonlyArray<DeliveryReviewBriefRecord | null | undefined>): DeliveryRiskSummary | null {
  const present = records.filter((record): record is DeliveryReviewBriefRecord => !!record)
  if (present.length === 0) return null
  const risks = sortRisks(present.flatMap((record) => record.brief?.risks ?? []))
  return {
    highCount: risks.filter((risk) => risk.severity === 'high').length,
    mediumCount: risks.filter((risk) => risk.severity === 'medium').length,
    lowCount: risks.filter((risk) => risk.severity === 'low').length,
    top: risks[0] ?? null,
    diagnostic: present.some((record) => record.diagnostic !== null),
  }
}

type PerTicket<T> = T & { ticketId: number }

/**
 * "What to look at": the reviewer's advisory risk brief (Core `reviewBrief: 1`),
 * merged across the delivery's units in a fixed order. AI-reported: it guides
 * the human's attention, it is never a measurement and never gates a decision.
 */
export interface PacketWhatToLookAt {
  /** Severity-ordered (high first) across every unit. */
  risks: PerTicket<ReviewRisk>[]
  behaviourChanges: PerTicket<ReviewBehaviourChange>[]
  invariantsTouched: PerTicket<ReviewInvariant>[]
  untested: PerTicket<ReviewUntested>[]
  humanChecks: PerTicket<{ text: string }>[]
  divergences: PerTicket<ReviewDivergence>[]
  /** Units whose brief was dropped by Core or unreadable by Desktop. */
  diagnostics: PerTicket<{ message: string }>[]
  /** Contract-violating entries Desktop skipped (0 for a well-formed brief). */
  droppedEntries: number
}

/** Merge every unit's brief into the packet section; null when there is nothing to show. */
export function buildWhatToLookAt(units: ReadonlyArray<{ ticketId: number; reviewBrief?: DeliveryReviewBriefRecord | null }>): PacketWhatToLookAt | null {
  const out: PacketWhatToLookAt = { risks: [], behaviourChanges: [], invariantsTouched: [], untested: [], humanChecks: [], divergences: [], diagnostics: [], droppedEntries: 0 }
  for (const unit of units) {
    const record = unit.reviewBrief
    if (!record) continue
    const ticketId = unit.ticketId
    if (record.diagnostic) out.diagnostics.push({ ticketId, message: record.diagnostic })
    out.droppedEntries += record.droppedEntries || 0
    const brief = record.brief
    if (!brief) continue
    out.risks.push(...brief.risks.map((entry) => ({ ...entry, ticketId })))
    out.behaviourChanges.push(...brief.behaviourChanges.map((entry) => ({ ...entry, ticketId })))
    out.invariantsTouched.push(...brief.invariantsTouched.map((entry) => ({ ...entry, ticketId })))
    out.untested.push(...brief.untested.map((entry) => ({ ...entry, ticketId })))
    out.humanChecks.push(...brief.humanChecks.map((entry) => ({ text: entry, ticketId })))
    out.divergences.push(...brief.divergences.map((entry) => ({ ...entry, ticketId })))
  }
  out.risks = sortRisks(out.risks)
  const empty = out.risks.length + out.behaviourChanges.length + out.invariantsTouched.length + out.untested.length
    + out.humanChecks.length + out.divergences.length + out.diagnostics.length === 0
  return empty ? null : out
}

