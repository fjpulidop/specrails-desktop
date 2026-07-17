import { describe, expect, it } from 'vitest'
import { analyzeBlueprintSpecQuality } from '../blueprint-spec-quality'
import { parseBlueprintDraftBlocks, type Blueprint, type BlueprintM1Spec } from '../blueprint-draft'

function spec(index: number): BlueprintM1Spec {
  return {
    kind: index === 0 ? 'scaffold' : 'feature',
    title: `Deliver slice ${index}`,
    shortSummary: `Deliver a complete testable slice ${index}.`,
    description: [
      '## Problem Statement', `Users need slice ${index} to complete their workflow.${index === 0 ? ' The repository already contains a README.' : ''}`,
      '', '## Proposed Solution', 'Build the complete behavior with explicit boundaries and persisted state.',
      '', '## Out of Scope', '- Collaboration', '- Advanced analytics',
      '', '## Technical Considerations', '- Model loading and failure states', '- Automated behavior coverage',
      '', '## Estimated Complexity', 'Medium — the slice crosses several layers.',
    ].join('\n'),
    acceptanceCriteria: ['The happy path completes successfully.', 'Invalid input is rejected clearly.', 'Empty state is rendered deliberately.', 'Automated tests cover failures.'],
    priority: 'medium',
    labels: ['M1', 'workflow'],
    ...(index > 0 ? { dependsOnIndex: index - 1 } : {}),
  }
}

function blueprint(): Pick<Blueprint, 'specsComplete' | 'm1Specs'> {
  return { specsComplete: true, m1Specs: Array.from({ length: 5 }, (_, index) => spec(index)) }
}

const options = { milestoneLabel: 'M1', minSpecs: 5, maxSpecs: 10, requireScaffold: true }

describe('analyzeBlueprintSpecQuality', () => {
  it('accepts a complete rich batch', () => {
    expect(analyzeBlueprintSpecQuality(blueprint(), options)).toEqual({ valid: true, issues: [] })
  })

  it('keeps partial and shallow batches uncommittable', () => {
    const report = analyzeBlueprintSpecQuality({ specsComplete: false, m1Specs: [{ ...spec(0), description: 'Initialize the app.' }] }, options)
    expect(report.valid).toBe(false)
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['batch_incomplete', 'spec_count', 'canonical_sections']))
  })

  it('rejects legacy unheaded prose before the canonical sections', () => {
    const value = blueprint()
    value.m1Specs[0] = { ...value.m1Specs[0], description: `Legacy summary.\n\n${value.m1Specs[0].description}` }
    expect(analyzeBlueprintSpecQuality(value, options).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'canonical_sections', specIndex: 0 })]),
    )
  })

  it('rejects a self dependency', () => {
    const value = blueprint()
    value.m1Specs[0] = { ...value.m1Specs[0], dependsOnIndex: 0 }
    expect(analyzeBlueprintSpecQuality(value, options).issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['invalid_dependency', 'scaffold_dependency']),
    )
  })

  it('mirrors server kind, priority, and scaffold validation before commit', () => {
    const value = blueprint()
    value.m1Specs[1] = {
      ...value.m1Specs[1],
      kind: 'scaffold',
      priority: 'urgent' as never,
      acceptanceCriteria: ['TBD', ...value.m1Specs[1].acceptanceCriteria.slice(1)],
    }
    expect(analyzeBlueprintSpecQuality(value, options).issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['duplicate_scaffold', 'invalid_priority', 'criterion_quality']),
    )
  })

  it('validates the exact model payload rather than its compatibility-normalized view', () => {
    const raw = {
      blueprintVersion: 1,
      ...blueprint(),
      m1Specs: blueprint().m1Specs.map((item, index) => index === 1
        ? { ...item, priority: 'urgent', dependsOnIndex: -1 }
        : item),
    }
    const parsed = parseBlueprintDraftBlocks(`\`\`\`blueprint-draft\n${JSON.stringify(raw)}\n\`\`\``)
    expect(parsed.blueprint?.m1Specs[1]).toMatchObject({ priority: 'medium' })
    expect(parsed.blueprint?.m1Specs[1].dependsOnIndex).toBeUndefined()
    expect(analyzeBlueprintSpecQuality(parsed.blueprint, options).valid).toBe(true)
    expect(analyzeBlueprintSpecQuality(parsed.rawBlueprint, options).issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['invalid_priority', 'invalid_dependency']),
    )
  })
})
