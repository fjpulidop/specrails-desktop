import { describe, expect, it } from 'vitest'
import { analyzeBuilderSpecBatch, BUILDER_SPEC_HEADINGS } from './blueprint-spec-quality'
import type { BlueprintM1Spec } from './blueprint-types'

const description = (readme = false): string => [
  '## Problem Statement',
  `Home cooks need a reliable end-to-end starting point for the product.${readme ? ' The repository already contains a README.' : ''}`,
  '',
  '## Proposed Solution',
  'Build the smallest complete workflow with TypeScript, React, and SQLite while keeping each boundary explicit.',
  '',
  '## Out of Scope',
  '- Social sharing and collaboration',
  '- Advanced personalization',
  '',
  '## Technical Considerations',
  '- Keep domain and persistence contracts independently testable',
  '- Cover loading, empty, success, and failure states',
  '',
  '## Estimated Complexity',
  'Medium — it crosses UI, domain, and persistence boundaries.',
].join('\n')

function spec(index: number): BlueprintM1Spec {
  return {
    kind: index === 0 ? 'scaffold' : 'feature',
    title: index === 0 ? 'Scaffold the application' : `Deliver workflow slice ${index}`,
    shortSummary: index === 0 ? 'Initialize the runnable project foundation.' : `Deliver an independently testable workflow slice ${index}.`,
    description: description(index === 0),
    acceptanceCriteria: [
      'The primary happy path completes with persisted data.',
      'Invalid input produces an actionable validation state.',
      'An empty result renders a deliberate empty state.',
      'Automated tests cover success and failure behavior.',
    ],
    priority: 'medium',
    labels: ['M1', index === 0 ? 'foundation' : 'workflow'],
    ...(index > 0 ? { dependsOnIndex: index - 1 } : {}),
  }
}

const validSpecs = (): BlueprintM1Spec[] => Array.from({ length: 5 }, (_, index) => spec(index))
const options = { milestoneLabel: 'M1', minSpecs: 5, maxSpecs: 10, requireScaffold: true }

describe('analyzeBuilderSpecBatch', () => {
  it('accepts a complete canonical M1 batch', () => {
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
    for (const broken of [
      `Unheaded summary that does not belong in the canonical contract.\n\n${description(true)}`,
      description(true).replace('## Out of Scope\n', ''),
      description(true).replace('## Technical Considerations', '## Out of Scope'),
      description(true).replace(
        '## Proposed Solution\nBuild the smallest complete workflow with TypeScript, React, and SQLite while keeping each boundary explicit.\n\n## Out of Scope',
        '## Out of Scope\n- A\n- B\n\n## Proposed Solution\nBuild the smallest complete workflow with TypeScript, React, and SQLite while keeping each boundary explicit.',
      ),
    ]) {
      const specs = validSpecs()
      specs[0] = { ...specs[0], description: broken }
      expect(analyzeBuilderSpecBatch({ specsComplete: true, specs }, options).issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'canonical_sections', specIndex: 0 })]),
      )
    }
  })

  it('rejects criteria outside 4-10, placeholders, and duplicates', () => {
    const specs = validSpecs()
    specs[1] = { ...specs[1], acceptanceCriteria: ['Works', 'A concrete outcome exists.', 'A concrete outcome exists.'] }
    const codes = analyzeBuilderSpecBatch({ specsComplete: true, specs }, options).issues.map((item) => item.code)
    expect(codes).toEqual(expect.arrayContaining(['criteria_count', 'criterion_quality', 'duplicate_criterion']))
  })

  it('rejects duplicate titles, missing domain label, and self/forward dependencies', () => {
    const specs = validSpecs()
    specs[1] = { ...specs[1], title: specs[0].title.toUpperCase(), labels: ['M1'], dependsOnIndex: 1 }
    const codes = analyzeBuilderSpecBatch({ specsComplete: true, specs }, options).issues.map((item) => item.code)
    expect(codes).toEqual(expect.arrayContaining(['duplicate', 'domain_label', 'invalid_dependency']))
  })

  it('requires an explicit dependency-free first scaffold mentioning README', () => {
    const specs = validSpecs()
    specs[0] = { ...specs[0], kind: 'feature', description: description(false), dependsOnIndex: 0 }
    const codes = analyzeBuilderSpecBatch({ specsComplete: true, specs }, options).issues.map((item) => item.code)
    expect(codes).toEqual(expect.arrayContaining(['scaffold_first', 'scaffold_readme', 'invalid_dependency', 'scaffold_dependency']))
  })

  it('rejects a second scaffold and a non-catalog priority', () => {
    const specs = validSpecs()
    specs[1] = { ...specs[1], kind: 'scaffold', priority: 'urgent' as never }
    const codes = analyzeBuilderSpecBatch({ specsComplete: true, specs }, options).issues.map((item) => item.code)
    expect(codes).toEqual(expect.arrayContaining(['duplicate_scaffold', 'invalid_priority']))
  })

  it('supports a complete non-M1 milestone without a scaffold requirement', () => {
    const later = [spec(1), spec(2)].map((value, index) => ({
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
