import { describe, expect, it } from 'vitest'
import { BUILDER_INSTRUCTIONS, BUILDER_SYSTEM_PROMPT } from './blueprint-operator-prompt'

const CANONICAL_HEADINGS = [
  '## Problem Statement',
  '## Proposed Solution',
  '## Out of Scope',
  '## Technical Considerations',
  '## Estimated Complexity',
] as const

function expectHeadingsInOrder(prompt: string): void {
  let previous = -1
  for (const heading of CANONICAL_HEADINGS) {
    const index = prompt.indexOf(heading, previous + 1)
    expect(index, `${heading} should be present after the prior heading`).toBeGreaterThan(previous)
    previous = index
  }
}

describe('Project Builder day-0 prompt contract', () => {
  it('pins the complete rich blueprint/spec payload in both provider channels', () => {
    for (const prompt of [BUILDER_INSTRUCTIONS, BUILDER_SYSTEM_PROMPT]) {
      for (const field of [
        'specsComplete',
        'kind',
        'shortSummary',
        'acceptanceCriteria',
        'priority',
        'labels',
        'dependsOnIndex',
      ]) {
        expect(prompt).toContain(field)
      }
      expectHeadingsInOrder(prompt)
      expect(prompt).toMatch(/4(?:-|–)10/)
      for (const priority of ['low', 'medium', 'high', 'critical']) {
        expect(prompt).toContain(priority)
      }
      expect(prompt).toContain('domain label')
      expect(prompt).toContain('strictly backward')
    }
  })

  it('keeps interview and surprise snapshots empty until explicit approval', () => {
    expect(BUILDER_INSTRUCTIONS).toContain('Interview and approval gate')
    expect(BUILDER_INSTRUCTIONS).toContain('ALWAYS emit `m1Specs: []` and `specsComplete: false`')
    expect(BUILDER_INSTRUCTIONS).toContain('"Surprise me" follows the same rule')
    expect(BUILDER_INSTRUCTIONS).toContain('only after explicit approval or a direct request')

    expect(BUILDER_SYSTEM_PROMPT).toContain('Before explicit blueprint approval or a direct request')
    expect(BUILDER_SYSTEM_PROMPT).toContain('ALWAYS keep m1Specs: [] and specsComplete: false')
    expect(BUILDER_SYSTEM_PROMPT).toContain('"surprise me" also proposes dimensions only')
  })

  it('returns one complete batch only after a whole-batch quality self-audit', () => {
    expect(BUILDER_INSTRUCTIONS).toContain('complete 5–10-spec walking skeleton in one')
    expect(BUILDER_INSTRUCTIONS).toContain('Do not emit partially generated specs')
    expect(BUILDER_INSTRUCTIONS).toContain('Before setting `specsComplete: true`, self-audit the entire snapshot')
    expect(BUILDER_INSTRUCTIONS).toContain('Set it true only if every spec passes')
    expect(BUILDER_SYSTEM_PROMPT).toContain('complete 5-10-spec M1 walking skeleton in one response')
    expect(BUILDER_SYSTEM_PROMPT).toContain('emit m1Specs: [] with specsComplete: false instead of partial specs')
    expect(BUILDER_SYSTEM_PROMPT).toContain('Set specsComplete true only after auditing all fields')
  })

  it('requires a truthful scaffold and forbids invented day-0 code locations', () => {
    expect(BUILDER_INSTRUCTIONS).toContain('`m1Specs[0]` is `kind: "scaffold"`')
    expect(BUILDER_INSTRUCTIONS).toContain('repository already contains a README')
    expect(BUILDER_INSTRUCTIONS).toContain('install, run, test, and CI outcomes')
    expect(BUILDER_INSTRUCTIONS).toContain('Never invent or imply existing repository paths')
    expect(BUILDER_INSTRUCTIONS).toContain('planned components, intended contracts/data shapes, known risks')

    expect(BUILDER_SYSTEM_PROMPT).toContain('m1Specs[0] is kind scaffold')
    expect(BUILDER_SYSTEM_PROMPT).toContain('repo already contains a README')
    expect(BUILDER_SYSTEM_PROMPT).toContain('NEVER invent paths or existing identifiers')
  })

  it('shows a commit-ready scaffold example instead of placeholder prose or a self dependency', () => {
    expect(BUILDER_INSTRUCTIONS).toContain('Scaffold the runnable project foundation')
    expect(BUILDER_INSTRUCTIONS).toContain('Product features beyond a minimal runnable shell')
    expect(BUILDER_INSTRUCTIONS).toContain('Production deployment and environment provisioning')
    expect(BUILDER_INSTRUCTIONS).toContain('CI executes the build and test commands')
    const example = BUILDER_INSTRUCTIONS.slice(
      BUILDER_INSTRUCTIONS.indexOf('```json'),
      BUILDER_INSTRUCTIONS.indexOf('```', BUILDER_INSTRUCTIONS.indexOf('```json') + 3),
    )
    expect(example).not.toContain('"dependsOnIndex"')
    expect(example).not.toContain('"description": "## Problem Statement\\n...')
  })

  it('keeps criteria structured and M2+ shallow at day 0', () => {
    expect(BUILDER_INSTRUCTIONS).toContain('Do NOT put an `## Acceptance Criteria` heading in `description`')
    expect(BUILDER_INSTRUCTIONS).toContain('`acceptanceCriteria` contains 4–10')
    expect(BUILDER_INSTRUCTIONS).toContain('Milestones 2+ contain only shallow English `plannedSpecs` titles')
    expect(BUILDER_SYSTEM_PROMPT).toContain('never an ## Acceptance Criteria section in description')
    expect(BUILDER_SYSTEM_PROMPT).toContain('M2+ keeps title-only plannedSpecs')
  })
})
