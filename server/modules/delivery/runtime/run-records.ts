/**
 * Core's phase-3 run records (feedback-2026-10), read at settle into the
 * delivery evidence and rendered in the review packet:
 *
 *  - `spec-trace.json` (Core `specTrace: 1`, contract 5.7): which spec
 *    requirements a passing test demonstrates ("Requirements demonstrated X/Y").
 *  - `baseline.json` (Core `baselineOnTouch: 1`, contract 5.7): the
 *    characterization of code no capability described ("Spec created where
 *    the work passed").
 *  - `clarifications.json` (Core `architectClarifications: 1`, contract 5.7):
 *    the architect's questions, or the assumptions it proceeded on.
 *
 * Pure parsing apart from the injected fs seam. Tolerant: an unknown schema,
 * a malformed entry or a missing file never throws, never invents a value and
 * never changes any decision — every record is advisory evidence. Lists are
 * bounded so a large report cannot bloat `settle_evidence`.
 */
import fs from 'fs'
import path from 'path'

export const SPEC_TRACE_FILE = 'spec-trace.json'
export const BASELINE_FILE = 'baseline.json'
export const CLARIFICATIONS_FILE = 'clarifications.json'

const LIST_CAP = 200
const TEST_CAP = 5
const TEXT_CAP = 600
const FILE_CAP = 1024 * 1024

export interface RunRecordFs {
  readFile: (filePath: string) => string
  listDir: (dirPath: string) => string[]
  fileExists: (filePath: string) => boolean
  fileMtimeMs: (filePath: string) => number
}

/** Node fs implementation of the seam. */
export const nodeRunRecordFs: RunRecordFs = {
  readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
  listDir: (dirPath) => fs.readdirSync(dirPath),
  fileExists: (filePath) => fs.existsSync(filePath),
  fileMtimeMs: (filePath) => fs.statSync(filePath).mtimeMs,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown, cap = TEXT_CAP): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, cap) : null
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}
function strings(value: unknown, cap = LIST_CAP): string[] {
  return Array.isArray(value) ? value.flatMap((item) => { const t = text(item); return t ? [t] : [] }).slice(0, cap) : []
}

/**
 * Raw JSON text of a run record. Engine 1 writes it in the run's pipeline dir
 * (`<pipeline>/<runId>/<file>`); an engine 2 implementation piece writes it in
 * its own child dir (`<pipeline>/<runId[0..80]>-impl-<digest>/<file>`), so the
 * newest such sibling is the fallback. Null when absent, oversized or unreadable.
 */
export function readRunRecordText(runtimeDir: string, file: string, fsIo: RunRecordFs): string | null {
  const candidates: string[] = [path.join(runtimeDir, file)]
  try {
    const root = path.dirname(runtimeDir)
    const prefix = `${path.basename(runtimeDir).slice(0, 80)}-impl-`
    const children = fsIo.listDir(root).filter((name) => name.startsWith(prefix)).map((name) => path.join(root, name, file))
      .filter((candidate) => fsIo.fileExists(candidate))
      .sort((a, b) => fsIo.fileMtimeMs(b) - fsIo.fileMtimeMs(a))
    candidates.push(...children)
  } catch { /* no pipeline root: only the direct path */ }
  for (const candidate of candidates) {
    try {
      if (!fsIo.fileExists(candidate)) continue
      const raw = fsIo.readFile(candidate)
      if (raw.length > FILE_CAP) return null
      return raw
    } catch { /* try the next candidate */ }
  }
  return null
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null
  try { return JSON.parse(raw) } catch { return null }
}

// ─── spec-trace.json ─────────────────────────────────────────────────────────

export type UndemonstratedReason = 'no-test' | 'not-executed' | 'failed'
export interface TraceTestRef { file: string; line: number | null }
export interface DeliverySpecTrace {
  /** Where demonstration came from: a verification receipt, a caller's word, or nothing. */
  evidence: 'receipt' | 'tests-passed' | 'none'
  receiptId: string | null
  generatedAt: string | null
  changes: string[]
  /** Total requirements in scope (the Y of "X/Y"). */
  requirements: number
  demonstrated: Array<{ id: string; name: string; tests: TraceTestRef[] }>
  undemonstrated: Array<{ id: string; name: string; reason: UndemonstratedReason; tests: TraceTestRef[] }>
  /** Tags that match no requirement (typo, renamed or removed requirement). */
  untagged: Array<{ tag: string; file: string; line: number | null }>
  /** Requirements the change adds, modifies or renames. */
  touched: string[]
  touchedUndemonstrated: string[]
  /** Entries beyond the stored lists. */
  omitted: number
}

function tests(value: unknown): TraceTestRef[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const file = text(item.file, 512)
    return file ? [{ file, line: Number.isSafeInteger(item.line) ? item.line as number : null }] : []
  }).slice(0, TEST_CAP)
}

