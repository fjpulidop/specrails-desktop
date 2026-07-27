/**
 * Deterministic settle-time evidence harvest for the review packet
 * (nontech-review-experience Wave 1). Reads three sources with zero model
 * calls: the `VERIFICATION: PASS/FAIL` sentinel from the run's persisted
 * stream (the rail-merge-orchestrator regex precedent), a bounded tail of the
 * verify step's output, and the reviewer's `confidence-score.json` written
 * into the worktree's `openspec/changes/<name>/` (core ≥4.12 — previously read
 * by nothing). Harvest NEVER throws and never blocks settle: every missing or
 * malformed source degrades to an absent value on the evidence record, so the
 * packet can always state honestly what it does and does not know.
 */
import fs from 'fs'
import path from 'path'
import type { EventRow } from './types'

/** Bounded tail of the verify step's raw output persisted per unit. */
export const VERIFY_TAIL_CAP = 4096
/** Raw confidence-score.json payloads are capped before persistence. */
export const CONFIDENCE_RAW_CAP = 8192

export type SentinelVerdict = 'pass' | 'fail' | 'absent'

/** Normalized view of a reviewer confidence-score.json. Fields the schema does
 * not carry (or that fail to parse) stay null/empty — never invented. */
export interface DeliveryConfidenceScore {
  /** The openspec change dir the file was found under (null = unknown). */
  changeName: string | null
  overall: number | null
  /** Per-aspect numeric scores, tolerant of either `aspects` or `scores`. */
  aspects: Record<string, number>
  flags: string[]
  /** Original parsed JSON (size-capped at read time) for forward compat. */
  raw: unknown
}

export interface DeliveryUnitEvidence {
  ticketId: number
  runId: string | null
  sentinel: SentinelVerdict
  /** Trailing free text after a FAIL sentinel (single line, bounded). */
  sentinelDetail: string | null
  /** Bounded tail of the verify step's output (raw text, never summarized). */
  verifyTail: string | null
  confidence: DeliveryConfidenceScore | null
}

export interface DeliverySettleEvidence {
  schemaVersion: 1
  /** ok = every source attempted cleanly (absence is NOT an error);
   *  partial = at least one source errored; failed = nothing could be read. */
  harvest: 'ok' | 'partial' | 'failed'
  harvestedAt: string
  units: DeliveryUnitEvidence[]
}

export interface EvidenceHarvestUnit {
  ticketId: number
  runId: string | null
  worktreePath: string | null
}

export interface EvidenceHarvestIO {
  /** Persisted run stream (events table rows, seq ASC). */
  readEvents: (runId: string) => EventRow[]
  /** Injectable fs seams for tests. */
  readFile?: (filePath: string) => string
  listDir?: (dirPath: string) => string[]
  fileExists?: (filePath: string) => boolean
  now?: () => Date
}

/** Last sentinel wins: the verify prompt itself quotes the format, so earlier
 * mentions in assistant reasoning must not shadow the final verdict line. */
const SENTINEL_RE = /VERIFICATION:\s*(PASS|FAIL)\b[ \t]*(?:[—:-][ \t]*)?([^\n]*)/gi

export function parseVerificationSentinel(text: string): { verdict: SentinelVerdict; detail: string | null } {
  let verdict: SentinelVerdict = 'absent'
  let detail: string | null = null
  for (const match of text.matchAll(SENTINEL_RE)) {
    verdict = match[1].toUpperCase() === 'PASS' ? 'pass' : 'fail'
    const tail = (match[2] ?? '').trim()
    detail = verdict === 'fail' && tail ? tail.slice(0, 512) : null
  }
  return { verdict, detail }
}

interface ParsedStep {
  index: number | null
  nodeId: string | null
}

function parseLoopStepPayload(payload: string): ParsedStep | null {
  try {
    const parsed = JSON.parse(payload) as { index?: unknown; nodeId?: unknown }
    return {
      index: typeof parsed.index === 'number' ? parsed.index : null,
      nodeId: typeof parsed.nodeId === 'string' ? parsed.nodeId : null,
    }
  } catch {
    return null
  }
}

/** Extract human-readable text from one persisted event row. Assistant rows
 * hold the raw provider JSONL line; log rows hold plain text. Everything else
 * contributes nothing (structured/loop events are boundaries, not output). */
function eventText(event: EventRow): string {
  if (event.event_type === 'log') return event.payload
  if (event.event_type !== 'assistant') return ''
  try {
    const frame = JSON.parse(event.payload) as {
      message?: { content?: Array<{ type?: string; text?: string }> }
    }
    const blocks = frame.message?.content
    if (!Array.isArray(blocks)) return ''
    return blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n')
  } catch {
    return ''
  }
}

/**
 * Text of the LAST `verify` step in the run (loop_step nodeId === 'verify'
 * through its loop_step_end / next step / stream end). Runs without a verify
 * step boundary (non-loop jobs, legacy runs) fall back to the whole stream's
 * text — still raw output, just unscoped.
 */
