/**
 * The reviewer's outcome for one run, for the operator's diagnosis tools
 * (`specrails_jobs runtime_diagnose` / `runtime_evidence`): approved, score,
 * bounded issues, the summary's first lines, failing host checks and — for
 * Flow → Spec — the derivation coverage. Read through the SAME evidence path
 * as settlement: the delivery's stored settle evidence first, else the
 * retained run read-only (`healRuntimeEvidence` over the definition probe for
 * engine 2, the pipeline dir for engine 1). Never throws.
 */
import fs from 'node:fs'
import type { DbInstance } from '../../../db'
import type { DefinitionRunProbe } from '../../loops/runtime/loop-definition-recovery'
import { getLoopRun, readDefinitionRun } from '../../loops/runtime/loop-runs-store'
import { healRuntimeEvidence, readDerivationFile, readSettleEvidence, type DeliveryRuntimeEvidence, type DeliverySettleEvidence, type DeliveryUnitEvidence } from './delivery-evidence'
import { FLOW_SPEC_DELIVERY_LOOP_ID, flowReviewOutcome } from './flow-review-outcome'

const ISSUES_CAP = 10
const ISSUE_TEXT_CAP = 400
const SUMMARY_LINES = 5
const SUMMARY_CAP = 800
const UNEXPLAINED_CAP = 20

export interface RunReviewDiagnosis {
  /** Where the verdict was read: the delivery's settle evidence or the retained run. */
  source: 'settle-evidence' | 'retained-run'
  /** The latest reviewer verdict; null when no review attempt recorded one. */
  review: {
    approved: boolean | null
    score: number | null
    issues: string[]
    issuesOmitted: number
    summary: string | null
    /** More than one scoped reviewer verdict (branches): no single aggregate. */
    scopedReviewCount: number
  } | null
  failingChecks: Array<{ command: string; exitCode: number | null }>
  /** Flow → Spec only: how much of the change the derived spec explains. */
  derivation: { change: string | null; files: number; explained: number; unexplainedFiles: string[]; unexplainedOmitted: number; confidence: string | null } | null
  /** Flow → Spec only: what still blocks the delivery (the card's "the reviewer requested changes"). */
  flowOutcome: 'review' | 'check' | null
}

export interface RunReviewDiagnosisDeps {
  db: DbInstance
  runId: string
  /** `<specrailsDir>/pipeline`. */
  pipelineDir: string
  /** Full retained status for engine 2 (`probeDefinitionRuns(..., true)`). */
  probe: (runIds: string[]) => Promise<ReadonlyMap<string, DefinitionRunProbe>>
}

const clip = (text: string, cap: number): string => (text.length <= cap ? text : `${text.slice(0, cap).trimEnd()}…`)

function storedUnit(db: DbInstance, runId: string): { unit: DeliveryUnitEvidence; loopId: string | null; implementationOutcome: string | null; evidence: DeliverySettleEvidence } | null {
  const rows = db.prepare(`SELECT loop_id, implementation_outcome, settle_evidence FROM rail_pr_deliveries
    WHERE settle_evidence IS NOT NULL AND run_ids LIKE ? ORDER BY created_at DESC LIMIT 5`).all(`%${JSON.stringify(runId)}%`) as Array<{ loop_id: string | null; implementation_outcome: string | null; settle_evidence: string }>
  for (const row of rows) {
    const evidence = readSettleEvidence(row.settle_evidence)
    const unit = evidence?.units.find((candidate) => candidate.runId === runId)
    if (evidence && unit) return { unit, loopId: row.loop_id, implementationOutcome: row.implementation_outcome, evidence }
  }
  return null
}

function loopOf(db: DbInstance, runId: string): { loopId: string | null; engineVersion: number | null; reviewerStepId?: string } {
  const row = getLoopRun(db, runId)
  let reviewerStepId: string | undefined
  try { reviewerStepId = readDefinitionRun(db, runId)?.request.graph.config.reviewerStepId } catch { reviewerStepId = undefined }
  return { loopId: row?.loop_id ?? null, engineVersion: row?.engine_version ?? null, ...(reviewerStepId ? { reviewerStepId } : {}) }
}

