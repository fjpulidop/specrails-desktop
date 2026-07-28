import { describe, it, expect } from 'vitest'
import { FACTORY_LOOPS, getFactoryLoop, isFactoryLoopId, factoryLoopMode, factoryLoopForMode, FACTORY_REVISION_LOOP_ID } from './loop-factory'
import { validateLoopGraph } from './loop-graph'
import { assertDeciderBranches } from './loop-templates.test'

describe('factory loops', () => {
  it('ships implement / batch / freestyle mapped to canonical rail modes + the graph-native openspec loop', () => {
    expect(FACTORY_LOOPS.map((f) => f.id)).toEqual([
      'factory:implement', 'factory:batch', 'factory:freestyle',
      'factory:revision', 'factory:sdd-quick-openspec',
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

describe('factory revision loop (nontech-review-experience)', () => {
  it('is listed for discovery but marked NOT launchable', () => {
    // Visible so the platform's behaviour is discoverable (preview/fork), yet it
    // has no launch path: the app runs it when a user asks for a change, and its
    // prompt consumes a constant only a revision launch injects.
    expect(getFactoryLoop(FACTORY_REVISION_LOOP_ID)).toBeDefined()
    expect(FACTORY_LOOPS.map((f) => f.id)).toContain(FACTORY_REVISION_LOOP_ID)
    expect(getFactoryLoop(FACTORY_REVISION_LOOP_ID)?.launchable).toBe(false)
    expect(isFactoryLoopId(FACTORY_REVISION_LOOP_ID)).toBe(true)
  })

  it('is the ONLY non-launchable factory loop', () => {
    const nonLaunchable = FACTORY_LOOPS.filter((f) => f.launchable === false).map((f) => f.id)
    expect(nonLaunchable).toEqual([FACTORY_REVISION_LOOP_ID])
  })

  it('is never picked as the loop for a legacy rail mode', () => {
    for (const mode of ['implement', 'batch-implement', 'freestyle', 'loop']) {
      expect(factoryLoopForMode(mode)?.id).not.toBe(FACTORY_REVISION_LOOP_ID)
    }
  })

  it('says in its own description that it is not started by hand', () => {
    expect(getFactoryLoop(FACTORY_REVISION_LOOP_ID)?.description).toMatch(/not started by hand/i)
  })

  it('runs the revise step and NO architect/implement pipeline step', () => {
    const graph = getFactoryLoop(FACTORY_REVISION_LOOP_ID)!.graph
    const prompts = graph.nodes
      .filter((n) => n.type === 'ai-step')
      .map((n) => String((n.data as { prompt?: string })?.prompt ?? ''))
      .join('\n')
    expect(prompts).toContain('{{cmd:revise}}')
    expect(prompts).not.toContain('{{cmd:implement}}')
    expect(prompts).not.toContain('{{cmd:batch}}')
  })

  it('still verifies: the graph closes on a verify step + decider', () => {
    const graph = getFactoryLoop(FACTORY_REVISION_LOOP_ID)!.graph
    const prompts = graph.nodes
      .filter((n) => n.type === 'ai-step')
      .map((n) => String((n.data as { prompt?: string })?.prompt ?? ''))
      .join('\n')
    // Verification scope is never silently narrowed for a revision.
    expect(prompts).toContain('{{cmd:verify}}')
    expect(graph.nodes.some((n) => n.type === 'decider')).toBe(true)
  })

  it('is a graph-native loop (runs through the loop engine, not QueueManager)', () => {
    expect(getFactoryLoop(FACTORY_REVISION_LOOP_ID)!.mode).toBe('loop')
  })
})
