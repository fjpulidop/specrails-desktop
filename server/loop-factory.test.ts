import { describe, it, expect } from 'vitest'
import {
  FACTORY_LOOPS,
  getFactoryLoop,
  isFactoryLoopId,
  factoryLoopMode,
  factoryLoopForMode,
} from './loop-factory'
import { validateLoopGraph } from './loop-graph'
import { assertDeciderBranches } from './loop-templates.test'

describe('factory loops', () => {
  it('ships implement / batch / freestyle mapped to canonical rail modes + the graph-native openspec loop', () => {
    expect(FACTORY_LOOPS.map((f) => f.id)).toEqual(['factory:implement', 'factory:batch', 'factory:freestyle', 'factory:openspec'])
    expect(getFactoryLoop('factory:implement')?.mode).toBe('implement')
    expect(getFactoryLoop('factory:batch')?.mode).toBe('batch-implement')
    expect(getFactoryLoop('factory:freestyle')?.mode).toBe('freestyle')
    // Graph-native: no rail-mode fallback — runs only via the LoopRunManager.
    expect(getFactoryLoop('factory:openspec')?.mode).toBe('loop')
    expect(getFactoryLoop('factory:freestyle')?.name).toBe('Freestyle')
  })

  it('freestyle is claude-only; the others are not', () => {
    expect(getFactoryLoop('factory:freestyle')?.claudeOnly).toBe(true)
    expect(getFactoryLoop('factory:implement')?.claudeOnly).toBeUndefined()
  })

  it('every factory loop is a publishable graph', () => {
    for (const f of FACTORY_LOOPS) {
      expect(validateLoopGraph(f.graph).valid, `${f.id}: ${JSON.stringify(validateLoopGraph(f.graph).errors)}`).toBe(true)
    }
  })

  it('every factory Decider has exactly one continue + one stop branch', () => {
    for (const f of FACTORY_LOOPS) assertDeciderBranches(f.id, f.graph)
  })

  it('every factory loop uses the built-in {{const:VERIFICATION_PASS}} in its Decider goal', () => {
    for (const f of FACTORY_LOOPS) {
      const decider = f.graph.nodes.find((n) => n.type === 'decider')!
      expect(String(decider.data?.goal), f.id).toContain('{{const:VERIFICATION_PASS}}')
    }
  })

  it('factory goals describe an exit condition, not a claimed verification result', () => {
    for (const f of FACTORY_LOOPS.filter((loop) => loop.mode !== 'loop')) {
      const decider = f.graph.nodes.find((n) => n.type === 'decider')!
      const goal = String(decider.data?.goal ?? '')
      expect(goal, f.id).toContain('Stop only when')
      expect(goal, f.id).not.toMatch(/^The verification step reported/)
    }
  })

  it('the implement factory loop is an autonomous implement → verify → fix loop', () => {
    const prompts = getFactoryLoop('factory:implement')!.graph.nodes
      .filter((n) => n.type === 'ai-step')
      .map((n) => String(n.data?.prompt))
    expect(prompts[0]).toContain('{{cmd:implement}}')
    expect(prompts.some((p) => p.includes('{{cmd:verify}}'))).toBe(true)
    expect(prompts.some((p) => p.includes('{{cmd:fix}}'))).toBe(true) // refinement on failure
  })

  it('every rail-mode factory loop gets generous timeouts (pipeline-in-one-step needs headroom)', () => {
    for (const f of FACTORY_LOOPS) {
      if (f.mode === 'loop') continue // graph-native loops carry their own authored bounds
      expect(f.graph.config.timeoutMinutes, f.id).toBe(360)
      expect(f.graph.config.aiStepTimeoutMinutes, f.id).toBe(60)
    }
    // The openspec lifecycle keeps its own conservative bounds (3 passes max).
    expect(getFactoryLoop('factory:openspec')?.graph.config.maxIterations).toBe(3)
  })

  it('id helpers recognise factory ids and map modes both ways', () => {
    expect(isFactoryLoopId('factory:implement')).toBe(true)
    expect(isFactoryLoopId('abc123')).toBe(false)
    expect(isFactoryLoopId(null)).toBe(false)
    expect(factoryLoopMode('factory:batch')).toBe('batch-implement')
    expect(factoryLoopForMode('freestyle')?.id).toBe('factory:freestyle')
    expect(factoryLoopForMode('loop')).toBeUndefined()
  })
})