function project(runtime: DeliveryRuntimeEvidence, source: RunReviewDiagnosis['source'], loopId: string | null, implementationOutcome: string | null, unit: DeliveryUnitEvidence): RunReviewDiagnosis {
  const review = runtime.review
  const scopedReviewCount = runtime.scopedReviews?.length ?? (review ? 1 : 0)
  // Several branch verdicts: report the latest one recorded, flagged as such.
  const latest = review ?? runtime.scopedReviews?.[runtime.scopedReviews.length - 1]?.review ?? null
  const issues = latest?.issues.filter((issue) => issue.trim()) ?? []
  const derivation = runtime.derivation ?? (runtime.derivationPath ? readDerivationFile(runtime.derivationPath, { fileExists: fs.existsSync, readFile: (file) => fs.readFileSync(file, 'utf8') }) : null)
  const flowSpec = loopId === FLOW_SPEC_DELIVERY_LOOP_ID
  const flow = flowSpec ? flowReviewOutcome({ loopId, implementationOutcome: implementationOutcome ?? 'failed', evidence: { schemaVersion: 1, harvest: 'ok', harvestedAt: '', units: [{ ...unit, runtime }] } }) : null
  return {
    source,
    review: latest ? {
      approved: latest.approved,
      score: latest.score,
      issues: issues.slice(0, ISSUES_CAP).map((issue) => clip(issue.trim(), ISSUE_TEXT_CAP)),
      issuesOmitted: Math.max(0, issues.length - ISSUES_CAP),
      summary: latest.summary ? clip(latest.summary.split(/\r?\n/).filter((line) => line.trim()).slice(0, SUMMARY_LINES).join('\n'), SUMMARY_CAP) : null,
      scopedReviewCount,
    } : null,
    failingChecks: runtime.commands
      .filter((command) => command.outcome === 'failed' || (command.exitCode !== null && command.exitCode !== 0))
      .slice(0, 10)
      .map((command) => ({ command: clip(command.label, 200), exitCode: command.exitCode })),
    derivation: flowSpec && derivation ? {
      change: derivation.change, files: derivation.files, explained: derivation.explained,
      unexplainedFiles: derivation.unexplainedFiles.slice(0, UNEXPLAINED_CAP),
      unexplainedOmitted: derivation.unexplainedOmitted + Math.max(0, derivation.unexplainedFiles.length - UNEXPLAINED_CAP),
      confidence: derivation.confidence,
    } : null,
    flowOutcome: flow?.reason ?? null,
  }
}

/** The reviewer outcome of `runId`; null when no source carries runtime evidence. */
export async function readRunReviewDiagnosis(deps: RunReviewDiagnosisDeps): Promise<RunReviewDiagnosis | null> {
  try {
    const run = loopOf(deps.db, deps.runId)
    const stored = storedUnit(deps.db, deps.runId)
    if (stored?.unit.runtime?.review) return project(stored.unit.runtime, 'settle-evidence', stored.loopId ?? run.loopId, stored.implementationOutcome, stored.unit)
    const unit: DeliveryUnitEvidence = { ticketId: stored?.unit.ticketId ?? 0, runId: deps.runId, sentinel: 'absent', sentinelDetail: null, verifyTail: null, confidence: null,
      ...(stored?.unit.reviewerStepId ?? run.reviewerStepId ? { reviewerStepId: stored?.unit.reviewerStepId ?? run.reviewerStepId } : {}) }
    const statuses = run.engineVersion === 2 ? await deps.probe([deps.runId]) : new Map<string, DefinitionRunProbe>()
    const healed = healRuntimeEvidence({ schemaVersion: 1, harvest: 'ok', harvestedAt: new Date().toISOString(), units: [unit] }, deps.pipelineDir, {}, statuses)
    const runtime = healed?.units[0]?.runtime
    if (runtime) return project(runtime, 'retained-run', stored?.loopId ?? run.loopId, stored?.implementationOutcome ?? null, unit)
    // The retained run is gone: whatever the settle evidence kept is still the best answer.
    if (stored?.unit.runtime) return project(stored.unit.runtime, 'settle-evidence', stored.loopId ?? run.loopId, stored.implementationOutcome, stored.unit)
    return null
  } catch {
    return null
  }
}

