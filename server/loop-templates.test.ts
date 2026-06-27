import { describe, it, expect } from 'vitest'
import { LOOP_TEMPLATES, LOOP_CATEGORIES, getLoopTemplate, compilePortSpec } from './loop-templates'
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
// Commands whose expansion embeds {{const:GUARDRAILS}} (the anti-gaming contract).
const GUARDRAIL_CMDS = new Set(['test', 'lint', 'typecheck', 'build', 'coverage', 'format', 'audit', 'docs-sync', 'review'])
function referencesGuardrails(graph: LoopGraph): boolean {
  const text = templateText(graph)
  if (text.includes('{{const:GUARDRAILS}}')) return true
  for (const m of text.matchAll(/\{\{cmd:([\w-]+)\}\}/g)) if (GUARDRAIL_CMDS.has(m[1])) return true
  return false
}

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

  it('ships a broad catalog (>= 40 templates)', () => {
    expect(LOOP_TEMPLATES.length).toBeGreaterThanOrEqual(40)
  })

  it('every template has a category within the taxonomy', () => {
    const allowed = new Set<string>(LOOP_CATEGORIES)
    for (const t of LOOP_TEMPLATES) {
      expect(allowed.has(t.category), `${t.id}: category "${t.category}" not in taxonomy`).toBe(true)
    }
  })

  it('every taxonomy category is represented by at least one template', () => {
    const present = new Set(LOOP_TEMPLATES.map((t) => t.category))
    for (const cat of LOOP_CATEGORIES) {
      expect(present.has(cat), `no template in category "${cat}"`).toBe(true)
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

  it('compilePortSpec loopBack="first" routes the Decider continue edge back to the FIRST step', () => {
    const tpl = compilePortSpec({ id: 'x', name: 'X', description: 'd', category: 'Testing', tags: ['t'], steps: ['a', 'b', 'c'], goal: 'g', loopBack: 'first' })
    const decider = tpl.graph.nodes.find((n) => n.type === 'decider')!
    const cont = tpl.graph.edges.find((e) => e.source === decider.id && e.branch === 'continue')!
    const firstAi = tpl.graph.nodes.find((n) => n.type === 'ai-step')!
    expect(cont.target).toBe(firstAi.id)
    expect(validateLoopGraph(tpl.graph).valid).toBe(true)
    // contrast: loopBack='last' loops to the LAST step
    const lastTpl = compilePortSpec({ id: 'y', name: 'Y', description: 'd', category: 'Testing', tags: ['t'], steps: ['a', 'b', 'c'], goal: 'g', loopBack: 'last' })
    const lastDec = lastTpl.graph.nodes.find((n) => n.type === 'decider')!
    const lastCont = lastTpl.graph.edges.find((e) => e.source === lastDec.id && e.branch === 'continue')!
    expect(lastCont.target).toBe(lastTpl.graph.nodes.filter((n) => n.type === 'ai-step').at(-1)!.id)
  })

  it('autoloop-tdd enforces strict one-behavior-per-pass TDD (continue → first, no front-loading)', () => {
    const tpl = getLoopTemplate('autoloop-tdd')!
    const g = tpl.graph
    const aiNodes = g.nodes.filter((n) => n.type === 'ai-step')
    const decider = g.nodes.find((n) => n.type === 'decider')!
    const cont = g.edges.find((e) => e.source === decider.id && e.branch === 'continue')!
    // each pass re-runs the WHOLE body from step 1 to pick the next behavior
    expect(cont.target).toBe(aiNodes[0].id)
    const steps = aiNodes.map((n) => String(n.data?.prompt ?? ''))
    const joined = steps.join('\n')
    // red → green → refactor discipline
    expect(joined).toMatch(/TDD RED/)
    expect(joined).toMatch(/TDD GREEN/)
    expect(joined).toMatch(/TDD REFACTOR/)
    // single-item discipline injected into EVERY step
    expect(steps.every((s) => s.includes('{{const:ONE_PER_PASS}}'))).toBe(true)
    // completeness is judged by the Decider via a REMAINING report — NOT by the
    // trivially-green {{cmd:test}} sentinel (which caused premature stops)
    expect(joined).toContain('REMAINING:')
    expect(g.nodes.every((n) => !String(n.data?.prompt ?? '').includes('{{cmd:test}}'))).toBe(true)
    // generous timeout for many strict passes
    expect(g.config.timeoutMinutes).toBeGreaterThanOrEqual(60)
  })

  it('one-item-per-pass loops carry the ONE_PER_PASS discipline so the agent cannot front-load', () => {
    for (const id of ['autoloop-tdd', 'spec-first-ship', 'ralph-story-executor', 'dependency-upgrade-one-by-one', 'npm-audit-fix-loop']) {
      const text = getLoopTemplate(id)!.graph.nodes.map((n) => String(n.data?.prompt ?? '')).join('\n')
      expect(text, `${id} must inject {{const:ONE_PER_PASS}}`).toContain('{{const:ONE_PER_PASS}}')
    }
  })

  it('compilePortSpec honors a custom timeoutMinutes (default 30)', () => {
    const base = { id: 'z', name: 'Z', description: 'd', category: 'Testing' as const, tags: ['t'], steps: ['a'], goal: 'g' }
    expect(compilePortSpec(base).graph.config.timeoutMinutes).toBe(30)
    expect(compilePortSpec({ ...base, timeoutMinutes: 60 }).graph.config.timeoutMinutes).toBe(60)
    expect(compilePortSpec({ ...base, loopBack: 'verify', timeoutMinutes: 45 }).graph.config.timeoutMinutes).toBe(45)
  })

  it('iterate-until-complete loops re-run the WHOLE body each pass (continue → first step)', () => {
    // These templates process one item per pass (a behavior / requirement / story
    // / package / advisory / CI failure / endpoint), so the Decider's "continue"
    // MUST return to the first step to re-pick — not just re-run the last step.
    const ITERATE_LOOPS = [
      'autoloop-tdd', 'spec-first-ship', 'ralph-story-executor',
      'dependency-upgrade-one-by-one', 'npm-audit-fix-loop',
      'fix-ci-until-green', 'deploy-verification-loop',
    ]
    for (const id of ITERATE_LOOPS) {
      const g = getLoopTemplate(id)!.graph
      const ai = g.nodes.filter((n) => n.type === 'ai-step').map((n) => n.id)
      const decider = g.nodes.find((n) => n.type === 'decider')!
      const cont = g.edges.find((e) => e.source === decider.id && e.branch === 'continue')!
      expect(cont.target, `${id}: continue edge must return to the first step`).toBe(ai[0])
    }
  })

  it('injects the guardrails anti-gaming contract across the ported catalog', () => {
    // Read-only poll/audit loops legitimately omit it, but the bulk of the
    // mutating starters must carry the guardrails contract.
    const withGuardrails = LOOP_TEMPLATES.filter((t) => referencesGuardrails(t.graph))
    expect(withGuardrails.length).toBeGreaterThanOrEqual(15)
  })

  it('verify-loop templates reference the built-in {{const:VERIFICATION_PASS}} in their Decider goal', () => {
    for (const id of ['ship-and-green', 'verify-pass']) {
      const decider = getLoopTemplate(id)!.graph.nodes.find((n) => n.type === 'decider')!
      expect(String(decider.data?.goal), id).toContain('{{const:VERIFICATION_PASS}}')
    }
  })
})
