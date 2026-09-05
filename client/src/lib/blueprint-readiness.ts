import type { TFunction } from 'i18next'
import { deriveDimensions, type Blueprint } from './blueprint-draft'
import type { BuilderSpecQualityIssue, BuilderSpecQualityReport } from './blueprint-spec-quality'

// Readiness model for the Builder's commit CTA (harden-project-builder-snapshots).
// The old surface reduced ~25 possible gate failures to ONE raw English
// sentence ("Generation is not complete yet."). This turns the same
// deterministic report into three human steps — blueprint · specs · audit —
// plus localized, spec-precise issue lines, so the user always knows what is
// missing and who has to act (the Builder, automatically, or themselves).

/** `writing` = the app-driven batched generation is filling the specs right
 *  now (premium-milestone-progress D7): the audit waits for the batch. */
export type ReadinessStepState = 'done' | 'pending' | 'blocked' | 'writing'

export interface ReadinessStep {
  key: 'blueprint' | 'specs' | 'audit'
  state: ReadinessStepState
  /** Structured values for the localized detail line. */
  params: Record<string, string | number>
}

export interface ReadinessReport {
  ready: boolean
  steps: ReadinessStep[]
  /** Audit issues excluding the two batch-level gates (surfaced per step). */
  issues: BuilderSpecQualityIssue[]
}

export interface ReadinessBounds {
  minSpecs: number
  maxSpecs: number
}

const BATCH_LEVEL_CODES = new Set(['batch_incomplete', 'spec_count'])

export interface ReadinessOptions {
  /** The batched generation drive is in flight (snapshot status `generating`). */
  generating?: boolean
}

export function deriveReadiness(
  blueprint: Blueprint | null,
  rawBlueprint: unknown,
  quality: BuilderSpecQualityReport,
  bounds: ReadinessBounds,
  options: ReadinessOptions = {},
): ReadinessReport {
  const dims = deriveDimensions(blueprint)
  const filled = Object.values(dims).filter(Boolean).length
  const total = Object.keys(dims).length
  const raw = rawBlueprint && typeof rawBlueprint === 'object' && !Array.isArray(rawBlueprint)
    ? rawBlueprint as Record<string, unknown>
    : null
  const specCount = Array.isArray(raw?.m1Specs) ? raw.m1Specs.length : blueprint?.m1Specs.length ?? 0
  // Specs that already carry a body (the batched generation writes them in
  // ranges; a halted drive leaves the tail as title-only outline entries).
  const specList = Array.isArray(raw?.m1Specs) ? raw.m1Specs : blueprint?.m1Specs ?? []
  const writtenIndexes = new Set<number>()
  specList.forEach((spec, index) => {
    const item = spec && typeof spec === 'object' ? spec as Record<string, unknown> : null
    const description = typeof item?.description === 'string' ? item.description.trim() : ''
    const criteria = Array.isArray(item?.acceptanceCriteria) ? item.acceptanceCriteria : []
    if (description.length > 0 || criteria.length > 0) writtenIndexes.add(index)
  })
  const written = writtenIndexes.size
  const claimsComplete = raw ? raw.specsComplete === true : blueprint?.specsComplete === true
  const writing = options.generating === true && specCount > 0
  // Outline / partly written batch (a halted drive): the unwritten specs are
  // not "audit failures", they are simply not written yet.
  const partial = !writing && specCount > 0 && written < specCount && !claimsComplete
  const issues = writing
    ? []
    : quality.issues.filter((issue) => !BATCH_LEVEL_CODES.has(issue.code)
        && (!partial || issue.specIndex === null || writtenIndexes.has(issue.specIndex)))

  const blueprintStep: ReadinessStep = {
    key: 'blueprint',
    state: filled === total ? 'done' : 'pending',
    params: { filled, total },
  }
  let specsState: ReadinessStepState
  if (writing) specsState = 'writing'
  else if (specCount === 0) specsState = 'pending'
  else if (specCount < bounds.minSpecs || specCount > bounds.maxSpecs) specsState = 'blocked'
  else specsState = claimsComplete ? 'done' : 'pending'
  const specsStep: ReadinessStep = {
    key: 'specs',
    state: specsState,
    params: { count: specCount, written, min: bounds.minSpecs, max: bounds.maxSpecs },
  }
  const auditStep: ReadinessStep = {
    key: 'audit',
    state: writing
      ? 'writing'
      : specCount === 0 || (partial && issues.length === 0)
        ? 'pending'
        : issues.length === 0 ? 'done' : 'blocked',
    params: { count: issues.length },
  }
  return { ready: quality.valid, steps: [blueprintStep, specsStep, auditStep], issues }
}

/** i18n key (in the `builder` namespace, `quality.*`) for one audit issue. */
export function qualityIssueKey(issue: Pick<BuilderSpecQualityIssue, 'field' | 'code'>): string {
  if (issue.field === 'shortSummary') return 'quality.summary'
  if (issue.field === 'title' && issue.code === 'required') return 'quality.title_required'
  if (issue.field === 'title' && issue.code === 'duplicate') return 'quality.title_duplicate'
  return `quality.${issue.code}`
}

/** Localize one audit issue; unknown codes fall back to the English message. */
export function localizeQualityIssue(t: TFunction, issue: BuilderSpecQualityIssue): string {
  const params = {
    n: issue.specIndex !== null ? issue.specIndex + 1 : '',
    ...(issue.params ?? {}),
  }
  return t(qualityIssueKey(issue), { ...params, defaultValue: issue.message })
}
