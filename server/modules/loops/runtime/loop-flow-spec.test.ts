import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync as read, lstatSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileLoopToDefinition } from './loop-definition'
import { canonicalFactoryLoopId, factoryLoopMode, factoryLoopsForCapabilities, FLOW_SPEC_LOOP_ID, getFactoryLoop, supportsFlowSpec } from './loop-factory'
import { FLOW_CHANGES_REQUESTED_END, FLOW_CHANGE_ID_MAX, FLOW_CORRECTION_ROUNDS, FLOW_SUMMARY_FILE, FLOW_SUMMARY_LIMIT_BYTES, flowChangeId, flowChangeIdStem, flowSpecGraph } from './loop-flow-spec-recipe'
import { CORE_NODE_KINDS, validateLoopGraph } from './loop-graph'
import { builtinLoopDefaults, EDITABLE_BUILTIN_LOOP_IDS } from './builtin-loops'
import { flowChangeHolder, flowDerivationChangeId, writeFlowSummary } from './loop-executors'

const V2 = { engineV2: 1, workflowDefinitions: 1 }
const fixture = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'core-flow-spec.json'), 'utf8')) as {
  entry: string; journal: string; change: string; roles: string[]
  nodes: Record<string, { kind: string; params: Record<string, unknown>; ends: Record<string, string> }>
}

describe('factory:flow-spec gating', () => {
  it('is listed only when Core advertises deriveChange with the workflow engine', () => {
    expect(factoryLoopsForCapabilities(undefined).map(loop => loop.id)).not.toContain(FLOW_SPEC_LOOP_ID)
    expect(factoryLoopsForCapabilities(V2).map(loop => loop.id)).not.toContain(FLOW_SPEC_LOOP_ID)
    expect(factoryLoopsForCapabilities({ deriveChange: 1 }).map(loop => loop.id)).not.toContain(FLOW_SPEC_LOOP_ID)
    const listed = factoryLoopsForCapabilities({ ...V2, deriveChange: 1 }).find(loop => loop.id === FLOW_SPEC_LOOP_ID)
    expect(listed).toMatchObject({ mode: 'loop', launchable: false, requiredCoreCapability: 'deriveChange' })
    expect(getFactoryLoop(FLOW_SPEC_LOOP_ID, V2)).toBeUndefined()
    expect(getFactoryLoop(FLOW_SPEC_LOOP_ID, { ...V2, deriveChange: 1 })?.id).toBe(FLOW_SPEC_LOOP_ID)
    expect(supportsFlowSpec({ ...V2, deriveChange: 2 })).toBe(false)
  })

  it('maps to loop mode and canonicalizes without capabilities (the router validates first)', () => {
    expect(factoryLoopMode(FLOW_SPEC_LOOP_ID)).toBe('loop')
    expect(canonicalFactoryLoopId(FLOW_SPEC_LOOP_ID)).toBe(FLOW_SPEC_LOOP_ID)
    expect(canonicalFactoryLoopId('factory:batch')).toBe('factory:implement')
  })

  it('is not an editable built-in (never seeded into the loop library)', () => {
    expect(EDITABLE_BUILTIN_LOOP_IDS).not.toContain(FLOW_SPEC_LOOP_ID)
    expect(builtinLoopDefaults({ ...V2, deriveChange: 1 }, true).map(loop => loop.id)).not.toContain(FLOW_SPEC_LOOP_ID)
  })

  it('knows derive-change as a Core node kind', () => {
    expect(CORE_NODE_KINDS).toContain('derive-change')
    expect(validateLoopGraph(flowSpecGraph()).valid).toBe(true)
  })
})

