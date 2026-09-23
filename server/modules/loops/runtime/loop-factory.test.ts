import { describe, it, expect } from 'vitest'
import { FACTORY_LOOPS, getFactoryLoop, isFactoryLoopId, factoryLoopMode, factoryLoopForMode, FACTORY_REVISION_LOOP_ID } from './loop-factory'
import { validateLoopGraph } from './loop-graph'
import { assertDeciderBranches } from './loop-templates.test'

describe('factory loops', () => {
  it.each([['factory:implement', 'implement'], ['factory:batch', 'batch']])('%s runs its Core command once and ends without extra AI gates', (id, command) => {
    const graph = getFactoryLoop(id)!.graph
    expect(graph.nodes.map((node) => node.type)).toEqual(['start', 'ai-step', 'end'])
    expect(graph.nodes[1].data?.prompt).toBe(`{{cmd:${command}}}`)
    expect(graph.nodes[2].data?.outcome).toBe('success')
    expect(graph.edges.map(({ source, target }) => [source, target])).toEqual([
      ['start', 'main-1'], ['main-1', 'done'],
    ])
  })

  it('ships implement / batch / freestyle mapped to canonical rail modes + the graph-native openspec loop', () => {
    expect(FACTORY_LOOPS.map((f) => f.id)).toEqual([
      'factory:implement', 'factory:batch', 'factory:freestyle',
      'factory:sdd-quick-openspec',
    ])
    expect(getFactoryLoop('factory:implement')?.mode).toBe('implement')
    expect(getFactoryLoop('factory:batch')?.mode).toBe('batch-implement')
    expect(getFactoryLoop('factory:freestyle')?.mode).toBe('freestyle')
    // Graph-native: no rail-mode fallback — runs only via the LoopRunManager.
    expect(getFactoryLoop('factory:sdd-quick-openspec')?.mode).toBe('loop')
    expect(getFactoryLoop('factory:sdd-quick-openspec')?.name).toBe('SDD Quick (OpenSpec)')
    expect(getFactoryLoop('factory:openspec')?.mode).toBe('loop')
    expect(FACTORY_LOOPS.some((f) => f.id === 'factory:openspec')).toBe(false)
    expect(getFactoryLoop('factory:freestyle')?.name).toBe('Freestyle')
  })

  it('gates freestyle on provider capability; the others need none', () => {
    expect(getFactoryLoop('factory:freestyle')?.requiredCapability).toBe('freestyle')
    expect(getFactoryLoop('factory:implement')?.requiredCapability).toBeUndefined()
  })

  it('every factory loop is a publishable graph', () => {
    for (const f of FACTORY_LOOPS) {
      expect(validateLoopGraph(f.graph).valid, `${f.id}: ${JSON.stringify(validateLoopGraph(f.graph).errors)}`).toBe(true)
    }
  })

  it('every factory Decider has exactly one continue + one stop branch', () => {
    for (const f of FACTORY_LOOPS) assertDeciderBranches(f.id, f.graph)
  })

  it('every factory Decider uses the built-in {{const:VERIFICATION_PASS}} in its goal', () => {
    for (const f of FACTORY_LOOPS) {
      const decider = f.graph.nodes.find((n) => n.type === 'decider')
      if (!decider) continue
      expect(String(decider.data?.goal), f.id).toContain('{{const:VERIFICATION_PASS}}')
    }
  })

  it('factory goals describe an exit condition, not a claimed verification result', () => {
    for (const f of FACTORY_LOOPS) {
      const decider = f.graph.nodes.find((n) => n.type === 'decider')
      if (!decider) continue
      const goal = String(decider.data?.goal ?? '')
      expect(goal, f.id).toContain('Stop only when')
      expect(goal, f.id).not.toMatch(/^The verification step reported/)
      expect(goal, f.id).not.toMatch(/^The verify step reported/)
      expect(goal, f.id).toContain('baseline')
    }
  })

  it('freestyle retains its verify → fix cycle', () => {
    const prompts = getFactoryLoop('factory:freestyle')!.graph.nodes
      .filter((n) => n.type === 'ai-step')
      .map((n) => String(n.data?.prompt))
    expect(prompts[0]).toContain('{{cmd:freestyle}}')
    expect(prompts.some((p) => p.includes('{{cmd:verify}}'))).toBe(true)
    expect(prompts.some((p) => p.includes('{{cmd:fix}}'))).toBe(true) // refinement on failure
  })

  it('every factory loop runs UNTIMED (0 = no timeout; a legit implement must never be killed by wall clock)', () => {
    for (const f of FACTORY_LOOPS) {
      expect(f.graph.config.timeoutMinutes, f.id).toBe(0)
      expect(f.graph.config.aiStepTimeoutMinutes, f.id).toBe(0)
    }
    // The openspec lifecycle keeps its own conservative iteration bound (3 passes max).
    expect(getFactoryLoop('factory:sdd-quick-openspec')?.graph.config.maxIterations).toBe(3)
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

describe('retired Revision loop', () => {
  it('is absent from the gallery and redirects saved ids to Quick SDD', () => {
    expect(FACTORY_LOOPS.map((f) => f.id)).not.toContain(FACTORY_REVISION_LOOP_ID)
    expect(getFactoryLoop(FACTORY_REVISION_LOOP_ID)).toBe(getFactoryLoop('factory:sdd-quick-openspec'))
    expect(getFactoryLoop(FACTORY_REVISION_LOOP_ID)?.graph.nodes.some((n) => String(n.data?.prompt).includes('{{cmd:revise}}'))).toBe(false)
  })
})
