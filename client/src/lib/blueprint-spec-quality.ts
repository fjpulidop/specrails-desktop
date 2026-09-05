export const BUILDER_SPEC_HEADINGS = [
  'Problem Statement',
  'Proposed Solution',
  'Out of Scope',
  'Technical Considerations',
  'Estimated Complexity',
] as const

/** Mirror of server/spec-contract-prompt.ts SPEC_DEPTH_FLOORS — keep in sync. */
export const SPEC_DEPTH_FLOORS = {
  problemMinChars: 200,
  solutionMinChars: 500,
  outOfScopeMinBullets: 3,
  technicalMinBullets: 5,
  criteriaMin: 6,
  criteriaMax: 10,
  criterionMinChars: 20,
} as const

const VALID_KINDS = new Set(['scaffold', 'feature', 'verification'])
const VALID_PRIORITIES = new Set(['critical', 'high', 'medium', 'low'])
const PLACEHOLDER_CRITERION = /^(?:todo|tbd|n\/?a|works?|test(?: it)?|criterion|acceptance criterion)$/i

export interface BuilderSpecQualityIssue {
  specIndex: number | null
  field: string
  code: string
  message: string
  /** Structured values behind `message` so the UI can localize the issue
   *  (`n` = 1-based spec number for spec-scoped issues). */
  params?: Record<string, string | number>
}

export interface BuilderSpecQualityOptions {
  milestoneLabel: string
  minSpecs: number
  maxSpecs: number
  requireScaffold: boolean
}

