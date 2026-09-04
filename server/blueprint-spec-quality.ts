import type { BlueprintM1Spec } from './blueprint-types'

export const BUILDER_SPEC_HEADINGS = [
  'Problem Statement',
  'Proposed Solution',
  'Out of Scope',
  'Technical Considerations',
  'Estimated Complexity',
] as const

const VALID_KINDS = new Set(['scaffold', 'feature', 'verification'])
const VALID_PRIORITIES = new Set(['critical', 'high', 'medium', 'low'])
const PLACEHOLDER_CRITERION = /^(?:todo|tbd|n\/?a|works?|test(?: it)?|criterion|acceptance criterion)$/i

export interface BuilderSpecQualityIssue {
  specIndex: number | null
  field: string
  code: string
  message: string
  /** Structured values behind `message` (spec number, heading, label, bounds…)
   *  so the client can localize the issue instead of showing English prose. */
  params?: Record<string, string | number>
}

export interface BuilderSpecBatchQualityOptions {
  milestoneLabel: string
  minSpecs: number
  maxSpecs: number
  requireScaffold: boolean
}

export interface BuilderSpecBatchQualityInput {
  specsComplete: unknown
  specs: readonly unknown[]
}

export interface BuilderSpecBatchQualityReport {
  valid: boolean
  issues: BuilderSpecQualityIssue[]
}

function issue(
  issues: BuilderSpecQualityIssue[],
  specIndex: number | null,
  field: string,
  code: string,
  message: string,
  params: Record<string, string | number> = {},
): void {
  issues.push({
    specIndex,
    field,
    code,
    message,
    params: specIndex === null ? params : { n: specIndex + 1, ...params },
  })
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
}

function h2Sections(description: string): { headings: string[]; bodies: Map<string, string> } {
  const matches = [...description.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)]
  const headings = matches.map((match) => match[1].trim())
  const bodies = new Map<string, string>()
  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? description.length) : description.length
    bodies.set(headings[index], description.slice(start, end).trim())
  })
  return { headings, bodies }
}

function bulletCount(body: string): number {
  return body.split(/\r?\n/).filter((line) => /^\s*[-*+]\s+\S/.test(line)).length
}

/**
 * Strict readiness gate for detailed Project Builder specs. Parsing stays
 * permissive so interview/stream snapshots and old persisted blueprints remain
 * readable; this gate runs only before a batch can mutate project state.
 */
