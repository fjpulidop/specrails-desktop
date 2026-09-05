import { describe, expect, it } from 'vitest'
import { analyzeBuilderSpecBatch, BUILDER_SPEC_HEADINGS } from './blueprint-spec-quality'
import { premiumDescription, premiumSpec } from './blueprint-spec-fixtures'
import { SPEC_DEPTH_FLOORS } from './spec-contract-prompt'
import type { BlueprintM1Spec } from './blueprint-types'

const validSpecs = (): BlueprintM1Spec[] => Array.from({ length: 5 }, (_, index) => premiumSpec(index))
const options = { milestoneLabel: 'M1', minSpecs: 5, maxSpecs: 10, requireScaffold: true }
const codesOf = (specs: BlueprintM1Spec[]) => analyzeBuilderSpecBatch({ specsComplete: true, specs }, options).issues.map((item) => item.code)

/** Replace one canonical section's body in a premium description. */
function withSection(description: string, heading: string, body: string): string {
  const re = new RegExp(`(## ${heading}\\n)[\\s\\S]*?(?=\\n## |$)`)
  return description.replace(re, `$1${body}`)
}

describe('analyzeBuilderSpecBatch', () => {
  it('accepts a complete canonical premium M1 batch', () => {
    expect(analyzeBuilderSpecBatch({ specsComplete: true, specs: validSpecs() }, options)).toEqual({ valid: true, issues: [] })
  })

  it('pins the canonical heading order', () => {
    expect(BUILDER_SPEC_HEADINGS).toEqual([
      'Problem Statement', 'Proposed Solution', 'Out of Scope', 'Technical Considerations', 'Estimated Complexity',
    ])
  })

  it('rejects a Mesa-like incomplete one-line batch', () => {
    const specs = Array.from({ length: 5 }, (_, index) => ({
      title: `Spec ${index}`, description: 'Build this feature.', labels: ['M1'], dependsOnIndex: index,
    }))
    const report = analyzeBuilderSpecBatch({ specsComplete: false, specs }, options)
    expect(report.valid).toBe(false)
    expect(report.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      'batch_incomplete', 'invalid_kind', 'required', 'canonical_sections', 'criteria_count', 'invalid_dependency',
    ]))
  })

  it('rejects missing, duplicate, or out-of-order headings', () => {
    const base = premiumDescription({ readme: true })
    for (const broken of [
      `Unheaded summary that does not belong in the canonical contract.\n\n${base}`,
      base.replace('## Out of Scope\n', ''),
      base.replace('## Technical Considerations', '## Out of Scope'),
      base.replace('## Problem Statement', '## Proposed Solution').replace('## Proposed Solution\n1.', '## Problem Statement\n1.'),
    ]) {
      const specs = validSpecs()
      specs[0] = { ...specs[0], description: broken }
      expect(analyzeBuilderSpecBatch({ specsComplete: true, specs }, options).issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'canonical_sections', specIndex: 0 })]),
      )
    }
  })

  it('enforces the premium depth floors: thin problem / solution sections and too few bullets', () => {
    const specs = validSpecs()
    specs[1] = {
      ...specs[1],
      description: withSection(
        withSection(
          withSection(withSection(specs[1].description, 'Problem Statement', 'Users need this.'), 'Proposed Solution', 'Build it well.'),
          'Out of Scope', '- A\n- B',
        ),
        'Technical Considerations', '- One\n- Two\n- Three\n- Four',
      ),
    }
    const issues = analyzeBuilderSpecBatch({ specsComplete: true, specs }, options).issues
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'section_depth', specIndex: 1, params: expect.objectContaining({ heading: 'Problem Statement', min: SPEC_DEPTH_FLOORS.problemMinChars }) }),
      expect.objectContaining({ code: 'section_depth', specIndex: 1, params: expect.objectContaining({ heading: 'Proposed Solution', min: SPEC_DEPTH_FLOORS.solutionMinChars }) }),
      expect.objectContaining({ code: 'section_bullets', specIndex: 1, params: expect.objectContaining({ heading: 'Out of Scope', min: 3 }) }),
      expect.objectContaining({ code: 'section_bullets', specIndex: 1, params: expect.objectContaining({ heading: 'Technical Considerations', min: 5 }) }),
    ]))
    // The premium fixture itself sits above every floor.
    expect(codesOf(validSpecs())).toEqual([])
  })

  it('### sub-headings never count as canonical sections', () => {
    const specs = validSpecs()
    expect(specs[1].description).toContain('### Data model')
    expect(codesOf(specs)).toEqual([])
  })

  it('rejects criteria outside 6-10, short or placeholder criteria, and duplicates', () => {
    const specs = validSpecs()
    specs[1] = { ...specs[1], acceptanceCriteria: ['Works', 'A concrete outcome exists here.', 'A concrete outcome exists here.'] }
    const issues = analyzeBuilderSpecBatch({ specsComplete: true, specs }, options).issues
    expect(issues.map((item) => item.code)).toEqual(expect.arrayContaining(['criteria_count', 'criterion_quality', 'duplicate_criterion']))
    expect(issues.find((i) => i.code === 'criteria_count')?.params).toMatchObject({ count: 3, min: 6, max: 10 })
    const eleven = { ...specs[2], acceptanceCriteria: Array.from({ length: 11 }, (_, i) => `Given the state ${i}, when the user acts, then outcome ${i} is observable.`) }
    expect(codesOf([specs[0], eleven, specs[2], specs[3], specs[4]].map((s, i) => ({ ...s, title: `T${i}` })))).toContain('criteria_count')
    const shortOne = { ...specs[3], acceptanceCriteria: [...specs[3].acceptanceCriteria.slice(0, 5), 'Short criterion.'] }
    expect(codesOf([specs[0], specs[1], specs[2], shortOne, specs[4]])).toContain('criterion_quality')
  })

  it('rejects duplicate titles, missing domain label, and self/forward dependencies', () => {
    const specs = validSpecs()
    specs[1] = { ...specs[1], title: specs[0].title.toUpperCase(), labels: ['M1'], dependsOnIndex: 1 }
    expect(codesOf(specs)).toEqual(expect.arrayContaining(['duplicate', 'domain_label', 'invalid_dependency']))
  })

  it('requires an explicit dependency-free first scaffold mentioning README', () => {
    const specs = validSpecs()
    specs[0] = { ...specs[0], kind: 'feature', description: premiumDescription({ readme: false, subject: 'the project foundation' }), dependsOnIndex: 0 }
    expect(codesOf(specs)).toEqual(expect.arrayContaining(['scaffold_first', 'scaffold_readme', 'invalid_dependency', 'scaffold_dependency']))
  })

  it('rejects a second scaffold and a non-catalog priority', () => {
    const specs = validSpecs()
    specs[1] = { ...specs[1], kind: 'scaffold', priority: 'urgent' as never }
    expect(codesOf(specs)).toEqual(expect.arrayContaining(['duplicate_scaffold', 'invalid_priority']))
  })

  it('supports a complete non-M1 milestone without a scaffold requirement', () => {
    const later = [premiumSpec(1), premiumSpec(2)].map((value, index) => ({
      ...value,
      title: `M2 feature ${index}`,
      labels: ['M2', 'workflow'],
      dependsOnIndex: index === 1 ? 0 : undefined,
    }))
    expect(analyzeBuilderSpecBatch(
      { specsComplete: true, specs: later },
      { milestoneLabel: 'M2', minSpecs: 1, maxSpecs: 10, requireScaffold: false },
    )).toEqual({ valid: true, issues: [] })
  })
})
