import { configurableImplementGraph } from './loop-implement-recipe'
import { defaultLoopAgents } from './loop-agents'
import type { CoreNodeKind, LoopGraph, LoopNode } from './loop-graph'

/** App-owned definition graphs. Core supplies schemas, execution and canonical versions. */
export function coreFactoryGraph(mode: 'implement' | 'freestyle' | 'quick-sdd', independent = false, configurable = false): LoopGraph {
  if (mode === 'implement' && configurable) return configurableImplementGraph()
  const nodes: LoopNode[] = [{ id: 'start', type: 'start', position: { x: 0, y: 0 } }]
  const edges: LoopGraph['edges'] = []
  const config: LoopGraph['config'] = { maxIterations: 12, maxTransitions: 120, timeoutMinutes: 0, aiStepTimeoutMinutes: 0,
    journal: mode === 'implement' ? 'implementation' : 'ledger-only', change: mode === 'freestyle' ? 'none' : 'new' }
  const node = (id: string, kind: CoreNodeKind, params: Record<string, unknown>, outcomes: Record<string, string>) => {
    nodes.push({ id, type: 'core', position: { x: 0, y: nodes.length * 120 }, data: { kind, params } })
    for (const [label, target] of Object.entries(outcomes)) edges.push({ id: `e-${id}-${label}`, source: id, target, label })
  }
  const next = (id: string) => ({ next: id, failed: 'failed' })
  const promptNext = (id: string) => ({ ...next(id), blocked: 'failed' })
  const verify = (id: string, passed = 'done', failed = 'failed') => node(id, 'verify', { commands: 'configured' }, { pass: passed, fail: failed, failed: 'failed' })
  if (independent) config.agents = defaultLoopAgents(mode === 'freestyle' ? 'free' : 'implementation')
  let entry: string
  if (mode === 'implement') {
    if (independent) {
      entry = 'architect'
      for (const [phase, next] of Object.entries({ architect: 'developer', developer: 'verify', fixer: 'verify', verify: 'reviewer', reviewer: 'archive', archive: 'done' })) {
        node(phase, 'implementation-step', { phase }, { next, incomplete: 'developer', rejected: 'fixer', replan: 'architect', reverify: 'verify', rereview: 'reviewer', failed: 'failed' })
        nodes.at(-1)!.data!.label = phase.charAt(0).toUpperCase() + phase.slice(1)
        nodes.at(-1)!.position = phase === 'fixer' ? { x: 360, y: 360 } : { x: 0, y: (['architect', 'developer', 'verify', 'reviewer', 'archive'].indexOf(phase) + 1) * 140 }
      }
    } else { entry = 'implement'; node(entry, 'implementation', {}, { next: 'done', rejected: 'failed', failed: 'failed' }) }
  } else if (mode === 'quick-sdd') {
    entry = 'prepare'
    node('prepare', 'prompt', { nativeCommand: { id: 'opsx:ff', args: '{{run.changeId}}' }, access: 'write', sentinel: 'blocked' }, promptNext('validate'))
    node('validate', 'openspec-validate', { change: '{{run.changeId}}' }, { pass: 'apply', fail: 'failed', failed: 'failed' })
    node('apply', 'prompt', { nativeCommand: { id: 'opsx:apply', args: '{{run.changeId}}' }, access: 'write', sentinel: 'blocked' }, promptNext('check'))
    verify('check', 'archive')
    node('archive', 'openspec-archive', { change: '{{run.changeId}}' }, next('verify'))
    verify('verify')
  } else {
    entry = 'implement'
    node('implement', 'prompt', { text: '{{cmd:freestyle}}', access: 'write', sentinel: 'blocked' }, promptNext('verify'))
    verify('verify', 'decide', 'fix')
    node('decide', 'decider', { roleId: 'loop-decider', goal: 'Stop only when actual behavioral evidence proves every frozen acceptance criterion is implemented across every selected ticket and repository. Passing baseline checks alone is insufficient.', noProgress: 3 }, { continue: 'fix', stop: 'done', failed: 'failed' })
    node('fix', 'prompt', { text: '{{cmd:fix}}', access: 'write', sentinel: 'blocked' }, promptNext('verify'))
  }
  edges.unshift({ id: 'e-start', source: 'start', target: entry })
  nodes.push({ id: 'done', type: 'end', position: { x: 0, y: nodes.length * 120 }, data: { outcome: 'success', requiresVerified: true } },
    { id: 'failed', type: 'end', position: { x: 320, y: nodes.length * 120 }, data: { outcome: 'failure' } })
  return { nodes, edges, config }
}
