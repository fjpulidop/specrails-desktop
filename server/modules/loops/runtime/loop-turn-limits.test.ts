import { describe, expect, it } from 'vitest'
import { configurableImplementGraph, IMPLEMENT_WRITE_ROLE_MAX_TURNS } from './loop-implement-recipe'
import { CORE_DEFAULT_MAX_TURNS, loopTurnLimits, withTurnLimitHint } from './loop-turn-limits'

describe('loop turn limits', () => {
  it('maps every Implement AI step to its role and effective ceiling', () => {
    const limits = loopTurnLimits(configurableImplementGraph({ openRoles: 1 }))
    expect(limits.map(({ stepId, role, maxTurns, source }) => ({ stepId, role, maxTurns, source }))).toEqual([
      { stepId: 'architect', role: 'plan', maxTurns: CORE_DEFAULT_MAX_TURNS, source: 'core-default' },
      { stepId: 'developer', role: 'build', maxTurns: IMPLEMENT_WRITE_ROLE_MAX_TURNS, source: 'role' },
      { stepId: 'reviewer', role: 'assess', maxTurns: CORE_DEFAULT_MAX_TURNS, source: 'core-default' },
      { stepId: 'fixer', role: 'correct', maxTurns: IMPLEMENT_WRITE_ROLE_MAX_TURNS, source: 'role' },
    ])
  })

  it('reads an edited role, a step engine override and nested components', () => {
    const graph = configurableImplementGraph({ openRoles: 1 })
    graph.config.agents!.roles!.build.maxTurns = 1000
    graph.nodes.push({ id: 'fix', type: 'core', position: { x: 0, y: 0 }, data: { kind: 'prompt', label: 'Fix', params: { text: 'x', engine: { maxTurns: 40 } } } })
    graph.components = { review: { nodes: [{ id: 'audit', type: 'core', position: { x: 0, y: 0 }, data: { kind: 'role-turn', params: { roleId: 'assess' } } }], edges: [], config: {} as never } }
    const byStep = Object.fromEntries(loopTurnLimits(graph).map(limit => [limit.stepId, limit]))
    expect(byStep.developer).toMatchObject({ role: 'build', maxTurns: 1000, source: 'role' })
    expect(byStep.fix).toMatchObject({ role: 'fixer', maxTurns: 40, source: 'step', label: 'Fix' })
    expect(byStep.audit).toMatchObject({ role: 'assess', maxTurns: CORE_DEFAULT_MAX_TURNS })
  })

  it('points a turn-limit failure at the loop step, not project settings', () => {
    const core = 'claude reached the configured limit of 100 turns for build. Inspect partial changes before recovery; a higher limit requires a new run configuration.'
    const hinted = withTurnLimitHint(core, 'developer')
    expect(hinted.startsWith(core)).toBe(true)
    expect(hinted).toContain('Loops ▸ this loop ▸ select the "developer" step ▸ "Maximum turns" (role "build", currently 100), save and publish.')
    expect(hinted).toContain('Project Settings do not change loop runs.')
    expect(withTurnLimitHint(core)).toContain('the step that runs role "build"')
    expect(withTurnLimitHint('verification failed')).toBe('verification failed')
  })
})