/** Parse Core's spec-trace report; null when it is not a schema-1 report. */
export function parseSpecTraceReport(value: unknown): DeliverySpecTrace | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null
  let omitted = 0
  const take = <T>(list: unknown, parse: (item: Record<string, unknown>) => T | null): T[] => {
    if (!Array.isArray(list)) return []
    const out: T[] = []
    for (const item of list) {
      const parsed = isRecord(item) ? parse(item) : null
      if (!parsed) continue
      if (out.length < LIST_CAP) out.push(parsed)
      else omitted++
    }
    return out
  }
  const demonstrated = take(value.demonstrated, (item) => {
    const id = text(item.id, 300)
    return id ? { id, name: text(item.name) ?? id, tests: tests(item.tests) } : null
  })
  const undemonstrated = take(value.undemonstrated, (item) => {
    const id = text(item.id, 300)
    const reason = item.reason === 'no-test' || item.reason === 'not-executed' || item.reason === 'failed' ? item.reason : 'no-test'
    return id ? { id, name: text(item.name) ?? id, reason: reason as UndemonstratedReason, tests: tests(item.tests) } : null
  })
  const untagged = take(value.untagged, (item) => {
    const tag = text(item.tag, 300), file = text(item.file, 512)
    return tag && file ? { tag, file, line: Number.isSafeInteger(item.line) ? item.line as number : null } : null
  })
  const evidence = value.evidence === 'receipt' || value.evidence === 'tests-passed' ? value.evidence : 'none'
  return {
    evidence,
    receiptId: text(value.receiptId, 128),
    generatedAt: text(value.generatedAt, 64),
    changes: strings(value.changes, 20),
    // Never report fewer requirements than the lists carry.
    requirements: Math.max(count(value.requirements), demonstrated.length + undemonstrated.length),
    demonstrated,
    undemonstrated,
    untagged,
    touched: strings(value.touched),
    touchedUndemonstrated: strings(value.touchedUndemonstrated),
    omitted,
  }
}

export function readSpecTrace(runtimeDir: string, fsIo: RunRecordFs): DeliverySpecTrace | null {
  return parseSpecTraceReport(parseJson(readRunRecordText(runtimeDir, SPEC_TRACE_FILE, fsIo)))
}

// ─── baseline.json ───────────────────────────────────────────────────────────

export type BaselineStatus = 'not-needed' | 'planned' | 'passed' | 'failed' | 'violated'
const BASELINE_STATUSES: readonly BaselineStatus[] = ['not-needed', 'planned', 'passed', 'failed', 'violated']

/** Spend of the baseline turns (efficiencySummary.baseline); null = not reported. */
export interface DeliveryBaselineCost { invocations: number; costUsd: number | null; inputTokens: number | null; outputTokens: number | null }

export interface DeliveryBaseline {
  status: BaselineStatus
  change: string | null
  recordedAt: string | null
  /** Blast-radius files no capability covered (the module being described). */
  uncovered: string[]
  covered: number
  /** Characterization test files. */
  tests: string[]
  receiptId: string | null
  /** Core's sentence naming what to fix when the stage blocked. */
  reason: string | null
  /** Capabilities whose as-built spec the change adds, with their requirement counts (from the spec trace). */
  capabilities: Array<{ capability: string; requirements: number; demonstrated: number }>
  cost: DeliveryBaselineCost | null
}

/** Parse Core's baseline record; null when it is not a schema-1 record. */
export function parseBaselineRecord(value: unknown): DeliveryBaseline | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !BASELINE_STATUSES.includes(value.status as BaselineStatus)) return null
  const detection = isRecord(value.detection) ? value.detection : {}
  const testFiles = Array.isArray(value.tests)
    ? value.tests.flatMap((item) => typeof item === 'string' ? [item] : isRecord(item) && typeof item.file === 'string' ? [item.file] : []).map((file) => file.trim().slice(0, 512)).filter(Boolean).slice(0, LIST_CAP)
    : []
  return {
    status: value.status as BaselineStatus,
    change: text(value.change, 128),
    recordedAt: text(value.recordedAt, 64),
    uncovered: strings(detection.uncovered),
    covered: Array.isArray(detection.covered) ? detection.covered.length : 0,
    tests: testFiles,
    receiptId: text(value.receiptId, 128),
    reason: text(value.reason, 2000),
    capabilities: [],
    cost: null,
  }
}

/** Requirement counts per capability of the trace's touched (as-built) requirements. */
export function baselineCapabilities(trace: DeliverySpecTrace | null | undefined): DeliveryBaseline['capabilities'] {
  if (!trace) return []
  const demonstrated = new Set(trace.demonstrated.map((item) => item.id))
  const byCapability = new Map<string, { requirements: number; demonstrated: number }>()
  for (const id of trace.touched) {
    const capability = id.split('/')[0]
    if (!capability) continue
    const entry = byCapability.get(capability) ?? { requirements: 0, demonstrated: 0 }
    entry.requirements++
    if (demonstrated.has(id)) entry.demonstrated++
    byCapability.set(capability, entry)
  }
  return [...byCapability.entries()].map(([capability, entry]) => ({ capability, ...entry }))
}

export function readBaseline(runtimeDir: string, fsIo: RunRecordFs): DeliveryBaseline | null {
  return parseBaselineRecord(parseJson(readRunRecordText(runtimeDir, BASELINE_FILE, fsIo)))
}