export interface BuilderSpecQualityReport {
  valid: boolean
  issues: BuilderSpecQualityIssue[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
}

function sections(description: string): { headings: string[]; bodies: Map<string, string> } {
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

function bullets(body: string): number {
  return body.split(/\r?\n/).filter((line) => /^\s*[-*+]\s+\S/.test(line)).length
}

/**
 * Browser-side mirror of the authoritative server gate. It deliberately reads
 * the exact pre-coercion JSON snapshot: legacy defaults are useful for
 * rendering old blueprints, but must never launder malformed model output into
 * a commit-ready batch.
 */
export function analyzeBlueprintSpecQuality(
  blueprint: unknown,
  options: BuilderSpecQualityOptions,
): BuilderSpecQualityReport {
  const issues: BuilderSpecQualityIssue[] = []
  const source = record(blueprint)
  const specs = Array.isArray(source?.m1Specs) ? source.m1Specs : []
  const label = options.milestoneLabel.trim().toUpperCase()
  const add = (
    specIndex: number | null,
    field: string,
    code: string,
    message: string,
    params: Record<string, string | number> = {},
  ): void => {
    issues.push({
      specIndex,
      field,
      code,
      message,
      params: specIndex === null ? params : { n: specIndex + 1, ...params },
    })
  }

  if (source?.specsComplete !== true) add(null, 'specsComplete', 'batch_incomplete', 'Generation is not complete yet.')
  if (specs.length < options.minSpecs || specs.length > options.maxSpecs) {
    add(
      null,
      'm1Specs',
      'spec_count',
      `The batch needs ${options.minSpecs}-${options.maxSpecs} specs.`,
      { min: options.minSpecs, max: options.maxSpecs, count: specs.length },
    )
  }

  const titles = new Map<string, number>()
  specs.forEach((raw, specIndex) => {
    const spec = record(raw)
    const n = specIndex + 1
    if (!spec) {
      add(specIndex, 'spec', 'invalid_shape', `Spec ${n} must be an object.`)
      return
    }

    const kind = typeof spec.kind === 'string' ? spec.kind : ''
    if (!VALID_KINDS.has(kind)) add(specIndex, 'kind', 'invalid_kind', `Spec ${n} needs a valid kind.`)
    if (options.requireScaffold && specIndex === 0 && kind !== 'scaffold') {
      add(specIndex, 'kind', 'scaffold_first', 'The first spec must be the project scaffold.')
    }
    if (options.requireScaffold && specIndex > 0 && kind === 'scaffold') {
      add(specIndex, 'kind', 'duplicate_scaffold', `Spec ${n} cannot be another scaffold.`)
    }

    const title = typeof spec.title === 'string' ? spec.title.trim() : ''
    if (!title) {
      add(specIndex, 'title', 'required', `Spec ${n} needs a title.`)
    } else {
      const key = normalized(title)
      const prior = titles.get(key)
      if (prior !== undefined) add(specIndex, 'title', 'duplicate', `Spec ${n} duplicates spec ${prior + 1}.`, { other: prior + 1 })
      else titles.set(key, specIndex)
    }

    const shortSummary = typeof spec.shortSummary === 'string' ? spec.shortSummary.trim() : ''
    if (!shortSummary || shortSummary.length > 240 || /[\r\n]/.test(shortSummary)) {
      add(specIndex, 'shortSummary', 'summary', `Spec ${n} needs a one-line summary under 240 characters.`)
    }

    const priority = typeof spec.priority === 'string' ? spec.priority : ''
    if (!VALID_PRIORITIES.has(priority)) add(specIndex, 'priority', 'invalid_priority', `Spec ${n} needs a valid priority.`)

    const description = typeof spec.description === 'string' ? spec.description.trim() : ''
    const parsed = sections(description)
    if (
      !/^## Problem Statement(?:\r?\n|$)/.test(description)
      || parsed.headings.length !== BUILDER_SPEC_HEADINGS.length
      || parsed.headings.some((value, index) => value !== BUILDER_SPEC_HEADINGS[index])
    ) {
      add(specIndex, 'description', 'canonical_sections', `Spec ${n} is missing the canonical sections.`)
    }
    for (const heading of BUILDER_SPEC_HEADINGS) {
      if (!(parsed.bodies.get(heading) ?? '').trim()) {
        add(specIndex, 'description', 'empty_section', `Spec ${n} has an empty ${heading} section.`, { heading })
      }
    }
    for (const [heading, min] of [['Problem Statement', SPEC_DEPTH_FLOORS.problemMinChars], ['Proposed Solution', SPEC_DEPTH_FLOORS.solutionMinChars]] as const) {
      const body = (parsed.bodies.get(heading) ?? '').trim()
      if (body && body.length < min) add(specIndex, 'description', 'section_depth', `Spec ${n} ${heading} is too thin.`, { heading, min })
    }
    for (const [heading, min] of [['Out of Scope', SPEC_DEPTH_FLOORS.outOfScopeMinBullets], ['Technical Considerations', SPEC_DEPTH_FLOORS.technicalMinBullets]] as const) {
      const body = parsed.bodies.get(heading) ?? ''
      if (body && bullets(body) < min) add(specIndex, 'description', 'section_bullets', `Spec ${n} needs ${min} ${heading} bullets.`, { heading, min })
    }
    const complexity = parsed.bodies.get('Estimated Complexity') ?? ''
    if (complexity && !/^(?:Low|Medium|High|Very High)\s*(?:[—\-:]\s*)\S/i.test(complexity)) {
      add(specIndex, 'description', 'complexity_format', `Spec ${n} needs a justified complexity.`)
    }
    if (options.requireScaffold && specIndex === 0 && description && !/\bREADME\b/i.test(description)) {
      add(specIndex, 'description', 'scaffold_readme', 'The scaffold spec must mention the existing README.')
    }

    const criteria = Array.isArray(spec.acceptanceCriteria) ? spec.acceptanceCriteria : []
    if (criteria.length < SPEC_DEPTH_FLOORS.criteriaMin || criteria.length > SPEC_DEPTH_FLOORS.criteriaMax) {
      add(specIndex, 'acceptanceCriteria', 'criteria_count', `Spec ${n} needs ${SPEC_DEPTH_FLOORS.criteriaMin}-${SPEC_DEPTH_FLOORS.criteriaMax} acceptance criteria.`, { count: criteria.length, min: SPEC_DEPTH_FLOORS.criteriaMin, max: SPEC_DEPTH_FLOORS.criteriaMax })
    }
    const seenCriteria = new Set<string>()
    criteria.forEach((criterion, criterionIndex) => {
      const text = typeof criterion === 'string' ? criterion.trim() : ''
      if (text.length < SPEC_DEPTH_FLOORS.criterionMinChars || PLACEHOLDER_CRITERION.test(text)) {
        add(specIndex, 'acceptanceCriteria', 'criterion_quality', `Spec ${n} criterion ${criterionIndex + 1} is not concrete.`, { criterion: criterionIndex + 1 })
        return
      }
      const key = normalized(text)
      if (seenCriteria.has(key)) add(specIndex, 'acceptanceCriteria', 'duplicate_criterion', `Spec ${n} repeats an acceptance criterion.`, { criterion: criterionIndex + 1 })
      seenCriteria.add(key)
    })

    const labels = Array.isArray(spec.labels)
      ? spec.labels.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
      : []
    const normalizedLabels = new Set(labels.map((value) => value.toUpperCase()))
    if (!normalizedLabels.has(label)) add(specIndex, 'labels', 'milestone_label', `Spec ${n} needs the ${label} label.`, { label })
    if (labels.every((value) => value.toUpperCase() === label)) add(specIndex, 'labels', 'domain_label', `Spec ${n} needs a domain label.`, { label })

    const dependency = spec.dependsOnIndex
    if (dependency !== undefined && (!Number.isInteger(dependency) || (dependency as number) < 0 || (dependency as number) >= specIndex)) {
      add(specIndex, 'dependsOnIndex', 'invalid_dependency', `Spec ${n} must depend only on an earlier spec.`)
    }
    if (options.requireScaffold && specIndex === 0 && dependency !== undefined) {
      add(specIndex, 'dependsOnIndex', 'scaffold_dependency', 'The scaffold cannot declare a dependency.')
    }
  })

  return { valid: issues.length === 0, issues }
}
