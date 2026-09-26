import type { CoreNodeKind, LoopGraph, LoopNode } from './loop-graph'

/** App-owned definition graphs. Core supplies schemas, execution and canonical versions. */
export function coreFactoryGraph(mode: 'implement' | 'batch' | 'freestyle' | 'quick-sdd'): LoopGraph {
  const nodes: LoopNode[] = [{ id: 'start', type: 'start', position: { x: 0, y: 0 } }]
  const edges: LoopGraph['edges'] = []
  const config: LoopGraph['config'] = { maxIterations: 12, maxTransitions: mode === 'batch' ? 1000 : 120, timeoutMinutes: 0, aiStepTimeoutMinutes: 0,
    journal: ['implement', 'batch'].includes(mode) ? 'implementation' : 'ledger-only', change: mode === 'freestyle' ? 'none' : 'new' }
  const node = (id: string, kind: CoreNodeKind, params: Record<string, unknown>, outcomes: Record<string, string>) => {
    nodes.push({ id, type: 'core', position: { x: 0, y: nodes.length * 120 }, data: { kind, params } })
    for (const [label, target] of Object.entries(outcomes)) edges.push({ id: `e-${id}-${label}`, source: id, target, label })
  }
  const next = (id: string) => ({ next: id, failed: 'failed' })
  const verify = (id: string, passed = 'done', failed = 'failed') => node(id, 'verify', { commands: 'configured' }, { pass: passed, fail: failed, failed: 'failed' })
  let entry: string, components: LoopGraph['components']
  if (mode === 'implement') {
    entry = 'implement'; node(entry, 'implementation', {}, { next: 'done', rejected: 'failed', failed: 'failed' })
  } else if (mode === 'batch') {
    entry = 'batch'; node(entry, 'map', { over: 'tickets', body: 'implementation', concurrency: 2 }, { next: 'join' })
    node('join', 'join', { reduce: 'all-ok' }, { next: 'verify', fail: 'failed' }); verify('verify')
    const body = coreFactoryGraph('implement')
    for (const end of body.nodes.filter(item => item.type === 'end')) end.data = { ...end.data, requiresVerified: false, exit: end.id === 'done' ? 'next' : 'failed' }
    body.outputs = ['next', 'failed']; components = { implementation: body }
  } else if (mode === 'quick-sdd') {
    entry = 'prepare'
    node('prepare', 'prompt', { nativeCommand: { id: 'opsx:ff', args: '{{run.changeId}}' }, access: 'write' }, next('validate'))
    node('validate', 'openspec-validate', { change: '{{run.changeId}}' }, { pass: 'apply', fail: 'failed', failed: 'failed' })
    node('apply', 'prompt', { nativeCommand: { id: 'opsx:apply', args: '{{run.changeId}}' }, access: 'write' }, next('check'))
    verify('check', 'archive')
    node('archive', 'openspec-archive', { change: '{{run.changeId}}' }, next('verify'))
    verify('verify')
  } else {
    entry = 'implement'
    node('implement', 'prompt', { text: '{{cmd:freestyle}}', access: 'write' }, next('verify'))
    verify('verify', 'decide', 'fix')
    node('decide', 'decider', { roleId: 'loop-decider', goal: 'Stop only when actual behavioral evidence proves every frozen acceptance criterion is implemented across every selected ticket and repository. Passing baseline checks alone is insufficient.', noProgress: 3 }, { continue: 'fix', stop: 'done', failed: 'failed' })
    node('fix', 'prompt', { text: '{{cmd:fix}}', access: 'write' }, next('verify'))
  }
  edges.unshift({ id: 'e-start', source: 'start', target: entry })
  nodes.push({ id: 'done', type: 'end', position: { x: 0, y: nodes.length * 120 }, data: { outcome: 'success', requiresVerified: true } },
    { id: 'failed', type: 'end', position: { x: 320, y: nodes.length * 120 }, data: { outcome: 'failure' } })
  return { nodes, edges, config, ...(components ? { components } : {}) }
}
