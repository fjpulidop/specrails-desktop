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
      expect(prompt).toMatch(/6(?:-|–)10/)
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

  it('teaches the app-driven batched generation protocol (outline → detail → audit)', () => {
    expect(BUILDER_INSTRUCTIONS).toContain('## Generation protocol (app-driven batches)')
    expect(BUILDER_INSTRUCTIONS).toContain('`description: ""`')
    expect(BUILDER_INSTRUCTIONS).toContain('APP CONTINUE')
    expect(BUILDER_INSTRUCTIONS).toContain('`spec-detail`')
    expect(BUILDER_INSTRUCTIONS).toContain('APP AUDIT')
    expect(BUILDER_INSTRUCTIONS).toContain('`spec-audit`')
    expect(BUILDER_INSTRUCTIONS).toContain('GENERATION MODE: single response')
    expect(BUILDER_INSTRUCTIONS).toContain('`specsComplete: true` only when')
    expect(BUILDER_SYSTEM_PROMPT).toContain('OUTLINE snapshot')
    expect(BUILDER_SYSTEM_PROMPT).toContain('APP CONTINUE reply with one fenced spec-detail block')
    expect(BUILDER_SYSTEM_PROMPT).toContain('APP AUDIT reply with one fenced spec-audit block')
    expect(BUILDER_SYSTEM_PROMPT).toContain('GENERATION MODE: single response')
    expect(BUILDER_SYSTEM_PROMPT).toContain('else m1Specs: [] with specsComplete: false')
  })

  it('carries the shared premium depth bar (sub-blocks, bullet minima, criteria coverage)', () => {
    for (const prompt of [BUILDER_INSTRUCTIONS, BUILDER_SYSTEM_PROMPT]) {
      for (const block of ['User experience', 'Data model', 'Interfaces & contracts', 'Planned modules', 'Key decisions']) {
        expect(prompt).toContain(block)
      }
      expect(prompt).toMatch(/at least 3 bullets|>=3 bullets/)
      expect(prompt).toMatch(/at least 5 labelled bullets|>=5 labelled bullets/)
      expect(prompt).toContain('Testing strategy')
      expect(prompt).toContain('Risks & mitigations')
      expect(prompt).toContain('failure')
      expect(prompt).toContain('automated verification')
    }
  })

  it('requires a truthful scaffold and forbids invented day-0 code locations', () => {
    expect(BUILDER_INSTRUCTIONS).toContain('`m1Specs[0]` is `kind: "scaffold"`')
    expect(BUILDER_INSTRUCTIONS).toContain('repository already contains a README')
    expect(BUILDER_INSTRUCTIONS).toContain('install, run, test, and CI outcomes')
    expect(BUILDER_INSTRUCTIONS).toContain('never invent or imply an EXISTING repository path')
    expect(BUILDER_INSTRUCTIONS).toContain('Label every module, path, table or route you\nintroduce as planned')
    expect(BUILDER_INSTRUCTIONS).toContain('planned components, intended contracts/data shapes, known risks')

    expect(BUILDER_SYSTEM_PROMPT).toContain('m1Specs[0] is kind scaffold')
    expect(BUILDER_SYSTEM_PROMPT).toContain('repo already contains a README')
    expect(BUILDER_SYSTEM_PROMPT).toContain('never invent or imply an existing repository path')
  })

  it('shows a commit-ready scaffold example instead of placeholder prose or a self dependency', () => {
    expect(BUILDER_INSTRUCTIONS).toContain('Scaffold the runnable project foundation')
    expect(BUILDER_INSTRUCTIONS).toContain('Any product feature beyond the placeholder')
    expect(BUILDER_INSTRUCTIONS).toContain('Production deployment, hosting and environment provisioning')
    expect(BUILDER_INSTRUCTIONS).toContain('CI runs install, lint, build and test')
    // The example is the premium bar: sub-blocks, labelled bullets, six criteria.
    expect(BUILDER_INSTRUCTIONS).toContain('### Planned modules')
    expect(BUILDER_INSTRUCTIONS).toContain('(planned)')
    expect(BUILDER_INSTRUCTIONS).toContain('**Testing strategy**')
    const example = BUILDER_INSTRUCTIONS.slice(
      BUILDER_INSTRUCTIONS.indexOf('```blueprint-draft'),
      BUILDER_INSTRUCTIONS.indexOf('```', BUILDER_INSTRUCTIONS.indexOf('```blueprint-draft') + 3),
    )
    expect(example).not.toContain('"dependsOnIndex"')
    // The example fence is the protocol fence — a ```json example taught the
    // model to emit ```json snapshots the parser could not see.
    expect(BUILDER_INSTRUCTIONS).not.toMatch(/^```json/m)
    expect(BUILDER_INSTRUCTIONS).toContain('```blueprint-draft\n{')
    expect(BUILDER_INSTRUCTIONS).toContain('The fence language is EXACTLY `blueprint-draft`')
    expect(BUILDER_SYSTEM_PROMPT).toContain('fence language EXACTLY blueprint-draft')
    expect(example).not.toContain('"description": "## Problem Statement\\n...')
  })

  it('keeps criteria structured and M2+ shallow at day 0', () => {
    expect(BUILDER_INSTRUCTIONS).toContain('Do NOT put an `## Acceptance Criteria` heading in `description`')
    expect(BUILDER_INSTRUCTIONS).toContain('`acceptanceCriteria` contains 6–10')
    expect(BUILDER_INSTRUCTIONS).toContain('Milestones 2+ contain only shallow English `plannedSpecs` titles')
    expect(BUILDER_SYSTEM_PROMPT).toContain('Never an ## Acceptance Criteria section in description')
    expect(BUILDER_SYSTEM_PROMPT).toContain('M2+ keeps title-only plannedSpecs')
  })
})