describe('flow-spec definition', () => {
  const definition = compileLoopToDefinition(flowSpecGraph(), { id: FLOW_SPEC_LOOP_ID, title: 'Flow → Spec', constants: {}, provider: 'claude', roles: { reviewer: { access: 'read' } } })

  it('matches the Core reference fixture shape (entry, roles, kinds, routing)', () => {
    expect(definition).toMatchObject({ id: 'factory-flow-spec', entry: fixture.entry, journal: fixture.journal, change: fixture.change, delivery: { requiresVerified: true } })
    expect(definition.roles).toEqual([...fixture.roles].sort())
    expect(Object.keys(definition.nodes).sort()).toEqual(Object.keys(fixture.nodes).sort())
    for (const [id, node] of Object.entries(fixture.nodes)) {
      expect(definition.nodes[id]!.kind, id).toBe(node.kind)
      expect(definition.nodes[id]!.ends, id).toEqual(node.ends)
    }
  })

  it('keeps the closed params of the Core pieces', () => {
    for (const id of ['derive', 'check', 'archive', 'verify', 'repair-guard', 'repair-count', 'init', 'review-policy',
      'check-findings', 'review-findings', 'correction-budget', 'begin-correction', 'fix-progress', 'changes-requested', 'done', 'failed']) {
      expect(definition.nodes[id]!.params, id).toEqual(fixture.nodes[id]!.params)
    }
    expect(definition.nodes.derive!.params).toEqual({ change: '{{run.changeId}}', summaryPath: FLOW_SUMMARY_FILE, feedback: '{{run.latestFindings}}' })
    expect(definition.nodes.review!.params).toMatchObject({ roleId: 'reviewer' })
    expect(String(definition.nodes.review!.params.prompt)).toContain('unexplainedFiles')
  })

  it('repairs instead of dead-ending: review rejection and failing checks route to a bounded WRITE fixer round, then re-derive', () => {
    expect(definition.nodes.fix!.params).toMatchObject({ roleId: 'developer', stance: 'fixer', sessionContinuity: 'none' })
    expect(definition.nodes.fix!.params).toMatchObject({ roleId: fixture.nodes.fix!.params.roleId, stance: fixture.nodes.fix!.params.stance })
    const prompt = String(definition.nodes.fix!.params.prompt)
    expect(prompt).toContain('{{run.latestFindings}}')
    expect(prompt).toContain('[spec:<capability>/<requirement-slug>]')
    expect(prompt).toContain('Never expand scope')
    expect(prompt).toContain('Do not edit anything under openspec/')
    expect(definition.nodes['review-policy']!.ends.false).toBe('review-findings')
    expect(definition.nodes.check!.ends.fail).toBe('check-findings')
    expect(definition.nodes['fix-progress']!.ends).toEqual({ true: 'derive', false: FLOW_CHANGES_REQUESTED_END })
    expect(definition.nodes['correction-budget']!.ends.false).toBe(FLOW_CHANGES_REQUESTED_END)
    expect(definition.nodes.init!.params).toMatchObject({ set: { correctionLimit: FLOW_CORRECTION_ROUNDS } })
    // The fixer writes: the run must deliver only a verified candidate.
    expect(definition.delivery).toEqual({ requiresVerified: true })
  })
})

describe('writeFlowSummary', () => {
  it('writes once, 0600, bounded to the Core limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-summary-'))
    writeFlowSummary(dir, 'é'.repeat(FLOW_SUMMARY_LIMIT_BYTES))
    const file = join(dir, FLOW_SUMMARY_FILE)
    expect(Buffer.byteLength(read(file, 'utf8'))).toBeLessThanOrEqual(FLOW_SUMMARY_LIMIT_BYTES)
    expect(read(file, 'utf8')).not.toContain('�')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    writeFlowSummary(dir, 'second')
    expect(read(file, 'utf8').startsWith('é')).toBe(true)
    expect(lstatSync(file).isFile()).toBe(true)
  })

  it('never writes through an existing path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-summary-'))
    writeFileSync(join(dir, FLOW_SUMMARY_FILE), 'kept')
    writeFlowSummary(dir, 'new')
    expect(read(join(dir, FLOW_SUMMARY_FILE), 'utf8')).toBe('kept')
  })
})

