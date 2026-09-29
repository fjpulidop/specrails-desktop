import { describe, it, expect } from 'vitest'
import { LOOP_TEMPLATES, LOOP_CATEGORIES, CORE_STARTER_TEMPLATE_IDS, getLoopTemplate, fixLoopGraph } from './loop-templates'
import { validateLoopGraph, type LoopGraph } from './loop-graph'
import { LOOP_COMMANDS } from './loop-command-catalog'
import { BUILTIN_CONSTANTS } from './loop-constants'

/** All text a template carries (prompts / goals / commands) — for token scans. */
function templateText(graph: LoopGraph): string {
  return graph.nodes
    .map((n) => [n.data?.prompt, n.data?.goal, n.data?.command].filter((v) => typeof v === 'string').join('\n'))
    .join('\n')
}
const KNOWN_CMDS = new Set(LOOP_COMMANDS.map((c) => c.name))
const KNOWN_CONSTS = new Set(Object.keys(BUILTIN_CONSTANTS))
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

  it('ships exactly the Core-native starters (no legacy-only templates)', () => {
    expect(LOOP_TEMPLATES.map((t) => t.id)).toEqual([...CORE_STARTER_TEMPLATE_IDS])
    expect(getLoopTemplate('opsx-lifecycle')).toBeUndefined()
    expect(getLoopTemplate('autoloop-tdd')).toBeUndefined()
  })

  it('every template has a category within the taxonomy', () => {
    const allowed = new Set<string>(LOOP_CATEGORIES)
    for (const t of LOOP_TEMPLATES) {
      expect(allowed.has(t.category), `${t.id}: category "${t.category}" not in taxonomy`).toBe(true)
    }
  })

  it('uses only known {{cmd:*}} and {{const:*}} tokens (no invented/typo tokens)', () => {
    for (const t of LOOP_TEMPLATES) {
      const text = templateText(t.graph)
      for (const m of text.matchAll(/\{\{cmd:([\w-]+)\}\}/g)) {
        expect(KNOWN_CMDS.has(m[1]), `${t.id}: unknown command {{cmd:${m[1]}}}`).toBe(true)
      }
      for (const m of text.matchAll(/\{\{const:([A-Za-z0-9_.-]+)\}\}/g)) {
        expect(KNOWN_CONSTS.has(m[1]), `${t.id}: unknown constant {{const:${m[1]}}}`).toBe(true)
      }
    }
  })

  it('a Decider goal that demands VERIFICATION_PASS is backed by a step that emits the sentinel', () => {
    // The contract: if the Decider goal drags {{const:VERIFICATION_PASS}}, some
    // step must actually END with that sentinel — otherwise the Decider can never
    // confirm "done", loops to its iteration/timeout cap, and settles as FAILED
    // even when the work is complete. (Regression: pr-self-review used {{cmd:review}},
    // which does not emit the sentinel, so it never converged.)
    const SENTINEL_CMDS = new Set(['test', 'lint', 'typecheck', 'build', 'coverage', 'format', 'verify'])
    const emitsSentinel = (graph: LoopGraph): boolean => {
      for (const n of graph.nodes) {
        if (n.type !== 'ai-step') continue
        const p = String(n.data?.prompt ?? '')
        if (p.includes('VERIFICATION_PASS') || p.includes('VERIFICATION: PASS')) return true
        for (const m of p.matchAll(/\{\{cmd:([\w-]+)\}\}/g)) if (SENTINEL_CMDS.has(m[1])) return true
      }
      return false
    }
    for (const tpl of LOOP_TEMPLATES) {
      const goalDemandsSentinel = tpl.graph.nodes.some(
        (n) => n.type === 'decider' && String(n.data?.goal ?? '').includes('VERIFICATION_PASS')
      )
      if (goalDemandsSentinel) {
        expect(
          emitsSentinel(tpl.graph),
          `${tpl.id}: Decider goal demands VERIFICATION_PASS but no step emits it — the loop can never converge`
        ).toBe(true)
      }
    }
  })

  it('verify-loop templates reference the built-in {{const:VERIFICATION_PASS}} in their Decider goal', () => {
    for (const id of ['ship-and-green', 'verify-pass']) {
      const decider = getLoopTemplate(id)!.graph.nodes.find((n) => n.type === 'decider')!
      expect(String(decider.data?.goal), id).toContain('{{const:VERIFICATION_PASS}}')
    }
  })
})


describe('fixLoopGraph — configurable verification gate', () => {
  const goal = 'stop when green'

  it('defaults to the generic verify command, unchanged for every existing caller', () => {
    const graph = fixLoopGraph(['{{cmd:implement}}'], goal)
    const verify = graph.nodes.find((n) => n.id === 'verify')
    expect(verify?.data?.prompt).toBe('{{cmd:verify}}')
    expect(verify?.data?.freshSession).toBeUndefined()
    expect(graph.nodes.find((n) => n.id === 'fix')?.data?.freshSession).toBeUndefined()
  })

  it('swaps the gate prompt while KEEPING the node id `verify`', () => {
    const graph = fixLoopGraph(['{{cmd:revise}}'], goal, 12, 30, undefined, '{{cmd:revision-verify}}')
    const verify = graph.nodes.find((n) => n.id === 'verify')
    expect(verify?.data?.prompt).toBe('{{cmd:revision-verify}}')
    // The id is the contract: the Decider edge, the sentinel scan and the
    // evidence harvest all key off it.
    expect(graph.edges.some((e) => e.source === 'verify' && e.target === 'decide')).toBe(true)
    expect(graph.edges.some((e) => e.source === 'fix' && e.target === 'verify')).toBe(true)
    expect(validateLoopGraph(graph).valid).toBe(true)
  })

  it('marks verify AND fix as freshSession only when the cycle is isolated', () => {
    const isolated = fixLoopGraph(['{{cmd:revise}}'], goal, 12, 30, undefined, '{{cmd:x}}', true)
    expect(isolated.nodes.find((n) => n.id === 'verify')?.data?.freshSession).toBe(true)
    expect(isolated.nodes.find((n) => n.id === 'fix')?.data?.freshSession).toBe(true)
    // The mutating step keeps the run's own session.
    expect(isolated.nodes.find((n) => n.id === 'main-1')?.data?.freshSession).toBeUndefined()

    const shared = fixLoopGraph(['{{cmd:revise}}'], goal, 12, 30, undefined, '{{cmd:x}}', false)
    expect(shared.nodes.find((n) => n.id === 'verify')?.data?.freshSession).toBeUndefined()
    expect(shared.nodes.find((n) => n.id === 'fix')?.data?.freshSession).toBeUndefined()
  })

  it('keeps the graph shape identical regardless of the gate prompt', () => {
    const generic = fixLoopGraph(['{{cmd:implement}}'], goal)
    const custom = fixLoopGraph(['{{cmd:implement}}'], goal, 12, 30, undefined, '{{cmd:revision-verify}}', true)
    expect(custom.nodes.map((n) => n.id)).toEqual(generic.nodes.map((n) => n.id))
    expect(custom.edges).toEqual(generic.edges)
  })
})
