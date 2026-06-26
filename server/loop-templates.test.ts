import { describe, it, expect } from 'vitest'
import { LOOP_TEMPLATES, getLoopTemplate } from './loop-templates'
import { validateLoopGraph, type LoopGraph } from './loop-graph'

/** Every Decider must wire exactly one labeled 'continue' and one 'stop' edge —
 *  the contract the engine routes on and the canvas renders as two distinct
 *  handles. A decider missing a branch (or with a duplicate) would be ambiguous. */
export function assertDeciderBranches(id: string, graph: LoopGraph) {
  for (const d of graph.nodes.filter((n) => n.type === 'decider')) {
    const branches = graph.edges.filter((e) => e.source === d.id).map((e) => e.branch).filter(Boolean).sort()
    expect(branches, `${id}: decider "${d.id}" must have exactly continue+stop branches`).toEqual(['continue', 'stop'])
  }
}

describe('loop templates', () => {
  it('every bundled template is a publishable graph (passes validation)', () => {
    for (const tpl of LOOP_TEMPLATES) {
      const result = validateLoopGraph(tpl.graph)
      expect(result.valid, `${tpl.id} should validate but got: ${JSON.stringify(result.errors)}`).toBe(true)
    }
  })

  it('every Decider has exactly one continue + one stop branch (clean visual wiring)', () => {
    for (const tpl of LOOP_TEMPLATES) assertDeciderBranches(tpl.id, tpl.graph)
  })

  it('has unique ids and names, with non-empty descriptions + tags', () => {
    const ids = LOOP_TEMPLATES.map((t) => t.id)
    const names = LOOP_TEMPLATES.map((t) => t.name)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(names).size).toBe(names.length)
    for (const t of LOOP_TEMPLATES) {
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.tags.length).toBeGreaterThan(0)
    }
  })

  it('bundles the spec-named starters plus the extended set', () => {
    const ids = LOOP_TEMPLATES.map((t) => t.id)
    // The three the loops-library spec names as examples …
    expect(ids).toEqual(expect.arrayContaining(['ship-and-green', 'verify-pass', 'ci-watch']))
    // … plus the extended quality/build/deploy starters.
    expect(ids).toEqual(expect.arrayContaining(['lint-and-fix', 'type-safe', 'coverage-climb', 'build-fix', 'deploy-check']))
  })

  it('ship-and-green uses the {{cmd:implement}} magic command (self-contained native invocation)', () => {
    const tpl = getLoopTemplate('ship-and-green')!
    const aiStep = tpl.graph.nodes.find((n) => n.type === 'ai-step')!
    expect(String(aiStep.data?.prompt)).toContain('{{cmd:implement}}')
  })

  it('verification is agent-driven — NO template hardcodes a Shell node', () => {
    for (const tpl of LOOP_TEMPLATES) {
      expect(tpl.graph.nodes.some((n) => n.type === 'shell'), `${tpl.id} should not use a Shell node`).toBe(false)
    }
  })

  it('ship-and-green chains implement → {{cmd:verify}} (agent verifies the tests)', () => {
    const tpl = getLoopTemplate('ship-and-green')!
    const aiPrompts = tpl.graph.nodes.filter((n) => n.type === 'ai-step').map((n) => String(n.data?.prompt))
    expect(aiPrompts[0]).toContain('{{cmd:implement}}')
    expect(aiPrompts.some((p) => p.includes('{{cmd:verify}}'))).toBe(true)
  })

  it('getLoopTemplate returns undefined for an unknown id', () => {
    expect(getLoopTemplate('nope')).toBeUndefined()
  })

  it('verify-loop templates reference the built-in {{const:VERIFICATION_PASS}} in their Decider goal', () => {
    for (const id of ['ship-and-green', 'verify-pass']) {
      const decider = getLoopTemplate(id)!.graph.nodes.find((n) => n.type === 'decider')!
      expect(String(decider.data?.goal), id).toContain('{{const:VERIFICATION_PASS}}')
    }
  })
})
