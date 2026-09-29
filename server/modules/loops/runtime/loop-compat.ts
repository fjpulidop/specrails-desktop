import { assertLoopFailureRecovery, isDefinitionGraph, validateLoopGraph, type CoreNodeKind, type LoopGraph, type LoopNode } from './loop-graph'

export interface LegacyConversionIssue { code: string; message: string; nodeId?: string }
export type LegacyConversion =
  | { ok: true; graph: LoopGraph; nodeIds: Record<string, string>; issues: LegacyConversionIssue[] }
  | { ok: false; issues: LegacyConversionIssue[] }
export interface LegacyConversionBindings {
  /** Explicit scope for legacy shell nodes that did not name their repository. */
  repositoryId?: string
}
const reserved = new Set(['START', 'END', '__start__', '__end__', 'next', 'constructor', 'prototype'])
const safeId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(id) && !reserved.has(id)
const PASS = 'compatPassFailed', ITERATION = 'compatIteration', STEPS = 'compatSteps'
export const LEGACY_DECIDER_ROLE = 'legacy-loop-decider'

/** Pure projection only: no settings, database writes, provider calls or publication.
 * The caller validates the result against its selected Core before saving it. */
export function convertLegacyLoop(graph: LoopGraph, bindings: LegacyConversionBindings = {}): LegacyConversion {
  const validation = validateLoopGraph(graph)
  if (!validation.valid) return { ok: false, issues: validation.errors.map(error => ({ code: error.code, message: error.message, ...(error.nodeId ? { nodeId: error.nodeId } : {}) })) }
  if (isDefinitionGraph(graph)) return { ok: false, issues: [{ code: 'already_core', message: 'This graph already uses Core pieces.' }] }
  try { assertLoopFailureRecovery(graph) }
  catch (error) { return { ok: false, issues: [{ code: 'invalid_recovery', message: String(error) }] } }
  const issues: LegacyConversionIssue[] = []
  for (const node of graph.nodes) {
    if (node.type === 'shell' && !node.data?.repositoryId && !bindings.repositoryId) issues.push({ code: 'repository_binding_required', nodeId: node.id, message: 'Select the original shell repository before converting this graph.' })
    if (node.type === 'shell' && Array.isArray(node.data?.requireRunVars) && node.data.requireRunVars.some(name => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name))) issues.push({ code: 'invalid_run_variable', nodeId: node.id, message: 'Required runtime variables must use Core variable names.' })
  }
  if (issues.length) return { ok: false, issues }
  const used = new Set(graph.nodes.filter(node => safeId(node.id)).map(node => node.id))
  const fresh = (hint: string): string => {
    const base = ('compat-' + hint.replace(/[^A-Za-z0-9_-]/g, '-')).slice(0, 100)
    let id = base, suffix = 0
    while (used.has(id)) id = `${base}-${++suffix}`
    used.add(id); return id
  }
  const nodeIds = Object.fromEntries(graph.nodes.map((node, index) => [node.id, safeId(node.id) ? node.id : fresh('node-' + index)]))
  const start = graph.nodes.find(node => node.type === 'start')!
  const nodes: LoopNode[] = [{ ...structuredClone(start), id: nodeIds[start.id] }], edges: LoopGraph['edges'] = []
  const emit = (id: string, kind: CoreNodeKind, params: Record<string, unknown>, ends: Record<string, string>, original?: LoopNode) => {
    nodes.push({ id, type: 'core', position: original?.position ? { ...original.position } : { x: 480, y: nodes.length * 120 }, data: { kind, params, retry: { maxAttempts: 1 }, ...(original?.data?.label ? { label: original.data.label } : {}) } })
    for (const [label, target] of Object.entries(ends)) edges.push({ id: fresh('edge'), source: id, target, label })
  }
  const failure = fresh('failed'), exhausted = fresh('iteration-limit')
  const end = (id: string, outcome: 'success' | 'failure', reason?: string) => emit(id, 'end', { outcome, ...(reason ? { reason } : {}) }, {})
  const assign = (id: string, params: Record<string, unknown>, target: string) => emit(id, 'assign', params, { next: target, failed: failure })
  const condition = (id: string, expr: string, yes: string, no: string) => emit(id, 'condition', { expr }, { true: yes, false: no })
  const entry = new Map<string, string>()
  const legacyCap = (graph.config.maxIterations + 1) * (graph.nodes.length + 2) + 16
  // Every original visit keeps its own legacy ceiling as well as Core's global
  // control-transition ceiling. Free control nodes cannot buy another AI pass.
  for (const node of graph.nodes.filter(node => node.type !== 'start')) {
    const guard = fresh('visit'), count = fresh('visit-count')
    entry.set(node.id, guard)
    condition(guard, `$vars.${STEPS} < ${legacyCap}`, count, exhausted)
    assign(count, { increment: { [STEPS]: 1 } }, nodeIds[node.id])
  }
  if (graph.edges.some(edge => edge.target === start.id)) {
    const guard = fresh('revisit-start'), count = fresh('revisit-start-count')
    entry.set(start.id, guard)
    condition(guard, `$vars.${STEPS} < ${legacyCap}`, count, exhausted)
    assign(count, { increment: { [STEPS]: 1 } }, entry.get(graph.edges.find(edge => edge.source === start.id)!.target)!)
  }
  const successor = (node: LoopNode) => entry.get(graph.edges.find(edge => edge.source === node.id)!.target)!
  const recoveryVars = new Map(graph.nodes.filter(node => node.data?.failureRecovery).map((node, index) => [node.id, 'compatRecovery' + index]))
  const writes = graph.nodes.some(node => node.type === 'ai-step' || node.type === 'shell')
  let implementation = false
  const failedPass = (target: string): string => {
    const id = fresh('failed-pass'); assign(id, { set: { [PASS]: true } }, target); return id
  }
  const promptParams = (node: LoopNode, repair = false): Record<string, unknown> => {
    const text = repair
      ? 'Repair ONLY the OpenSpec artifacts at openspec/changes/{{run.changeId}}/ using the validation diagnostics in history. Preserve requirements and acceptance criteria. Do not edit implementation code, run repository tests, archive, create a new change, or expand scope. {{const:GUARDRAILS}}'
      : String(node.data?.prompt ?? '')
    const verification = !repair && (node.data?.requireVerificationPass === true || /\{\{cmd:(?:verify|revision-verify|opsx:verify)\}\}/.test(text))
    return { text: text || 'Continue the frozen workflow obligations.', access: 'write', sentinel: verification ? 'verification' : 'blocked',
      sessionContinuity: node.data?.freshSession === true ? 'none' : 'run', appendHistory: true,
      timeoutMs: Math.round((graph.config.aiStepTimeoutMinutes ?? 15) * 60_000), idleTimeoutMs: 30 * 60_000 }
  }
  const recover = (node: LoopNode): string => {
    const policy = node.data?.failureRecovery
    if (!policy) return failure
    const guard = fresh('recovery-guard'), consume = fresh('recovery-count')
    let target = entry.get(policy.target)!
    if (policy.target !== node.id || policy.artifactOnly) {
      const repair = fresh('artifact-repair'), original = graph.nodes.find(item => item.id === policy.target)!
      target = fresh('repair-visit'); const count = fresh('repair-count')
      condition(target, `$vars.${STEPS} < ${legacyCap}`, count, exhausted)
      assign(count, { increment: { [STEPS]: 1 } }, repair)
      emit(repair, 'prompt', promptParams(original, true), { next: entry.get(node.id)!, blocked: failure, failed: failure }, original)
    }
    condition(guard, `$vars.${recoveryVars.get(node.id)} < 1`, consume, failure)
    assign(consume, { increment: { [recoveryVars.get(node.id)!]: 1 } }, target)
    return guard
  }
  for (const node of graph.nodes) {
    const id = nodeIds[node.id]
    if (node.type === 'start') continue
    if (node.type === 'end') {
      if (node.data?.outcome === 'failure') { end(id, 'failure'); continue }
      const done = fresh('done')
      condition(id, `$vars.${PASS} == false`, writes ? (() => { const verify = fresh('verify'); emit(verify, 'verify', { commands: 'configured' }, { pass: done, fail: failure, failed: failure }); return verify })() : done, failure)
      end(done, 'success'); continue
    }
    if (node.type === 'condition') { condition(id, 'true', successor(node), successor(node)); continue }
    if (node.type === 'decider') {
      const out = graph.edges.filter(edge => edge.source === node.id)
      const branch = (name: 'continue' | 'stop') => out.find(edge => edge.branch === name)?.target ?? out.find(edge => (graph.nodes.find(target => target.id === edge.target)?.type === 'end') === (name === 'stop'))!.target
      const cont = entry.get(branch('continue'))!, stop = entry.get(branch('stop'))!
      const evaluate = fresh('decision-count'), ordinary = fresh('continue-limit'), reset = fresh('new-pass'), route = fresh('decision-route')
      // Redirect the visit counter into the decider's iteration admission.
      edges.find(edge => edge.target === id)!.target = evaluate
      const ready = fresh('decision-ready')
      condition(evaluate, `$vars.${ITERATION} < ${graph.config.maxIterations}`, ready, exhausted)
      assign(ready, { increment: { [ITERATION]: 1 } }, id)
      emit(id, 'decider', { roleId: LEGACY_DECIDER_ROLE, goal: String(node.data?.goal ?? 'The loop goal is met.'), timeoutMs: 180_000, noProgress: 3, continueWhen: `$vars.${PASS} == true` }, { continue: route, stop, failed: failure }, node)
      condition(route, `$outputs.${id}.blocked == true`, cont, ordinary)
      condition(ordinary, `$vars.${ITERATION} < ${graph.config.maxIterations}`, reset, exhausted)
      assign(reset, { set: { [PASS]: false } }, cont)
      continue
    }
    const next = successor(node), hardFailure = node.data?.stopOnFailure === true ? failure : failedPass(next)
    if (node.type === 'ai-step') {
      const raw = String(node.data?.prompt ?? '')
      if (node.data?.operation === 'core-implementation' || /\{\{\s*cmd:(?:implement|batch)\s*\}\}/.test(raw) || /^\s*(?:\/specrails:|\/skill:specrails-|\$)(?:implement|batch-implement)(?:\s|$)/.test(raw)) {
        implementation = true
        // The removed Batch command (`{{cmd:batch}}` / `batch-implement`) converts
        // exactly like implement: one aggregate implementation node, no map/join.
        emit(id, 'implementation', {}, { next, rejected: hardFailure, failed: hardFailure }, node)
      } else {
        const params = promptParams(node)
        emit(id, 'prompt', params, params.sentinel === 'verification'
          ? { pass: next, fail: node.data?.stopOnFailure === true ? recover(node) : hardFailure, failed: hardFailure }
          : { next, blocked: hardFailure, failed: hardFailure }, node)
      }
    } else if (node.type === 'shell') {
      const required = Array.isArray(node.data?.requireRunVars) ? node.data.requireRunVars as string[] : []
      let execute = id
      if (required.length) {
        execute = fresh('shell')
        condition(id, required.map(name => `exists($vars.${name}) && $vars.${name} != ""`).join(' && '), execute, failure)
      }
      let commandFailure = hardFailure
      const command = String(node.data?.command ?? '').trim()
      const validate = /^openspec validate \{\{\s*run\.changeId\s*\}\} --type change --strict --no-interactive$/.test(command)
      const archive = /^openspec archive \{\{\s*run\.changeId\s*\}\} -y$/.test(command)
      if (validate || archive) {
        const params = { change: '{{run.changeId}}', allowArchived: true, repositoryId: node.data?.repositoryId ?? bindings.repositoryId }
        if (validate) emit(execute, 'openspec-validate', params, { pass: next, fail: node.data?.stopOnFailure === true ? recover(node) : hardFailure, failed: hardFailure }, node)
        else {
          let failed = hardFailure
          if (node.data?.stopOnFailure === true && node.data.failureRecovery) {
            failed = fresh('archive-recovery-exit')
            condition(failed, `$outputs.${execute}.exitCode == 1`, recover(node), hardFailure)
          }
          emit(execute, 'openspec-archive', params, { next, failed }, node)
        }
        continue
      }
      if (node.data?.stopOnFailure === true && node.data.failureRecovery) {
        commandFailure = fresh('recoverable-exit')
        condition(commandFailure, `$outputs.${execute}.exitCode == 1`, recover(node), failure)
      }
      emit(execute, 'shell', { commandLine: command, repositoryId: node.data?.repositoryId ?? bindings.repositoryId,
        timeoutMs: 600_000, outputCapBytes: 262_144 }, { ok: next, fail: commandFailure, failed: hardFailure }, node)
    }
  }
  end(failure, 'failure', 'legacy_required_work_failed'); end(exhausted, 'failure', 'legacy_iteration_limit')
  const initial = { [PASS]: false, [ITERATION]: 0, [STEPS]: 1, ...Object.fromEntries([...recoveryVars.values()].map(name => [name, 0])) }
  const chunks = Object.entries(initial)
  let first = successor(start)
  while (chunks.length) { const id = fresh('initialize'); assign(id, { set: Object.fromEntries(chunks.splice(-64)) }, first); first = id }
  edges.unshift({ id: fresh('start-edge'), source: nodeIds[start.id], target: first })
  // Avoid unreachable synthetic terminals in graphs that never branch/fail.
  const reachable = new Set<string>(), pending = [nodeIds[start.id]]
  while (pending.length) { const current = pending.pop()!; if (reachable.has(current)) continue; reachable.add(current); pending.push(...edges.filter(edge => edge.source === current).map(edge => edge.target)) }
  const maxTransitions = implementation ? 10_000 : legacyCap * 12 + nodes.length
  if (maxTransitions > 10_000) return { ok: false, issues: [{ code: 'transition_limit', message: 'This conversion exceeds Core’s 10000-transition ceiling; reduce the requested iteration bound.' }] }
  const converted: LoopGraph = { nodes: nodes.filter(node => reachable.has(node.id)), edges: edges.filter(edge => reachable.has(edge.source)),
    config: { ...graph.config, policies: { ...graph.config.policies, failFast: Math.min(graph.config.policies?.failFast ?? 2, 2) }, maxTransitions, journal: implementation ? 'implementation' : 'ledger-only', change: graph.config.change ?? (implementation ? undefined : 'none'),
      ...(graph.nodes.some(node => node.type === 'decider') ? { legacyDeciderRole: LEGACY_DECIDER_ROLE } : {}) } }
  const result = validateLoopGraph(converted)
  if (!result.valid) return { ok: false, issues: result.errors.map(error => ({ code: error.code, message: error.message, ...(error.nodeId ? { nodeId: error.nodeId } : {}) })) }
  return { ok: true, graph: converted, nodeIds, issues: [] }
}