describe('Flow change id', () => {
  it('is the kebab-case spec title (diacritics folded, ≤64, cut at a word), never addenda', () => {
    expect(flowChangeIdStem('Add more visual effects to ArkanoidEX (ball trail, brick shockwaves, animated background, level transitions, power-up…')).toBe('add-more-visual-effects-to-arkanoidex-ball-trail-brick')
    expect(flowChangeIdStem('Añadir efectos de vídeo')).toBe('anadir-efectos-de-video')
    expect(flowChangeIdStem(`${'word-'.repeat(12)}four end`)).toBe(`${'word-'.repeat(12)}four`)
    expect(flowChangeIdStem('  ')).toBe('flow-change')
    expect(flowChangeIdStem(null)).toBe('flow-change')
    for (const title of ['x'.repeat(200), 'Ünïcödé — ✨ title!!', '123 numbers first']) {
      const id = flowChangeIdStem(title)
      expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(id.length).toBeLessThanOrEqual(FLOW_CHANGE_ID_MAX)
    }
  })

  it('suffixes a name another change holds and reuses this Flow\'s own earlier derivation', () => {
    expect(flowChangeId('Kanban board', () => 'free')).toBe('kanban-board')
    expect(flowChangeId('Kanban board', (id) => id === 'kanban-board' ? 'own' : 'taken')).toBe('kanban-board')
    expect(flowChangeId('Kanban board', (id) => id === 'kanban-board' || id === 'kanban-board-2' ? 'taken' : 'free')).toBe('kanban-board-3')
    const long = flowChangeId('a'.repeat(80), (id) => id.length === 64 && !id.endsWith('-2') ? 'taken' : 'free')
    expect(long).toMatch(/-2$/)
    expect(long.length).toBeLessThanOrEqual(FLOW_CHANGE_ID_MAX)
    expect(() => flowChangeId('x', () => 'taken')).toThrow(/No free OpenSpec change name/)
  })

  it('reads who holds a name in a real worktree: base change, archived change, own active derivation', () => {
    const repo = mkdtempSync(join(tmpdir(), 'flow-change-id-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
    git('init', '-q')
    mkdirSync(join(repo, 'openspec', 'changes', 'base-change'), { recursive: true })
    writeFileSync(join(repo, 'openspec', 'changes', 'base-change', 'proposal.md'), '# base')
    mkdirSync(join(repo, 'openspec', 'changes', 'archive', '2026-10-01-shipped'), { recursive: true })
    writeFileSync(join(repo, 'openspec', 'changes', 'archive', '2026-10-01-shipped', 'proposal.md'), '# shipped')
    git('add', '-A'); git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD')
    mkdirSync(join(repo, 'openspec', 'changes', 'kanban-board'), { recursive: true })
    writeFileSync(join(repo, 'openspec', 'changes', 'kanban-board', 'proposal.md'), '# derived by this Flow')
    expect(flowChangeHolder(repo, base, 'base-change')).toBe('taken')
    expect(flowChangeHolder(repo, base, 'shipped')).toBe('taken')
    expect(flowChangeHolder(repo, base, 'kanban-board')).toBe('own')
    expect(flowChangeHolder(repo, base, 'new-name')).toBe('free')
    expect(flowChangeHolder(repo, null, 'kanban-board')).toBe('taken')
    expect(flowChangeId('Base change', (id) => flowChangeHolder(repo, base, id))).toBe('base-change-2')
  })

  it('re-derives the Flow\'s own earlier change in place (legacy addenda name too); title-based only for the first derivation', () => {
    const repo = mkdtempSync(join(tmpdir(), 'flow-change-seed-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
    git('init', '-q')
    mkdirSync(join(repo, 'openspec', 'changes', 'base-change'), { recursive: true })
    writeFileSync(join(repo, 'openspec', 'changes', 'base-change', 'proposal.md'), '# base')
    git('add', '-A'); git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD')
    expect(flowDerivationChangeId(repo, { baseSha: base, changeId: null }, 'Arkanoid power-ups')).toBe('arkanoid-power-ups')
    mkdirSync(join(repo, 'openspec', 'changes', 'ticket-8-addenda-3e1942024602'), { recursive: true })
    writeFileSync(join(repo, 'openspec', 'changes', 'ticket-8-addenda-3e1942024602', 'proposal.md'), '# derived')
    expect(flowDerivationChangeId(repo, { baseSha: base, changeId: 'ticket-8-addenda-3e1942024602' }, 'Arkanoid power-ups')).toBe('ticket-8-addenda-3e1942024602')
    // Someone else's change (present at the base), a vanished one or a malformed id never wins.
    expect(flowDerivationChangeId(repo, { baseSha: base, changeId: 'base-change' }, 'Arkanoid power-ups')).toBe('arkanoid-power-ups')
    expect(flowDerivationChangeId(repo, { baseSha: base, changeId: 'gone' }, 'Arkanoid power-ups')).toBe('arkanoid-power-ups')
    expect(flowDerivationChangeId(repo, { baseSha: base, changeId: '../base-change' }, 'Arkanoid power-ups')).toBe('arkanoid-power-ups')
  })
})
