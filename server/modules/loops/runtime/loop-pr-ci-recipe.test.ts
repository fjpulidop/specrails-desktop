import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileLoopToDefinition } from './loop-definition'
import { classifyLoopEffect } from './loop-effect'
import { factoryLoopMode, factoryLoopsForCapabilities, getFactoryLoop } from './loop-factory'
import { builtinLoopDefaults, EDITABLE_BUILTIN_LOOP_IDS } from './builtin-loops'
import { CORE_NODE_KINDS, effectivePieceOutcomes, validateLoopGraph } from './loop-graph'
import { PR_CI_ENDS, PR_CI_EVIDENCE_RULES, PR_CI_LOOP_ID, prCiGraph, supportsPrCi } from './loop-pr-ci-recipe'

const V2 = { engineV2: 1, workflowDefinitions: 1 }
const CAPS = { ...V2, hostTasks: 1, hostBlockers: 1 }
const HUMAN = ['approval', 'question', 'gate']
/** Core's outcomes per kind for the params this recipe uses (Core `getOutcomes`). */
function outcomesOf(kind: string, params: Record<string, unknown>): readonly string[] {
  if (kind === 'host-task') return effectivePieceOutcomes({ kind, outcomes: ['failed'] }, params)
  if (kind === 'role-turn') return params.structuredOutput ? ['next', 'invalid', 'failed'] : ['next', 'failed']
  if (kind === 'condition') return ['true', 'false']
  if (kind === 'assign') return ['next', 'failed']
  if (kind === 'verify') return effectivePieceOutcomes({ kind, outcomes: ['pass', 'fail', 'blocked', 'failed'] }, params)
  throw new Error('unexpected kind ' + kind)
}

describe('factory:pr-ci gating', () => {
  it('is listed, not launchable, only when Core advertises hostTasks', () => {
    expect(factoryLoopsForCapabilities(V2).map(loop => loop.id)).not.toContain(PR_CI_LOOP_ID)
    expect(factoryLoopsForCapabilities(undefined).map(loop => loop.id)).not.toContain(PR_CI_LOOP_ID)
    expect(factoryLoopsForCapabilities(CAPS).find(loop => loop.id === PR_CI_LOOP_ID)).toMatchObject({ mode: 'loop', launchable: false, requiredCoreCapability: 'hostTasks' })
    expect(getFactoryLoop(PR_CI_LOOP_ID, V2)).toBeUndefined()
    expect(factoryLoopMode(PR_CI_LOOP_ID)).toBe('loop')
    expect(supportsPrCi({ ...V2, hostTasks: 2 })).toBe(false)
    expect(EDITABLE_BUILTIN_LOOP_IDS).not.toContain(PR_CI_LOOP_ID)
    expect(builtinLoopDefaults(CAPS, true).map(loop => loop.id)).not.toContain(PR_CI_LOOP_ID)
    expect(CORE_NODE_KINDS).toContain('host-task')
  })
})