export function extractVerifyStepText(events: readonly EventRow[]): { text: string; scoped: boolean } {
  let start = -1
  let end = events.length
  let stepIndex: number | null = null
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event.event_type === 'loop_step') {
      const step = parseLoopStepPayload(event.payload)
      if (step?.nodeId === 'verify') {
        start = i
        stepIndex = step.index
        end = events.length
      } else if (start >= 0 && i > start) {
        // A later non-verify step closes the previous verify range unless a
        // later verify step reopens it (loop iterations: last verify wins).
        if (end === events.length) end = i
      }
    } else if (
      start >= 0 && end === events.length && event.event_type === 'loop_step_end' &&
      stepIndex !== null && parseLoopStepPayload(event.payload)?.index === stepIndex
    ) {
      end = i
    }
  }
  const range = start >= 0 ? events.slice(start, end) : events
  const text = range.map(eventText).filter(Boolean).join('\n')
  return { text, scoped: start >= 0 }
}

function toNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw
    else if (raw && typeof raw === 'object' && typeof (raw as { score?: unknown }).score === 'number') {
      out[key] = (raw as { score: number }).score
    }
  }
  return out
}

/** Tolerant parse of a confidence-score.json payload. Returns null only when
 * the payload is not a JSON object at all. */
export function parseConfidenceScore(rawJson: string, changeName: string | null): DeliveryConfidenceScore | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  return {
    changeName,
    overall: typeof obj.overall === 'number' && Number.isFinite(obj.overall) ? obj.overall : null,
    aspects: toNumberRecord(obj.aspects ?? obj.scores),
    flags: Array.isArray(obj.flags) ? obj.flags.filter((f): f is string => typeof f === 'string').slice(0, 20) : [],
    raw: rawJson.length > CONFIDENCE_RAW_CAP ? null : parsed,
  }
}

/** Newest confidence-score.json under `<worktree>/openspec/changes/<name>/`.
 * A worktree hosts at most a handful of change dirs; when several carry a
 * score (unusual), the lexicographically last dir wins deterministically. */
function readConfidenceFromWorktree(
  worktreePath: string,
  io: Required<Pick<EvidenceHarvestIO, 'readFile' | 'listDir' | 'fileExists'>>,
): DeliveryConfidenceScore | null {
  const changesDir = path.join(worktreePath, 'openspec', 'changes')
  let dirs: string[]
  try {
    dirs = io.listDir(changesDir)
  } catch {
    return null
  }
  let found: DeliveryConfidenceScore | null = null
  for (const dir of [...dirs].sort()) {
    const scorePath = path.join(changesDir, dir, 'confidence-score.json')
    try {
      if (!io.fileExists(scorePath)) continue
      const raw = io.readFile(scorePath)
      const parsed = parseConfidenceScore(raw, dir)
      if (parsed) found = parsed
    } catch {
      /* unreadable file = absent, not fatal */
    }
  }
  return found
}

/**
 * Harvest evidence for every unit of a settling delivery. Never throws; the
 * per-unit try/catch turns internal errors into `partial`/`failed` harvest
 * status while absence of a source stays `ok` (absence is honest data).
 */
export function harvestDeliveryEvidence(
  io: EvidenceHarvestIO,
  units: readonly EvidenceHarvestUnit[],
): DeliverySettleEvidence {
  const readFile = io.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'))
  const listDir = io.listDir ?? ((p: string) => fs.readdirSync(p))
  const fileExists = io.fileExists ?? ((p: string) => fs.existsSync(p))
  const fsIo = { readFile, listDir, fileExists }
  let errored = 0
  const harvested: DeliveryUnitEvidence[] = units.map((unit) => {
    const evidence: DeliveryUnitEvidence = {
      ticketId: unit.ticketId,
      runId: unit.runId,
      sentinel: 'absent',
      sentinelDetail: null,
      verifyTail: null,
      confidence: null,
    }
    let unitErrored = false
    try {
      if (unit.runId) {
        const events = io.readEvents(unit.runId)
        const { text } = extractVerifyStepText(events)
        if (text) {
          const sentinel = parseVerificationSentinel(text)
          evidence.sentinel = sentinel.verdict
          evidence.sentinelDetail = sentinel.detail
          evidence.verifyTail = text.slice(-VERIFY_TAIL_CAP)
        }
      }
    } catch {
      unitErrored = true
    }
    try {
      if (unit.worktreePath) {
        evidence.confidence = readConfidenceFromWorktree(unit.worktreePath, fsIo)
      }
    } catch {
      unitErrored = true
    }
    if (unitErrored) errored++
    return evidence
  })
  return {
    schemaVersion: 1,
    harvest: units.length > 0 && errored === units.length ? 'failed' : errored > 0 ? 'partial' : 'ok',
    harvestedAt: (io.now?.() ?? new Date()).toISOString(),
    units: harvested,
  }
}

/** Parse a persisted settle_evidence column value (null-tolerant). */
export function readSettleEvidence(raw: string | null | undefined): DeliverySettleEvidence | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as DeliverySettleEvidence
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.units)) return null
    return parsed
  } catch {
    return null
  }
}
