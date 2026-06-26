import { describe, it, expect } from 'vitest'
import { LOOP_TEMPLATES, LOOP_CATEGORIES, getLoopTemplate } from './loop-templates'
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
