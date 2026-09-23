/**
 * Deterministic settle-time evidence harvest for the review packet
 * (nontech-review-experience Wave 1). Reads three sources with zero model
 * calls: the `VERIFICATION: PASS/FAIL` sentinel from the run's persisted
 * stream (the rail-merge-orchestrator regex precedent), a bounded tail of the
 * verify step's output, and the reviewer's `confidence-score.json` written
 * into either the worktree's `openspec/changes/<name>/` or the Codex reviewer
 * agent-memory path. Harvest NEVER throws and never blocks settle: every missing or
 * malformed source degrades to an absent value on the evidence record, so the
 * packet can always state honestly what it does and does not know.
 */
import fs from 'fs'
import path from 'path'
import type { EventRow } from '../../../types'
import { FACTORY_REVISION_LOOP_ID } from '../../loops/runtime/loop-factory'
import { parseVerificationSentinel, type SentinelVerdict } from '../../execution/runtime/verification-sentinel'
export { parseVerificationSentinel, type SentinelVerdict } from '../../execution/runtime/verification-sentinel'

/** Bounded tail of the verify step's raw output persisted per unit. */
export const VERIFY_TAIL_CAP = 4096
/** Raw confidence-score.json payloads are capped before persistence. */
export const CONFIDENCE_RAW_CAP = 8192

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

/** A verification command the RUNTIME HOST executed (core-host, programmatic
 *  agent runtime): exit code + bounded output, recorded by the host itself — a
 *  measurement, not the agent's claim. */
export interface DeliveryRuntimeCommand {
  label: string
  outcome: string
  exitCode: number | null
  durationMs: number | null
  required: boolean
  /** True when the host ran it (origin contains 'host'). */
  hostRun: boolean
  /** Bounded stdout/stderr tail (raw). */
  outputTail: string | null
}

/** One acceptance check the runtime recorded (host-run or reviewer static). */
export interface DeliveryRuntimeCheck {
  name: string
  status: string
  required: boolean
  hostRun: boolean
  evidence: string[]
  scope: string | null
  limitations: string | null
}

export interface DeliveryRuntimeReview {
  approved: boolean | null
  score: number | null
  aspects: Record<string, number>
  issues: string[]
  summary: string | null
}

/** Evidence read from the programmatic runtime's pipeline dir
 *  (`<workspace>/.specrails/pipeline/<runId>/`). Absent for legacy loops. */
export interface DeliveryRuntimeEvidence {
  commands: DeliveryRuntimeCommand[]
  checks: DeliveryRuntimeCheck[]
  findings: string[]
  review: DeliveryRuntimeReview | null
}

export interface DeliveryUnitEvidence {
  ticketId: number
  runId: string | null
  /** Programmatic-runtime evidence (null/absent when the run used a legacy loop). */
  runtime?: DeliveryRuntimeEvidence | null
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
  /** The loop this unit ran. `factory:revision` opts into the strict freshness
   *  gate below; everything else keeps the legacy last-writer-wins read. */
  loopId?: string | null
  /** The programmatic runtime's pipeline dir for this run
   *  (`<workspace>/.specrails/pipeline/<runId>`), when the caller knows it. */
  runtimeDir?: string | null
}

export interface EvidenceHarvestIO {
  /** Persisted run stream (events table rows, seq ASC). */
  readEvents: (runId: string) => EventRow[]
  /** Injectable fs seams for tests. */
  readFile?: (filePath: string) => string
  listDir?: (dirPath: string) => string[]
  fileExists?: (filePath: string) => boolean
  /** Modification time in ms — the freshness seam for revision evidence. */
  fileMtimeMs?: (filePath: string) => number
  now?: () => Date
}

interface ParsedStep {
  index: number | null
  nodeId: string | null
  /** Present only on payloads written after the ms-precision boundary landed. */
  startedAtMs: number | null
}

function parseLoopStepPayload(payload: string): ParsedStep | null {
  try {
    const parsed = JSON.parse(payload) as { index?: unknown; nodeId?: unknown; startedAtMs?: unknown }
    return {
      index: typeof parsed.index === 'number' ? parsed.index : null,
      nodeId: typeof parsed.nodeId === 'string' ? parsed.nodeId : null,
      startedAtMs:
        typeof parsed.startedAtMs === 'number' && Number.isFinite(parsed.startedAtMs)
          ? parsed.startedAtMs
          : null,
    }
  } catch {
    return null
  }
}

