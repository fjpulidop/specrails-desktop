import { describe, expect, it } from 'vitest'
import { premiumSpec } from './premium-spec-fixture'
import { analyzeBlueprintSpecQuality } from '../blueprint-spec-quality'
import { parseBlueprintDraftBlocks, type Blueprint, type BlueprintM1Spec } from '../blueprint-draft'

function spec(index: number): BlueprintM1Spec {
  return premiumSpec(index, { title: `Deliver slice ${index}`, labels: ['M1', 'workflow'] })
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