export function analyzeBuilderSpecBatch(
  input: BuilderSpecBatchQualityInput,
  options: BuilderSpecBatchQualityOptions,
): BuilderSpecBatchQualityReport {
  const issues: BuilderSpecQualityIssue[] = []
  const label = options.milestoneLabel.trim().toUpperCase()

  if (input.specsComplete !== true) {
    issue(issues, null, 'specsComplete', 'batch_incomplete', 'generation is not marked complete')
  }
  if (input.specs.length < options.minSpecs || input.specs.length > options.maxSpecs) {
    issue(
      issues,
      null,
      'm1Specs',
      'spec_count',
      `requires ${options.minSpecs}-${options.maxSpecs} specs (received ${input.specs.length})`,
      { min: options.minSpecs, max: options.maxSpecs, count: input.specs.length },
    )
  }

  const titles = new Map<string, number>()
  input.specs.forEach((raw, specIndex) => {
    const spec = record(raw)
    const humanIndex = specIndex + 1
    if (!spec) {
      issue(issues, specIndex, 'spec', 'invalid_shape', `spec ${humanIndex} must be an object`)
      return
    }

    const kind = typeof spec.kind === 'string' ? spec.kind : ''
    if (!VALID_KINDS.has(kind)) {
      issue(issues, specIndex, 'kind', 'invalid_kind', `spec ${humanIndex} kind must be scaffold, feature, or verification`)
    }
    if (options.requireScaffold && specIndex === 0 && kind !== 'scaffold') {
      issue(issues, specIndex, 'kind', 'scaffold_first', 'spec 1 must be the project scaffold')
    }
    if (options.requireScaffold && specIndex > 0 && kind === 'scaffold') {
      issue(issues, specIndex, 'kind', 'duplicate_scaffold', `spec ${humanIndex} cannot be another scaffold`)
    }

    const title = typeof spec.title === 'string' ? spec.title.trim() : ''
    if (!title) {
      issue(issues, specIndex, 'title', 'required', `spec ${humanIndex} title is required`)
    } else {
      const key = normalized(title)
      const prior = titles.get(key)
      if (prior !== undefined) {
        issue(issues, specIndex, 'title', 'duplicate', `spec ${humanIndex} duplicates spec ${prior + 1} title`, { other: prior + 1 })
      } else {
        titles.set(key, specIndex)
      }
    }

    const shortSummary = typeof spec.shortSummary === 'string' ? spec.shortSummary.trim() : ''
    if (!shortSummary) {
      issue(issues, specIndex, 'shortSummary', 'required', `spec ${humanIndex} shortSummary is required`)
    } else if (shortSummary.length > 240 || /[\r\n]/.test(shortSummary)) {
      issue(issues, specIndex, 'shortSummary', 'invalid_length', `spec ${humanIndex} shortSummary must be one line and at most 240 characters`)
    }

    const priority = typeof spec.priority === 'string' ? spec.priority : ''
    if (!VALID_PRIORITIES.has(priority)) {
      issue(issues, specIndex, 'priority', 'invalid_priority', `spec ${humanIndex} priority must be critical, high, medium, or low`)
    }

    const labels = Array.isArray(spec.labels)
      ? spec.labels.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
      : []
    const normalizedLabels = new Set(labels.map((value) => value.toUpperCase()))
    if (!normalizedLabels.has(label)) {
      issue(issues, specIndex, 'labels', 'milestone_label', `spec ${humanIndex} labels must include ${label}`, { label })
    }
    if (labels.every((value) => value.toUpperCase() === label)) {
      issue(issues, specIndex, 'labels', 'domain_label', `spec ${humanIndex} requires at least one domain label besides ${label}`, { label })
    }

    const description = typeof spec.description === 'string' ? spec.description.trim() : ''
    const sections = h2Sections(description)
    if (
      !/^## Problem Statement(?:\r?\n|$)/.test(description)
      || sections.headings.length !== BUILDER_SPEC_HEADINGS.length
      || sections.headings.some((heading, index) => heading !== BUILDER_SPEC_HEADINGS[index])
    ) {
      issue(
        issues,
        specIndex,
        'description',
        'canonical_sections',
        `spec ${humanIndex} description must contain exactly the five canonical sections in order`,
      )
    }
    for (const heading of BUILDER_SPEC_HEADINGS) {
      if (!(sections.bodies.get(heading) ?? '').trim()) {
        issue(issues, specIndex, 'description', 'empty_section', `spec ${humanIndex} section "${heading}" cannot be empty`, { heading })
      }
    }
    for (const heading of ['Out of Scope', 'Technical Considerations'] as const) {
      const body = sections.bodies.get(heading) ?? ''
      if (body && bulletCount(body) < 2) {
        issue(issues, specIndex, 'description', 'section_bullets', `spec ${humanIndex} section "${heading}" requires at least two bullets`, { heading })
      }
    }
    const complexity = sections.bodies.get('Estimated Complexity') ?? ''
    if (complexity && !/^(?:Low|Medium|High|Very High)\s*(?:[—\-:]\s*)\S/i.test(complexity)) {
      issue(issues, specIndex, 'description', 'complexity_format', `spec ${humanIndex} Estimated Complexity needs a level and justification`)
    }
    if (options.requireScaffold && specIndex === 0 && description && !/\bREADME\b/i.test(description)) {
      issue(issues, specIndex, 'description', 'scaffold_readme', 'spec 1 must note that the repository already contains a README')
    }

    const criteria = Array.isArray(spec.acceptanceCriteria) ? spec.acceptanceCriteria : []
    if (criteria.length < 4 || criteria.length > 10) {
      issue(issues, specIndex, 'acceptanceCriteria', 'criteria_count', `spec ${humanIndex} acceptanceCriteria requires 4-10 items`, { count: criteria.length })
    }
    const seenCriteria = new Set<string>()
    criteria.forEach((criterion, criterionIndex) => {
      const text = typeof criterion === 'string' ? criterion.trim() : ''
      if (text.length < 10 || PLACEHOLDER_CRITERION.test(text)) {
        issue(issues, specIndex, 'acceptanceCriteria', 'criterion_quality', `spec ${humanIndex} criterion ${criterionIndex + 1} must be a concrete testable outcome`, { criterion: criterionIndex + 1 })
        return
      }
      const key = normalized(text)
      if (seenCriteria.has(key)) {
        issue(issues, specIndex, 'acceptanceCriteria', 'duplicate_criterion', `spec ${humanIndex} criterion ${criterionIndex + 1} is duplicated`, { criterion: criterionIndex + 1 })
      }
      seenCriteria.add(key)
    })

    const dependency = spec.dependsOnIndex
    if (dependency !== undefined && (!Number.isInteger(dependency) || (dependency as number) < 0 || (dependency as number) >= specIndex)) {
      issue(issues, specIndex, 'dependsOnIndex', 'invalid_dependency', `spec ${humanIndex} dependency must point to an earlier spec`)
    }
    if (options.requireScaffold && specIndex === 0 && dependency !== undefined) {
      issue(issues, specIndex, 'dependsOnIndex', 'scaffold_dependency', 'spec 1 scaffold must not declare a dependency')
    }
  })

  return { valid: issues.length === 0, issues }
}

export function firstBuilderSpecQualityDetail(report: BuilderSpecBatchQualityReport): string | undefined {
  return report.issues[0]?.message
}

/** Typed convenience for already-coerced callers and tests. */
export function analyzeTypedBuilderSpecs(
  specs: readonly BlueprintM1Spec[],
  specsComplete: boolean,
  options: BuilderSpecBatchQualityOptions,
): BuilderSpecBatchQualityReport {
  return analyzeBuilderSpecBatch({ specs, specsComplete }, options)
}

/** M1 walking-skeleton gate options — the single definition shared by the
 *  commit validator, the chat manager's post-turn audit, and the router. */
export const M1_BATCH_QUALITY_OPTIONS: BuilderSpecBatchQualityOptions = {
  milestoneLabel: 'M1',
  minSpecs: 5,
  maxSpecs: 10,
  requireScaffold: true,
}

/** Audit an exact raw snapshot payload against the M1 gate. Tolerant of any
 *  input shape (a non-object simply fails the gate). */
export function auditRawBlueprintForM1(rawBlueprint: unknown): BuilderSpecBatchQualityReport & { claimsComplete: boolean } {
  const source = record(rawBlueprint)
  const specs = Array.isArray(source?.m1Specs) ? source.m1Specs : []
  const report = analyzeBuilderSpecBatch({ specsComplete: source?.specsComplete, specs }, M1_BATCH_QUALITY_OPTIONS)
  return { ...report, claimsComplete: source?.specsComplete === true }
}

/** Compact, model-facing rendering of the audit (one line per issue). */
export function formatQualityIssuesForModel(issues: readonly BuilderSpecQualityIssue[], max = 40): string {
  const lines = issues.slice(0, max).map((i) => `- ${i.message}`)
  if (issues.length > max) lines.push(`- …and ${issues.length - max} more`)
  return lines.join('\n')
}