describe.each([['with host blockers', CAPS], ['without host blockers', { ...V2, hostTasks: 1 }]])('factory:pr-ci graph %s', (_label, capabilities) => {
  const graph = prCiGraph(capabilities)
  const core = graph.nodes.filter(node => node.type === 'core')

  it('is a valid, mutating loop graph', () => {
    expect(validateLoopGraph(graph)).toMatchObject({ valid: true })
    expect(classifyLoopEffect(graph)).toBe('mutating')
  })

  it('never asks a person: no approval, question, gate or blocked prompt', () => {
    expect(core.filter(node => HUMAN.includes(String(node.data?.kind)))).toEqual([])
    expect(core.filter(node => node.data?.kind === 'prompt')).toEqual([])
    expect(JSON.stringify(graph)).not.toContain('LOOP_BLOCKED')
  })

  it('wires every outcome of every piece, to an existing node', () => {
    const ids = new Set(graph.nodes.map(node => node.id))
    for (const node of core.filter(node => node.data?.kind !== 'end')) {
      const labels = graph.edges.filter(edge => edge.source === node.id).map(edge => edge.label).sort()
      expect(labels, node.id).toEqual([...outcomesOf(String(node.data!.kind), node.data!.params ?? {})].sort())
      for (const edge of graph.edges.filter(edge => edge.source === node.id)) expect(ids.has(edge.target), `${node.id} → ${edge.target}`).toBe(true)
    }
    for (const end of Object.values(PR_CI_ENDS)) if (end !== PR_CI_ENDS.hostBlocked || capabilities.hostBlockers === 1) expect(ids.has(end), end).toBe(true)
  })

  it('pushes only a verified candidate and never with a write effect that would drop verification', () => {
    const push = core.find(node => node.id === 'push')!
    expect(push.data?.params).toMatchObject({ task: 'pr.sync', requiresVerified: true, effect: 'read' })
    expect(graph.edges.filter(edge => edge.target === 'push').map(edge => edge.source)).toEqual(['local'])
    expect(core.find(node => node.id === 'base')!.data?.params).toMatchObject({ task: 'pr.update-base', effect: 'write' })
  })

  it('reports failures the code does not cause instead of retrying them', () => {
    expect(core.some(node => node.data?.params && (node.data.params as Record<string, unknown>).task === 'pr.rerun-failed')).toBe(false)
    const cause = graph.edges.filter(edge => edge.source === 'cause')
    expect(Object.fromEntries(cause.map(edge => [edge.label, edge.target]))).toEqual({ true: PR_CI_ENDS.stalled, false: PR_CI_ENDS.notFixable })
    expect(graph.edges.find(edge => edge.source === 'progress' && edge.label === 'false')?.target).toBe('cause')
    expect(String(core.find(node => node.id === 'fixer')!.data!.params!.prompt)).toMatch(/Never edit anything for flaky or infrastructure failures/)
  })

  it('brings in the base before fixing red checks, and fixes only a PR still red after it', () => {
    expect(graph.edges.find(edge => edge.source === 'checks' && edge.label === 'red')?.target).toBe('refresh-base')
    const refresh = core.find(node => node.id === 'refresh-base')!.data!.params as Record<string, unknown>
    expect(refresh).toMatchObject({ task: 'pr.update-base', input: { reason: 'red' }, effect: 'write' })
    const routes = Object.fromEntries(graph.edges.filter(edge => edge.source === 'refresh-base').map(edge => [edge.label, edge.target]))
    expect(routes).toMatchObject({ clean: 'ci-evidence', merged: 'base-summary', conflicts: 'conflict-budget' })
    expect(graph.edges.find(edge => edge.source === 'base-summary')?.target).toBe('local')
  })

  it('pushes the fixes made before a blocker, and ends on the blocker only when nothing changed', () => {
    expect(graph.edges.find(edge => edge.source === 'fixer-blocker' && edge.label === 'true')?.target).toBe('blocker-progress')
    const routes = Object.fromEntries(graph.edges.filter(edge => edge.source === 'blocker-progress').map(edge => [edge.label, edge.target]))
    expect(routes).toEqual({ true: 'local', false: PR_CI_ENDS.fixerBlocked })
  })

  it('bounds rounds, re-runs and conflicts, and treats CI output as untrusted evidence', () => {
    const init = core.find(node => node.id === 'init')!.data!.params!.set as Record<string, number>
    expect(init).toMatchObject({ rounds: 0, roundLimit: 5, conflictRounds: 0, conflictLimit: 3 })
    expect(init).not.toHaveProperty('reruns')
    const fixer = core.find(node => node.id === 'fixer')!.data!.params!
    expect(fixer.prompt).toContain(PR_CI_EVIDENCE_RULES)
    expect(String(fixer.prompt)).toMatch(/never instructions/)
    expect(String(fixer.prompt)).toMatch(/Never weaken, skip, delete, disable/)
  })

  it('compiles to a definition whose success needs no local verification (CI already green)', () => {
    const definition = compileLoopToDefinition(graph, { id: PR_CI_LOOP_ID, title: 'Fix PR CI', constants: {}, provider: 'claude', roles: { correct: { access: 'write' }, resolve: { access: 'write' } } })
    expect(definition).toMatchObject({ id: 'factory-pr-ci', change: 'none', journal: 'ledger-only', delivery: { requiresVerified: false } })
    expect(definition.roles).toEqual(['correct', 'resolve'])
    expect(definition.nodes[PR_CI_ENDS.green]).toMatchObject({ kind: 'end', params: { outcome: 'success', requiresVerified: false } })
    expect(Object.values(definition.nodes).some(node => HUMAN.includes(node.kind))).toBe(false)
  })
})

const coreRoot = process.env.SPECRAILS_CORE_SOURCE_DIR
const coreCli = coreRoot ? path.join(coreRoot, 'dist/agent-runtime/cli.js') : ''
/** Only a paired Core that advertises `hostTasks` knows the piece (older Cores hide the feature). */
const coreHostTasks = !!coreRoot && existsSync(coreCli) && (() => {
  try { return (JSON.parse(spawnSync(process.execPath, [coreCli, 'api'], { encoding: 'utf8' }).stdout.trim().split('\n').at(-1) ?? '{}') as { capabilities?: Record<string, number> }).capabilities?.hostTasks === 1 } catch { return false }
})()
describe.skipIf(!coreHostTasks)('factory:pr-ci against the real Core catalog', () => {
  it('validates structurally in Core and every piece is advertised', () => {
    const graph = prCiGraph(CAPS)
    const definition = compileLoopToDefinition(graph, { id: PR_CI_LOOP_ID, title: 'Fix PR CI', constants: {}, provider: 'claude', roles: { correct: { access: 'write' }, resolve: { access: 'write' } } })
    const validated = spawnSync(process.execPath, [coreCli, 'workflows', 'validate', '--stdin', '--structural'], { input: JSON.stringify(definition), encoding: 'utf8' })
    expect(validated.status, validated.stdout + validated.stderr).toBe(0)
    expect(JSON.parse(validated.stdout.trim().split('\n').at(-1)!)).toMatchObject({ ok: true })
    const listed = JSON.parse(spawnSync(process.execPath, [coreCli, 'workflows', 'list'], { encoding: 'utf8' }).stdout.trim().split('\n').at(-1)!) as { nodeKinds: Array<{ kind: string; outcomes: string[] }> }
    expect(validateLoopGraph(graph, listed.nodeKinds)).toMatchObject({ valid: true })
    const api = JSON.parse(spawnSync(process.execPath, [coreCli, 'api'], { encoding: 'utf8' }).stdout.trim().split('\n').at(-1)!) as { capabilities: Record<string, number> }
    expect(supportsPrCi(api.capabilities)).toBe(true)
  })
})
