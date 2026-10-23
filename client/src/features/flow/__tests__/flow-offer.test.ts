import { describe, expect, it } from 'vitest'
import { flowCostDisplay, missingCapabilityKeys, otherMode, parseFlowOffer } from '../lib/flow-offer'
import { flowRepositoryChoice } from '../lib/flow-api'
import boundaries from '../../boundaries.json'

describe('flow-offer protocol', () => {
  it('normalizes a valid offer and drops unusable ones', () => {
    expect(parseFlowOffer({ idea: '  Try a calmer dashboard ', reason: 'Visual', recommended: 'flow', title: 'Calm' }))
      .toEqual({ idea: 'Try a calmer dashboard', reason: 'Visual', recommended: 'flow', title: 'Calm', repositoryId: null })
    expect(parseFlowOffer({ idea: 'x', recommended: 'implement' })).toEqual({ idea: 'x', reason: null, recommended: 'implement', title: null, repositoryId: null })
    expect(parseFlowOffer({ idea: '', recommended: 'flow' })).toBeNull()
    expect(parseFlowOffer({ idea: 'x', recommended: 'spike' })).toBeNull()
    expect(parseFlowOffer(['x'])).toBeNull()
    expect(parseFlowOffer(null)).toBeNull()
    expect(otherMode('flow')).toBe('implement')
    expect(otherMode('implement')).toBe('flow')
  })

  it('keeps the agent\'s repository triage (workspace / multi-repository projects)', () => {
    expect(parseFlowOffer({ idea: 'Rate-limit the API', recommended: 'flow', repositoryId: ' api ' })).toMatchObject({ repositoryId: 'api' })
    expect(parseFlowOffer({ idea: 'x', recommended: 'flow', repositoryId: '' })).toMatchObject({ repositoryId: null })
    expect(parseFlowOffer({ idea: 'x', recommended: 'flow', repositoryId: 42 })).toMatchObject({ repositoryId: null })
    expect(parseFlowOffer({ idea: 'x', recommended: 'flow', repositoryId: 'r'.repeat(201) })).toMatchObject({ repositoryId: null })
  })

  it('shows the repository choice only for a workspace or several Git repositories', () => {
    const repo = (id: string, kind: 'git' | 'folder', isPrimary = false, available?: boolean) => ({ id, name: id, path: `/${id}`, kind, isPrimary, ...(available === undefined ? {} : { available }) })
    expect(flowRepositoryChoice([repo('app', 'git', true)])).toEqual({ show: false, candidates: [repo('app', 'git', true)], fallback: 'app' })
    expect(flowRepositoryChoice([repo('app', 'git', true), repo('notes', 'folder')])).toMatchObject({ show: false, fallback: 'app' })
    expect(flowRepositoryChoice([repo('core', 'git', true), repo('web', 'git')])).toMatchObject({ show: true, fallback: 'core' })
    expect(flowRepositoryChoice([repo('ws', 'folder', true), repo('api', 'git')])).toMatchObject({ show: true, fallback: 'api' })
    expect(flowRepositoryChoice([repo('ws', 'folder', true), repo('api', 'git'), repo('web', 'git')])).toMatchObject({ show: true, fallback: null })
    expect(flowRepositoryChoice([repo('ws', 'folder', true), repo('api', 'git', false, false)])).toMatchObject({ show: true, candidates: [], fallback: null })
  })

  it('maps missing Core capabilities to friendly i18n keys', () => {
    expect(missingCapabilityKeys(['flowSessions', 'deriveChange'])).toEqual(['flow.missing.flowSessions', 'flow.missing.deriveChange'])
  })

  it('shows only real cost: — until a turn is priced, partial when some are not', () => {
    expect(flowCostDisplay(null)).toEqual({ usd: null, partial: false })
    expect(flowCostDisplay({ flowId: 'f', costUsd: 0, turns: 0, unpricedTurns: 0 })).toEqual({ usd: null, partial: false })
    expect(flowCostDisplay({ flowId: 'f', costUsd: 0, turns: 2, unpricedTurns: 2 })).toEqual({ usd: null, partial: true })
    expect(flowCostDisplay({ flowId: 'f', costUsd: 0.42, turns: 3, unpricedTurns: 1 })).toEqual({ usd: '$0.420', partial: true })
    expect(flowCostDisplay({ flowId: 'f', costUsd: 2.5, turns: 3, unpricedTurns: 0 })).toEqual({ usd: '$2.50', partial: false })
  })
})

describe('feature boundaries', () => {
  it('flow depends on missions; missions never depend on flow', () => {
    const manifest = boundaries as Record<string, { dependencies: string[] }>
    expect(manifest.flow.dependencies).toContain('missions')
    expect(manifest.missions.dependencies).not.toContain('flow')
    for (const [name, entry] of Object.entries(manifest)) {
      if (name !== 'flow') expect(entry.dependencies, name).not.toContain('flow')
    }
  })
})
