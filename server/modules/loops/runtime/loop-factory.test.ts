import { describe, it, expect } from 'vitest'
import {
  FACTORY_LOOPS, FACTORY_REVISION_LOOP_ID, RETIRED_FACTORY_LOOP_NAMES, RETIRED_FACTORY_REPLACEMENT_ID, canonicalFactoryLoopId,
  factoryLoopForMode, factoryLoopMode, factoryLoopsForCapabilities, getFactoryLoop, isFactoryLoopId, isRetiredFactoryLoopId,
} from './loop-factory'
import { validateLoopGraph } from './loop-graph'
import { assertDeciderBranches } from './loop-templates.test'

describe('factory loops', () => {
  it.each([['factory:implement', 'implement']])('%s runs its Core command once and ends without extra AI gates', (id, command) => {
    const graph = getFactoryLoop(id)!.graph
    expect(graph.nodes.map((node) => node.type)).toEqual(['start', 'ai-step', 'end'])
    expect(graph.nodes[1].data?.prompt).toBe(`{{cmd:${command}}}`)
    expect(graph.nodes[2].data?.outcome).toBe('success')
    expect(graph.edges.map(({ source, target }) => [source, target])).toEqual([
      ['start', 'main-1'], ['main-1', 'done'],
    ])
  })

  it('ships Implement as the only launchable built-in (Intent -> Spec is platform-run)', () => {
    expect(FACTORY_LOOPS.map((f) => f.id)).toEqual(['factory:implement'])
    expect(getFactoryLoop('factory:implement')?.mode).toBe('implement')
    // Removed Batch loop: the saved id resolves to Implement and is never listed.
    expect(getFactoryLoop('factory:batch')?.id).toBe('factory:implement')
    expect(getFactoryLoop('factory:batch')?.mode).toBe('implement')
    expect(FACTORY_LOOPS.some((f) => f.id === 'factory:batch' || (f.mode as string) === 'batch-implement')).toBe(false)
  })

  it('Freestyle and Quick SDD are retired: not listed, not resolvable, not selectable by mode', () => {
    for (const id of ['factory:freestyle', 'factory:sdd-quick-openspec', 'factory:openspec', FACTORY_REVISION_LOOP_ID]) {
      expect(isRetiredFactoryLoopId(id), id).toBe(true)
      expect(getFactoryLoop(id), id).toBeUndefined()
      expect(factoryLoopMode(id), id).toBeUndefined()
      expect(canonicalFactoryLoopId(id), id).toBeUndefined()
      expect(RETIRED_FACTORY_LOOP_NAMES[id], id).toBeTruthy()
    }
    expect(isRetiredFactoryLoopId('factory:implement')).toBe(false)
    expect(isRetiredFactoryLoopId('factory:batch')).toBe(false)
    expect(isRetiredFactoryLoopId(undefined)).toBe(false)
    expect(RETIRED_FACTORY_REPLACEMENT_ID).toBe('factory:implement')
    expect(factoryLoopsForCapabilities({ engineV2: 1, workflowDefinitions: 1 }).map((f) => f.id)).not.toContain('factory:freestyle')
  })

  it('no built-in needs a provider capability', () => {
    expect(getFactoryLoop('factory:implement')?.requiredCoreCapability).toBeUndefined()
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

  it('every factory loop runs UNTIMED (0 = no timeout; a legit implement must never be killed by wall clock)', () => {
    for (const f of FACTORY_LOOPS) {
      expect(f.graph.config.timeoutMinutes, f.id).toBe(0)
      expect(f.graph.config.aiStepTimeoutMinutes, f.id).toBe(0)
    }
  })

  it('id helpers recognise factory ids and map modes both ways', () => {
    expect(isFactoryLoopId('factory:implement')).toBe(true)
    expect(isFactoryLoopId('abc123')).toBe(false)
    expect(isFactoryLoopId(null)).toBe(false)
    expect(factoryLoopMode('factory:batch')).toBe('implement')
    expect(factoryLoopForMode('implement')?.id).toBe('factory:implement')
    expect(factoryLoopForMode('batch-implement')?.id).toBe('factory:implement')
    expect(factoryLoopForMode('batch')?.id).toBe('factory:implement')
    expect(factoryLoopForMode('freestyle')).toBeUndefined()
    expect(factoryLoopForMode('loop')).toBeUndefined()
  })
})

describe('retired Revision loop', () => {
  it('is absent from the gallery and no longer resolves (history only)', () => {
    expect(FACTORY_LOOPS.map((f) => f.id)).not.toContain(FACTORY_REVISION_LOOP_ID)
    expect(getFactoryLoop(FACTORY_REVISION_LOOP_ID)).toBeUndefined()
  })
})