/** Extract human-readable text from one persisted event row. Assistant rows
 * hold the raw provider JSONL line; log rows hold plain text. Everything else
 * contributes nothing (structured/loop events are boundaries, not output). */
function eventText(event: EventRow): string {
  if (event.event_type === 'log') {
    // LoopRunManager persists the visible transcript as { line }, including
    // Codex/Gemini output. Decode it before matching line-based verdicts and
    // collecting the review excerpt; legacy plain-text rows still work.
    try {
      const value = JSON.parse(event.payload) as { line?: unknown } | null
      if (value && typeof value.line === 'string') return value.line
    } catch { /* legacy plain-text log */ }
    return event.payload
  }
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
export function extractVerifyStepText(
  events: readonly EventRow[],
): { text: string; scoped: boolean; startedAtMs: number | null; status: 'ok' | 'failed' | null } {
  let start = -1
  let end = events.length
  let stepIndex: number | null = null
  let startedAtMs: number | null = null
  let status: 'ok' | 'failed' | null = null
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event.event_type === 'loop_step') {
      const step = parseLoopStepPayload(event.payload)
      if (step?.nodeId === 'verify') {
        start = i
        stepIndex = step.index
        end = events.length
        // Legacy DB timestamps are second-precision SQLite text with no timezone.
        // They cannot prove artifact ordering within that second, so freshness
        // deliberately requires the high-resolution boundary in the payload.
        startedAtMs = step.startedAtMs
        status = null
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
      try {
        const payload = JSON.parse(event.payload) as { status?: unknown }
        if (payload.status === 'ok' || payload.status === 'failed') status = payload.status
      } catch { /* missing/malformed completion is not successful evidence */ }
    }
  }
  const range = start >= 0 ? events.slice(start, end) : events
  const text = range.map(eventText).filter(Boolean).join('\n')
  return { text, scoped: start >= 0, startedAtMs, status }
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
  // The DOCUMENTED schema says `overall`/`flags`; the reviewer Codex actually
  // installs writes `overall_score`/`issues[].note`. Accept both additively
  // rather than pick a winner — an unread score reads as "no reviewer score",
  // which is the one thing the packet must never say when one exists.
  const overall = [obj.overall, obj.overall_score].find(
    (candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate),
  )
  const explicitFlags = Array.isArray(obj.flags)
    ? obj.flags.filter((flag): flag is string => typeof flag === 'string')
    : []
  const issueFlags = Array.isArray(obj.issues)
    ? obj.issues.flatMap((issue) => {
        if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return []
        const note = (issue as { note?: unknown }).note
        return typeof note === 'string' && note.trim() ? [note.trim().slice(0, 512)] : []
      })
    : []
  return {
    changeName,
    overall: typeof overall === 'number' ? overall : null,
    aspects: toNumberRecord(obj.aspects ?? obj.scores),
    flags: [...new Set([...explicitFlags, ...issueFlags])].slice(0, 20),
    raw: rawJson.length > CONFIDENCE_RAW_CAP ? null : parsed,
  }
}

interface ScoreCandidate {
  filePath: string
  changeName: string | null
}

type EvidenceFsIO = Required<Pick<EvidenceHarvestIO, 'readFile' | 'listDir' | 'fileExists' | 'fileMtimeMs'>>

function listOpenSpecScoreCandidates(worktreePath: string, io: EvidenceFsIO): ScoreCandidate[] {
  const changesDir = path.join(worktreePath, 'openspec', 'changes')
  let dirs: string[]
  try {
    dirs = io.listDir(changesDir)
  } catch {
    return []
  }
  return [...dirs].sort().map((dir) => ({
    filePath: path.join(changesDir, dir, 'confidence-score.json'),
    changeName: dir,
  }))
}

/** The reviewer's OTHER landing site. The filename contract is exact on purpose:
 *  a looser match would let another ticket's review — or an unrelated memory
 *  file — be presented as this delivery's score. */