/** Core's blocker code when characterization tests fail on the unchanged code. */
export const BASELINE_BLOCKER_CODE = 'baseline_characterization_failed'

// ─── clarifications.json ─────────────────────────────────────────────────────

export type ClarificationImpact = 'high' | 'medium' | 'low'
export interface RunClarification { question: string; impact: ClarificationImpact; default: string | null }
export interface RunClarificationsRecord {
  change: string | null
  policy: string | null
  status: 'awaiting-answers' | 'proceeded'
  recordedAt: string | null
  clarifications: RunClarification[]
  /** Questions the run paused on (awaiting-answers). */
  blocking: RunClarification[]
  /** Assumptions design.md recorded when the run proceeded. */
  assumptions: string[]
}

function clarification(item: unknown): RunClarification | null {
  if (!isRecord(item)) return null
  const question = text(item.question, 2000)
  if (!question || !['high', 'medium', 'low'].includes(item.impact as string)) return null
  return { question, impact: item.impact as ClarificationImpact, default: text(item.default, 2000) }
}

/** Parse Core's clarifications record; null when it is not a schema-1 record. */
export function parseClarificationsRecord(value: unknown): RunClarificationsRecord | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null
  if (value.status !== 'awaiting-answers' && value.status !== 'proceeded') return null
  const list = (input: unknown) => Array.isArray(input) ? input.map(clarification).filter((item): item is RunClarification => item !== null).slice(0, 10) : []
  return {
    change: text(value.change, 128),
    policy: text(value.policy, 40),
    status: value.status,
    recordedAt: text(value.recordedAt, 64),
    clarifications: list(value.clarifications),
    blocking: list(value.blocking),
    assumptions: strings(value.assumptions, 40),
  }
}

export function readClarifications(runtimeDir: string, fsIo: RunRecordFs): RunClarificationsRecord | null {
  return parseClarificationsRecord(parseJson(readRunRecordText(runtimeDir, CLARIFICATIONS_FILE, fsIo)))
}

/** True when the record carries something worth telling the issue's watchers. */
export function hasClarificationContent(record: RunClarificationsRecord): boolean {
  return record.status === 'awaiting-answers' ? record.blocking.length > 0 || record.clarifications.length > 0 : record.assumptions.length > 0 || record.clarifications.length > 0
}

// ─── packet section ──────────────────────────────────────────────────────────

type PerTicket<T> = T & { ticketId: number }

/** "Requirements demonstrated X/Y" across the delivery's units. */
export interface PacketRequirementsDemonstrated {
  demonstrated: number
  total: number
  touched: number
  touchedDemonstrated: number
  demonstratedList: PerTicket<{ id: string; name: string; tests: TraceTestRef[] }>[]
  undemonstratedList: PerTicket<{ id: string; name: string; reason: UndemonstratedReason; touched: boolean }>[]
  untaggedList: PerTicket<{ tag: string; file: string; line: number | null }>[]
  /** At least one unit's trace had no passing receipt behind it. */
  withoutReceipt: boolean
}

export function buildRequirementsDemonstrated(units: ReadonlyArray<{ ticketId: number; specTrace?: DeliverySpecTrace | null }>): PacketRequirementsDemonstrated | null {
  const present = units.filter((unit): unit is { ticketId: number; specTrace: DeliverySpecTrace } => !!unit.specTrace)
  if (present.length === 0) return null
  const out: PacketRequirementsDemonstrated = { demonstrated: 0, total: 0, touched: 0, touchedDemonstrated: 0, demonstratedList: [], undemonstratedList: [], untaggedList: [], withoutReceipt: false }
  for (const { ticketId, specTrace: trace } of present) {
    out.demonstrated += trace.demonstrated.length
    out.total += trace.requirements
    out.touched += trace.touched.length
    out.touchedDemonstrated += trace.touched.length - trace.touchedUndemonstrated.length
    if (trace.evidence !== 'receipt') out.withoutReceipt = true
    const touched = new Set(trace.touched)
    out.demonstratedList.push(...trace.demonstrated.map((item) => ({ ...item, ticketId })))
    out.undemonstratedList.push(...trace.undemonstrated.map((item) => ({ id: item.id, name: item.name, reason: item.reason, touched: touched.has(item.id), ticketId })))
    out.untaggedList.push(...trace.untagged.map((item) => ({ ...item, ticketId })))
  }
  // Touched requirements first: they are what this change is accountable for.
  out.undemonstratedList.sort((a, b) => Number(b.touched) - Number(a.touched))
  return out
}

/** "Spec created where the work passed" across the delivery's units. */
export function buildBaselineSection(units: ReadonlyArray<{ ticketId: number; baseline?: DeliveryBaseline | null }>): PerTicket<DeliveryBaseline>[] | null {
  const list = units.flatMap((unit) => unit.baseline && unit.baseline.status !== 'not-needed' ? [{ ...unit.baseline, ticketId: unit.ticketId }] : [])
  return list.length ? list : null
}