function listAgentMemoryScoreCandidates(
  worktreePath: string,
  ticketId: number,
  io: EvidenceFsIO,
): ScoreCandidate[] {
  const explanationsDir = path.join(worktreePath, '.specrails', 'agent-memory', 'explanations')
  let files: string[]
  try {
    files = io.listDir(explanationsDir)
  } catch {
    return []
  }
  const exactName = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-reviewer-ticket-${ticketId}\\.confidence-score\\.json$`)
  return files
    .filter((file) => exactName.test(file))
    .sort()
    .map((file) => ({ filePath: path.join(explanationsDir, file), changeName: null }))
}

function readCandidate(candidate: ScoreCandidate, io: EvidenceFsIO): DeliveryConfidenceScore | null {
  try {
    if (!io.fileExists(candidate.filePath)) return null
    return parseConfidenceScore(io.readFile(candidate.filePath), candidate.changeName)
  } catch {
    return null
  }
}

/** Newest confidence-score.json under `<worktree>/openspec/changes/<name>/`.
 * A worktree hosts at most a handful of change dirs; when several carry a
 * score (unusual), the lexicographically last dir wins deterministically.
 *
 * `revision` switches on the strict gate: a Revision's reviewer evidence is
 * accepted ONLY when the artifact was written during the LATEST read-only verify
 * epoch. Without it, a fix followed by a reviewer that failed to write anything
 * would silently re-present the previous candidate's clean score as this one's. */
function readConfidenceFromWorktree(
  worktreePath: string,
  io: EvidenceFsIO,
  revision?: { ticketId: number; verifyStartedAtMs: number | null },
): DeliveryConfidenceScore | null {
  const openSpecCandidates = listOpenSpecScoreCandidates(worktreePath, io)
  if (!revision) {
    let found: DeliveryConfidenceScore | null = null
    for (const candidate of openSpecCandidates) {
      const parsed = readCandidate(candidate, io)
      if (parsed) found = parsed
    }
    return found
  }
  // Fail closed: no high-resolution boundary ⇒ freshness is unprovable ⇒ no score.
  if (revision.verifyStartedAtMs === null) return null
  const candidates = [
    ...openSpecCandidates,
    ...listAgentMemoryScoreCandidates(worktreePath, revision.ticketId, io),
  ]
  let found: { score: DeliveryConfidenceScore; mtimeMs: number; filePath: string } | null = null
  for (const candidate of candidates) {
    try {
      if (!io.fileExists(candidate.filePath)) continue
      const mtimeMs = io.fileMtimeMs(candidate.filePath)
      if (!Number.isFinite(mtimeMs) || mtimeMs < revision.verifyStartedAtMs) continue
      const score = parseConfidenceScore(io.readFile(candidate.filePath), candidate.changeName)
      if (!score) continue
      if (
        found === null ||
        mtimeMs > found.mtimeMs ||
        (mtimeMs === found.mtimeMs && candidate.filePath > found.filePath)
      ) {
        found = { score, mtimeMs, filePath: candidate.filePath }
      }
    } catch {
      /* unreadable freshness/content = unavailable, never stale */
    }
  }
  return found?.score ?? null
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
  const fileMtimeMs = io.fileMtimeMs ?? ((p: string) => fs.statSync(p).mtimeMs)
  const fsIo: EvidenceFsIO = { readFile, listDir, fileExists, fileMtimeMs }
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
    let verifyStartedAtMs: number | null = null
    try {
      if (unit.runId) {
        const events = io.readEvents(unit.runId)
        const { text, startedAtMs, scoped, status } = extractVerifyStepText(events)
        verifyStartedAtMs = startedAtMs
        if (text) {
          const sentinel = parseVerificationSentinel(text)
          // A PASS printed before a crash/cancel is not a completed
          // verification. Keep its raw excerpt but never advertise it as green.
          evidence.sentinel = sentinel.verdict === 'pass' && scoped && status !== 'ok'
            ? 'absent'
            : sentinel.verdict
          evidence.sentinelDetail = sentinel.detail
          evidence.verifyTail = text.slice(-VERIFY_TAIL_CAP)
        }
      }
    } catch {
      unitErrored = true
    }
    try {
      if (unit.worktreePath) {
        evidence.confidence = readConfidenceFromWorktree(
          unit.worktreePath,
          fsIo,
          unit.loopId === FACTORY_REVISION_LOOP_ID
            ? { ticketId: unit.ticketId, verifyStartedAtMs }
            : undefined,
        )
      }
    } catch {
      unitErrored = true
    }
    try {
      if (unit.runtimeDir && unit.runId) {
        const runtime = readRuntimeEvidence(unit.runtimeDir, unit.runId, fsIo)
        if (runtime) {
          evidence.runtime = runtime
          // The runtime reviewer's structured verdict IS the reviewer score for
          // this run (core-host never writes confidence-score.json). Only fill
          // the gap — a file-based score, when present, stays authoritative.
          if (!evidence.confidence && runtime.review && runtime.review.score !== null) {
            evidence.confidence = {
              changeName: null,
              overall: runtime.review.score,
              aspects: runtime.review.aspects,
              flags: runtime.review.issues,
              raw: null,
            }
          }
        }
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

const RUNTIME_OUTPUT_TAIL_CAP = 1500
const RUNTIME_LIST_CAP = 12
const RUNTIME_TEXT_CAP = 600

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
function str(v: unknown, cap = RUNTIME_TEXT_CAP): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, cap) : null
}
function strList(v: unknown, cap = RUNTIME_LIST_CAP): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, cap).map((x) => x.trim().slice(0, RUNTIME_TEXT_CAP)) : []
}
function readJson(fsIo: EvidenceFsIO, filePath: string): unknown {
  if (!fsIo.fileExists(filePath)) return null
  try { return JSON.parse(fsIo.readFile(filePath)) } catch { return null }
}

/**
 * Read the programmatic runtime's durable evidence for one run:
 *  - `state.json` `verification.commands[]` (+ each command's evidence file
 *    under `verification/evidence/<id>.json` for exit code / duration / output)
 *  - `state.json` `acceptance.checks[]` / `acceptance.findings[]`
 *  - `agent-workflow/<runId>/checkpoint.json` `state.steps.reviewer.output`
 *    (`approved`, `score`, `aspects`, `issues`, `summary`)
 * Returns null when the dir carries no state.json (legacy loop run). Every
 * field is bounded; a malformed file degrades to an empty list, never a throw.
 */
export function readRuntimeEvidence(runtimeDir: string, runId: string, fsIo: EvidenceFsIO): DeliveryRuntimeEvidence | null {
  const state = readJson(fsIo, path.join(runtimeDir, 'state.json'))
  if (!isRecord(state)) return null
  const commands: DeliveryRuntimeCommand[] = []
  const verification = isRecord(state.verification) ? state.verification : null
  for (const raw of (Array.isArray(verification?.commands) ? verification.commands : []).slice(0, RUNTIME_LIST_CAP)) {
    if (!isRecord(raw)) continue
    const evidenceId = typeof raw.evidenceId === 'string' && /^[a-f0-9]{16,128}$/i.test(raw.evidenceId) ? raw.evidenceId : null
    const doc = evidenceId ? readJson(fsIo, path.join(runtimeDir, 'verification', 'evidence', `${evidenceId}.json`)) : null
    const document = isRecord(doc) && isRecord(doc.document) ? doc.document : null
    const stdout = str(document?.stdout, RUNTIME_OUTPUT_TAIL_CAP * 4) ?? ''
    const stderr = str(document?.stderr, RUNTIME_OUTPUT_TAIL_CAP * 4) ?? ''
    const combined = [stdout, stderr].filter(Boolean).join('\n').trim()
    const origin = strList(document?.origin)
    commands.push({
      label: str(raw.label, 200) ?? [str(raw.command, 80), ...strList(raw.args, 8)].filter(Boolean).join(' ') ?? 'command',
      outcome: str(raw.outcome, 40) ?? str(document?.status, 40) ?? 'unknown',
      exitCode: typeof document?.exitCode === 'number' && Number.isInteger(document.exitCode) ? document.exitCode : null,
      durationMs: typeof document?.durationMs === 'number' && Number.isFinite(document.durationMs) ? document.durationMs : null,
      required: document?.required !== false,
      hostRun: origin.includes('host'),
      outputTail: combined ? combined.slice(-RUNTIME_OUTPUT_TAIL_CAP) : null,
    })
  }
  const acceptance = isRecord(state.acceptance) ? state.acceptance : null
  const checks: DeliveryRuntimeCheck[] = []
  for (const raw of (Array.isArray(acceptance?.checks) ? acceptance.checks : []).slice(0, RUNTIME_LIST_CAP)) {
    if (!isRecord(raw)) continue
    const name = str(raw.name, 200)
    if (!name) continue
    const evidence = strList(raw.evidence, 6)
    // A check backed by a verification receipt was executed by the host; the
    // rest are the reviewer's static assertions and stay AI-reported.
    const hostRun = evidence.some((line) => /verification receipt/i.test(line))
    checks.push({ name, status: str(raw.status, 40) ?? 'unknown', required: raw.required === true, hostRun, evidence, scope: str(raw.scope), limitations: str(raw.limitations) })
  }
  const findings = strList(acceptance?.findings, 6)
  let review: DeliveryRuntimeReview | null = null
  const checkpoint = readJson(fsIo, path.join(runtimeDir, 'agent-workflow', runId, 'checkpoint.json'))
  const steps = isRecord(checkpoint) && isRecord(checkpoint.state) && isRecord(checkpoint.state.steps) ? checkpoint.state.steps : null
  const reviewer = steps && isRecord(steps.reviewer) ? steps.reviewer : null
  const output = reviewer && isRecord(reviewer.output) ? reviewer.output : null
  if (output && ('score' in output || 'approved' in output)) {
    const aspects: Record<string, number> = {}
    if (isRecord(output.aspects)) {
      for (const [k, v] of Object.entries(output.aspects).slice(0, RUNTIME_LIST_CAP)) if (typeof v === 'number' && Number.isFinite(v)) aspects[k] = v
    }
    const issues = Array.isArray(output.issues)
      ? output.issues.slice(0, 6).map((i) => (typeof i === 'string' ? i : isRecord(i) ? (str(i.message) ?? str(i.title) ?? str(i.description) ?? JSON.stringify(i).slice(0, RUNTIME_TEXT_CAP)) : null)).filter((x): x is string => !!x)
      : []
    review = {
      approved: typeof output.approved === 'boolean' ? output.approved : null,
      score: typeof output.score === 'number' && Number.isFinite(output.score) ? output.score : null,
      aspects,
      issues,
      summary: str(output.summary, 1200),
    }
  }
  if (commands.length === 0 && checks.length === 0 && findings.length === 0 && !review) return null
  return { commands, checks, findings, review }
}

/**
 * Heal a persisted settle evidence whose units predate the runtime harvest:
 * for every unit with a run id but no `runtime` field, read the pipeline dir
 * now. Returns the healed evidence when anything was added, else null (so the
 * caller neither rewrites the row nor re-broadcasts). Pure apart from `fsIo`.
 */
export function healRuntimeEvidence(
  evidence: DeliverySettleEvidence,
  pipelineDir: string,
  fsIo: Partial<EvidenceFsIO> = {},
): DeliverySettleEvidence | null {
  const io: EvidenceFsIO = {
    readFile: fsIo.readFile ?? ((p) => fs.readFileSync(p, 'utf8')),
    listDir: fsIo.listDir ?? ((p) => fs.readdirSync(p)),
    fileExists: fsIo.fileExists ?? ((p) => fs.existsSync(p)),
    fileMtimeMs: fsIo.fileMtimeMs ?? ((p) => fs.statSync(p).mtimeMs),
  }
  let changed = false
  const units = evidence.units.map((unit) => {
    if (unit.runtime !== undefined || !unit.runId) return unit
    let runtime: DeliveryRuntimeEvidence | null = null
    try { runtime = readRuntimeEvidence(path.join(pipelineDir, unit.runId), unit.runId, io) } catch { runtime = null }
    if (!runtime) return unit
    changed = true
    const confidence = unit.confidence ?? (runtime.review && runtime.review.score !== null
      ? { changeName: null, overall: runtime.review.score, aspects: runtime.review.aspects, flags: runtime.review.issues, raw: null }
      : null)
    return { ...unit, runtime, confidence }
  })
  return changed ? { ...evidence, units } : null
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
