/**
 * Tests for the OpenSpec-lifecycle loop template (opsx-lifecycle) and the engine
 * support it relies on: the opsx:* provider-native magic commands, the
 * `{{run.changeId}}` run-scoped capture, and the shell `requireRunVars` archive
 * guard. See openspec/changes/opsx-lifecycle-loop-template.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDb, type DbInstance } from './db'
import { expandCommands, getLoopCommand } from './modules/loops/runtime/loop-command-catalog'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  LoopRunManager,
  resolveRunVars,
  extractChangeId,
  seedChangeId,
  openspecChangeState,
  type LoopExecutors,
} from './modules/loops/runtime/loop-run-manager'
import { getLoopTemplate, opsxLifecycleGraph } from './modules/loops/runtime/loop-templates'
import { interpolateSpec, validateLoopGraph } from './modules/loops/runtime/loop-graph'
import type { WsMessage } from './types'

// ── opsx:* magic commands (loop-magic-commands) ──────────────────────────────
describe('opsx magic commands', () => {
  for (const name of ['opsx:ff', 'opsx:apply', 'opsx:verify']) {
    it(`${name} is a providerNative command (not coreCommand)`, () => {
      const cmd = getLoopCommand(name)
      expect(cmd).toBeDefined()
      expect(cmd!.coreCommand).toBeUndefined()
      expect(cmd!.providerNative).toBeDefined()
      expect(cmd!.template).toBeTruthy() // fallback exists
    })
  }

  it('expands to the slash form on claude and gemini', () => {
    expect(expandCommands('{{cmd:opsx:ff}}', { provider: 'claude' })).toBe('/opsx:ff')
    expect(expandCommands('{{cmd:opsx:apply}}', { provider: 'gemini' })).toBe('/opsx:apply')
    expect(expandCommands('{{cmd:opsx:verify}}', { provider: 'gemini' })).toBe('/opsx:verify')
  })

  it('expands to the dollar form on codex', () => {
    expect(expandCommands('{{cmd:opsx:ff}}', { provider: 'codex' })).toBe('$opsx:ff')
    expect(expandCommands('{{cmd:opsx:apply}}', { provider: 'codex' })).toBe('$opsx:apply')
  })

  it('falls back to the template prompt for an unknown provider (never empty/raw)', () => {
    const out = expandCommands('{{cmd:opsx:ff}}', { provider: 'someNewProvider' })
    expect(out).toBe(getLoopCommand('opsx:ff')!.template)
    expect(out).not.toBe('')
    expect(out).not.toContain('{{cmd')
  })

  it('tokenizes a namespaced command alongside surrounding text', () => {
    const out = expandCommands('{{cmd:opsx:ff}} {{spec.title}}', { provider: 'claude' })
    expect(out).toBe('/opsx:ff {{spec.title}}') // spec token left for interpolateSpec
  })
})

// ── run-scoped capture (loop-execution) ──────────────────────────────────────
describe('extractChangeId', () => {
  it('recognises native and JSON-escaped Windows artifact paths without treating archive as a change', () => {
    expect(extractChangeId(String.raw`Created C:\Users\Ana\repos\app\openspec\changes\add-login\tasks.md`)).toBe('add-login')
    expect(extractChangeId(JSON.stringify({ path: String.raw`C:\repos\app\openspec\changes\add-login\tasks.md` }))).toBe('add-login')
    expect(extractChangeId(String.raw`C:\repos\app\openspec\changes\archive\old\tasks.md`)).toBeUndefined()
  })
  it('captures the id from an openspec/changes path', () => {
    expect(extractChangeId('Created change at openspec/changes/my-change/')).toBe('my-change')
  })
  it('captures the FIRST id when several are mentioned', () => {
    expect(extractChangeId('openspec/changes/aaa and openspec/changes/bbb')).toBe('aaa')
  })
  it('ignores archived change paths because archive is not a runnable change id', () => {
    expect(extractChangeId('Archived to apps/web/openspec/changes/archive/2026-07-06-my-change/')).toBeUndefined()
  })
  it('skips archived paths and captures the first active change path', () => {
    expect(extractChangeId(
      'Archived apps/web/openspec/changes/archive/2026-07-06-old/ then continued openspec/changes/my-change/',
    )).toBe('my-change')
  })
  it('returns undefined when no change path is present', () => {
    expect(extractChangeId('nothing to see here')).toBeUndefined()
  })
})

describe('resolveRunVars', () => {
  it('resolves a captured token', () => {
    expect(resolveRunVars('archive {{run.changeId}} now', { changeId: 'abc' })).toBe('archive abc now')
  })
  it('resolves an uncaptured token to empty (never a literal token)', () => {
    expect(resolveRunVars('archive {{run.changeId}} now', {})).toBe('archive  now')
  })
})

// ── template registration (loop-template-catalog) ────────────────────────────
describe('opsx-lifecycle template', () => {
  it('is registered under the Automation category', () => {
    const t = getLoopTemplate('opsx-lifecycle')
    expect(t).toBeDefined()
    expect(t!.category).toBe('Automation')
  })
  it('has a valid graph', () => {
    expect(validateLoopGraph(opsxLifecycleGraph()).valid).toBe(true)
  })
  it('contains the lifecycle steps (ff → apply/test → validate shell → archive shell → end)', () => {
    const g = opsxLifecycleGraph()
    const prompts = g.nodes.filter((n) => n.type === 'ai-step').map((n) => String(n.data?.prompt))
    expect(prompts.some((p) => p.includes('{{cmd:opsx:ff}}'))).toBe(true)
    expect(prompts.some((p) => p.includes('{{cmd:opsx:apply}}'))).toBe(true)
    expect(prompts.some((p) => p.includes('{{cmd:opsx:verify}}'))).toBe(false)
    expect(g.nodes.some((n) => n.type === 'decider')).toBe(false)
    const shell = g.nodes.find((n) => n.id === 'archive')
    expect(shell?.data?.command).toContain('openspec archive {{run.changeId}} -y')
    expect(shell?.data?.requireRunVars).toEqual(['changeId'])
    expect(g.nodes.some((n) => n.type === 'end')).toBe(true)
    // No opsx:new step.
    expect(prompts.some((p) => p.includes('opsx:new'))).toBe(false)
  })

  it('continues a structured OpenSpec target when metadata provides openspecChangeName', () => {
    const g = opsxLifecycleGraph()
    const ff = g.nodes.find((n) => n.id === 'ff')!
    const prompt = interpolateSpec(String(ff.data?.prompt), {
      title: 'Follow-up',
      description: 'Tighten the small change',
      metadata: { openspecChangeName: 'add-sdd-quick-openspec' },
    })
    expect(prompt).toContain('add-sdd-quick-openspec')
    expect(prompt).toContain('CONTINUE that exact OpenSpec change')
    expect(prompt).toContain('create a duplicate')

    const withoutTarget = interpolateSpec(String(ff.data?.prompt), {
      title: 'New quick change',
      description: 'Create artifacts if needed',
    })
    expect(withoutTarget).not.toContain('{{spec.openspecChangeName}}')
    expect(withoutTarget).toContain('If both are blank, choose a new name')
  })

  it('keeps SDD Quick prompts artifact-authoritative before implementation', () => {
    const g = opsxLifecycleGraph()
    const ff = String(g.nodes.find((n) => n.id === 'ff')?.data?.prompt ?? '')
    const apply = String(g.nodes.find((n) => n.id === 'apply')?.data?.prompt ?? '')
    expect(ff).toContain('OpenSpec artifacts are authoritative')
    expect(ff).toContain('Do not implement code or run the repository test suite')
    expect(apply).toContain('Before editing code')
    expect(apply).toContain('amend the OpenSpec artifacts first')
  })

  it('neither AI step may archive the change — the loop archives it in a CLI step', () => {
    const g = opsxLifecycleGraph()
    const ff = String(g.nodes.find((n) => n.id === 'ff')?.data?.prompt ?? '')
    const apply = String(g.nodes.find((n) => n.id === 'apply')?.data?.prompt ?? '')
    expect(ff).toContain('Do NOT run `openspec archive` in this step')
    expect(ff).toContain('name that path in your final reply')
    expect(apply).toContain('never run `openspec archive`')
  })

  it('apply owns testing and cannot advance without reporting success', () => {
    const apply = opsxLifecycleGraph().nodes.find((n) => n.id === 'apply')!
    expect(apply.data?.requireVerificationPass).toBe(true)
    expect(String(apply.data?.prompt)).toContain('Run the relevant tests')
    expect(String(apply.data?.prompt)).toContain('{{const:VERIFICATION_FAIL}}')
  })

})

// ── engine integration: run the real template graph ──────────────────────────
let db: DbInstance
let broadcasts: WsMessage[]

beforeEach(() => {
  db = initDb(':memory:')
  broadcasts = []
})

function manager(executors: LoopExecutors): LoopRunManager {
  return new LoopRunManager(db, (m) => broadcasts.push(m), executors, () => 1000)
}

function baseReq() {
  return {
    loopId: 'opsx-lifecycle',
    loopName: 'OpenSpec Lifecycle',
    graph: opsxLifecycleGraph(),
    projectId: 'p1',
    cwd: '/repo',
    railIndex: 1,
    ticketId: 7,
    spec: { id: 7, title: 'Feature X', description: 'Build feature X' },
    provider: 'claude',
    model: 'sonnet',
  }
}

/** An ai-step mock where the ff step emits a change path (so changeId captures). */
function aiStepMock(opts: { ffEmitsChangeId?: boolean } = {}) {
  const ffEmits = opts.ffEmitsChangeId ?? true
  const prompts: string[] = []
  const fn = vi.fn(async (input: { prompt: string }) => {
    prompts.push(input.prompt)
    const isFf = input.prompt.includes('/opsx:ff')
    const text = isFf && ffEmits
      ? 'Created change at openspec/changes/my-change/ — generated artifacts.'
      : input.prompt.includes('/opsx:apply') ? 'VERIFICATION: PASS' : 'did the work'
    return { text, sessionId: 's1', cost: 0.01, tokens: 100, provider: 'claude', model: 'sonnet' }
  })
  return { fn, prompts }
}

describe('opsx-lifecycle run (engine integration)', () => {
  it('PASS on the first pass → captures change id and runs the unattended archive', async () => {
    const ai = aiStepMock()
    const runShell = vi.fn(async () => ({ stdout: 'archived', stderr: '', exitCode: 0, durationMs: 5 }))
    const runDecider = vi.fn(async () => ({ continue: false, reasoning: 'verify PASS', parsed: true, cost: 0.001, provider: 'claude', model: 'sonnet' }))
    const ex: LoopExecutors = { runAiStep: ai.fn, runShell, runDecider }

    const res = await manager(ex).run(baseReq())

    expect(res.outcome).toBe('success')
    expect(runShell).toHaveBeenCalledTimes(3)
    expect(ai.fn).toHaveBeenCalledTimes(2)
    expect(runDecider).not.toHaveBeenCalled()
    expect(runShell.mock.calls[0][0].command).toBe('openspec validate my-change --type change --strict --no-interactive')
    expect(runShell.mock.calls[2][0].command).toBe('openspec archive my-change -y')
  })

  it('failed CLI validation stops before archive without calling a decider', async () => {
    const ai = aiStepMock()
    const runShell = vi.fn(async () => ({ stdout: '', stderr: 'Invalid spec', exitCode: 1 }))
    const runDecider = vi.fn()
    const res = await manager({ runAiStep: ai.fn, runShell, runDecider }).run(baseReq())
    expect(res.outcome).toBe('failed')
    expect(runShell).toHaveBeenCalledTimes(2)
    expect(runShell.mock.calls[0][0].command).toContain('openspec validate my-change')
    expect(runDecider).not.toHaveBeenCalled()
  })

  it('retries only Apply after failed checks and keeps the same target', async () => {
    const ai = aiStepMock()
    ai.fn.mockResolvedValueOnce({ text: 'Created openspec/changes/my-change/', sessionId: 's1', cost: 0, tokens: 1, provider: 'claude', model: 'sonnet' })
      .mockResolvedValueOnce({ text: 'VERIFICATION: FAIL — tests failed', sessionId: 's1', cost: 0, tokens: 1, provider: 'claude', model: 'sonnet' })
    const runShell = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }))
    const res = await manager({ runAiStep: ai.fn, runShell, runDecider: vi.fn() }).run(baseReq())
    expect(res.outcome).toBe('success')
    expect(ai.fn).toHaveBeenCalledTimes(3)
    const retry = ai.fn.mock.calls[2][0].prompt
    expect(retry).toContain('/opsx:apply my-change')
    expect(retry).toContain('tests failed')
    expect(retry).not.toContain('/opsx:ff')
    expect(runShell).toHaveBeenCalledTimes(3)
  })

  it.each(['preflight', 'validate'])('repairs %s artifacts then revalidates without replaying implementation', async (phase) => {
    const ai = aiStepMock()
    let validations = 0
    const runShell = vi.fn(async ({ command }: { command: string }) => ({
      stdout: '', stderr: 'Missing scenario', exitCode: command.includes('validate') && ++validations === (phase === 'preflight' ? 1 : 2) ? 1 : 0,
    }))
    const res = await manager({ runAiStep: ai.fn, runShell, runDecider: vi.fn() }).run(baseReq())
    expect(res.outcome).toBe('success')
    expect(ai.prompts.filter((p) => p.startsWith('/opsx:apply'))).toHaveLength(1)
    expect(ai.prompts.filter((p) => p.startsWith('/opsx:ff'))).toHaveLength(1)
    const repair = ai.prompts.find((p) => p.includes('Repair ONLY'))!
    expect(repair).toContain('openspec/changes/my-change/')
    expect(repair).toContain('Missing scenario')
    expect(repair).toContain('Do not edit implementation code')
    expect(runShell).toHaveBeenCalledTimes(4)
  })

  it('bounds persistent Apply failure and never archives it', async () => {
    const runAiStep = vi.fn(async ({ prompt }: { prompt: string }) => ({ text: prompt.startsWith('/opsx:ff')
      ? 'openspec/changes/my-change/' : 'VERIFICATION: FAIL — failing regression' }))
    const runShell = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    const res = await manager({ runAiStep, runShell, runDecider: vi.fn() }).run(baseReq())
    expect(res.outcome).toBe('failed')
    expect(runAiStep).toHaveBeenCalledTimes(3)
    expect(runShell).toHaveBeenCalledTimes(1)
  })

  it('retries archive once without another AI call', async () => {
    const ai = aiStepMock()
    let archives = 0
    const runShell = vi.fn(async ({ command }: { command: string }) => ({
      stdout: '', stderr: '', exitCode: command.includes('archive') && ++archives === 1 ? 1 : 0,
    }))
    expect((await manager({ runAiStep: ai.fn, runShell, runDecider: vi.fn() }).run(baseReq())).outcome).toBe('success')
    expect(ai.fn).toHaveBeenCalledTimes(2)
    expect(runShell).toHaveBeenCalledTimes(4)
  })

  it('does not spend another call recovering a provider failure', async () => {
    const runAiStep = vi.fn(async ({ prompt }: { prompt: string }) => ({ text: prompt.startsWith('/opsx:ff')
      ? 'openspec/changes/my-change/' : 'Provider down', failed: prompt.startsWith('/opsx:apply') }))
    const runShell = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    expect((await manager({ runAiStep, runShell, runDecider: vi.fn() }).run(baseReq())).outcome).toBe('failed')
    expect(runAiStep).toHaveBeenCalledTimes(2)
    expect(runShell).toHaveBeenCalledTimes(1)
  })

  it('implements a complete new spec without addenda, PR, or predefined change name', async () => {
    const ai = aiStepMock()
    const runShell = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    const spec = { id: 7, title: 'New standalone feature', description: 'Implement the full login flow, including logout and expired sessions.' }
    const result = await manager({ runAiStep: ai.fn, runShell, runDecider: vi.fn() }).run({ ...baseReq(), loopId: 'factory:sdd-quick-openspec', spec })
    expect(result.outcome).toBe('success')
    expect(ai.prompts[0]).toContain(spec.description)
    expect(ai.prompts[0]).toContain('If both are blank, choose a new name')
    expect(ai.prompts[0]).not.toContain('DELTA OPENSPEC TARGET')
    expect(ai.prompts[1]).toContain('/opsx:apply my-change')
    expect(ai.fn).toHaveBeenCalledTimes(2)
    expect(runShell).toHaveBeenCalledTimes(3)
  })

  it('seeds the change id from the follow-up (else the spec metadata) when the step never names an active path', async () => {
    // Run 644eb404: the ff step created, implemented AND archived the change in
    // one go, so its prose never mentioned openspec/changes/<id>; validate then
    // refused to run and a green implementation settled failed.
    const ai = aiStepMock({ ffEmitsChangeId: false })
    const runShell = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 }))
    const ex: LoopExecutors = { runAiStep: ai.fn, runShell, runDecider: vi.fn() }
    const res = await manager(ex).run({
      ...baseReq(),
      spec: { id: 7, title: 'Feature X', description: 'd', metadata: { openspecChangeName: 'from-spec' } },
      followUp: { id: 'fu', version: 1, hash: 'h', briefing: 'scope', openspecChangeName: 'fix-promote-creation-and-uncertain-outcomes' },
    })
    expect(res.outcome).toBe('success')
    expect(runShell.mock.calls.map((c) => c[0].command)).toEqual([
      'openspec validate fix-promote-creation-and-uncertain-outcomes --type change --strict --no-interactive',
      'openspec validate fix-promote-creation-and-uncertain-outcomes --type change --strict --no-interactive',
      'openspec archive fix-promote-creation-and-uncertain-outcomes -y',
    ])
    const logs = broadcasts.filter((m): m is Extract<WsMessage, { type: 'log' }> => m.type === 'log')
    expect(logs.some((l) => l.line.includes('seeded from followUp: fix-promote-creation-and-uncertain-outcomes'))).toBe(true)

    broadcasts = []
    runShell.mockClear()
    const res2 = await manager(ex).run({ ...baseReq(), spec: { id: 7, title: 'F', description: 'd', metadata: { openspecChangeName: 'from-spec' } } })
    expect(res2.outcome).toBe('success')
    expect(runShell.mock.calls[2][0].command).toBe('openspec archive from-spec -y')
  })

  it.each([
    ['missing', 'VERIFICATION: PASS', 'failed'],
    ['partial', '- [a1] partial — files: ui.ts — tests: ui.test.ts\nVERIFICATION: PASS', 'failed'],
    ['no evidence', '- [a1] applied\nVERIFICATION: PASS', 'failed'],
    ['complete', '- [a1] applied — files: ui.ts — tests: ui.test.ts\nVERIFICATION: PASS', 'success'],
  ])('addendum scope has its own target and rejects %s coverage before archive', async (_label, output, outcome) => {
    const req = { ...baseReq(), runId: 'delta-run', spec: { ...baseReq().spec, openspecChangeName: 'old-completed-feature' }, addenda: { ids: ['a1'], briefing: 'Add module fields only; preserve pair selection.' } }
    const target = seedChangeId(req)!
    expect(target.source).toBe('addenda')
    expect(seedChangeId(req)).toEqual(target)
    expect(seedChangeId({ ...req, runId: 'retry' })?.id).not.toBe(target.id)
    const runAiStep = vi.fn(async () => ({ text: output }))
    const runShell = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }))
    const res = await manager({ runAiStep, runShell, runDecider: vi.fn() }).run(req)
    expect(res.outcome).toBe(outcome)
    for (const [call] of runAiStep.mock.calls as unknown as [{ prompt: string }][]) {
      expect(call.prompt).toContain(target.id)
      expect(call.prompt).toContain(req.addenda.briefing)
      expect(call.prompt).toContain('Create it if missing')
    }
    if (outcome === 'failed') expect(runShell).toHaveBeenCalledTimes(1)
    else expect(runShell.mock.calls.map((c) => (c as unknown as [{ command: string }])[0].command)).toEqual([
      `openspec validate ${target.id} --type change --strict --no-interactive`, `openspec validate ${target.id} --type change --strict --no-interactive`, `openspec archive ${target.id} -y`,
    ])
  })

  it('freezes addenda across a recovery even when the caller mutates them', async () => {
    const req = { ...baseReq(), addenda: { ids: ['a1'], briefing: 'Frozen requested behavior' } }
    const prompts: string[] = []
    const runAiStep = vi.fn(async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt)
      req.addenda.ids[0] = 'a2'
      req.addenda.briefing = 'Changed after launch'
      return { text: prompts.length === 2 ? 'VERIFICATION: FAIL — missing evidence' : '- [a1] applied — files: ui.ts — tests: ui.test.ts\nVERIFICATION: PASS' }
    })
    const runShell = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    expect((await manager({ runAiStep, runShell, runDecider: vi.fn() }).run(req)).outcome).toBe('success')
    expect(prompts).toHaveLength(3)
    for (const prompt of prompts) {
      expect(prompt).toContain('Frozen requested behavior')
      expect(prompt).not.toContain('Changed after launch')
    }
  })

  it('keeps cost limits in force before recovery', async () => {
    const runAiStep = vi.fn(async ({ prompt }: { prompt: string }) => ({ text: prompt.startsWith('/opsx:ff')
      ? 'openspec/changes/my-change/' : 'VERIFICATION: FAIL — failing regression', cost: 0.01, tokens: 100 }))
    const runShell = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    const req = baseReq()
    req.graph.config.maxCostUsd = 0.015
    const result = await manager({ runAiStep, runShell, runDecider: vi.fn() }).run(req)
    expect(result.outcome).toBe('max-cost')
    expect(runAiStep).toHaveBeenCalledTimes(2)
  })

  it('records phase context sizes and preserves unavailable usage instead of inventing zeroes', async () => {
    const runAiStep = vi.fn(async ({ prompt }: { prompt: string }) => ({ text: prompt.startsWith('/opsx:ff')
      ? 'openspec/changes/my-change/' : 'VERIFICATION: PASS', tokensIn: 123, tokensCacheRead: 45 }))
    const runShell = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    await manager({ runAiStep, runShell, runDecider: vi.fn() }).run(baseReq())
    const metrics = broadcasts.filter((m) => m.type === 'event' && m.event_type === 'loop_phase_metrics')
      .map((m) => JSON.parse((m as { payload: string }).payload))
    expect(metrics).toHaveLength(2)
    expect(metrics[0]).toMatchObject({ nodeId: 'ff', recovery: false, tokensIn: 123, tokensCacheRead: 45, tokensOut: null, costUsd: null })
    expect(metrics[0].promptChars).toBe(runAiStep.mock.calls[0][0].prompt.length)
  })

  it.each([
    { target: 'missing', maxRetries: 1 },
    { target: 'apply', maxRetries: 100 },
    { target: 'ff', maxRetries: 1 },
    { target: 'archive', maxRetries: 1, artifactOnly: true },
  ])('rejects unsafe recovery metadata %j', (policy) => {
    const graph = opsxLifecycleGraph()
    graph.nodes.find((node) => node.id === 'apply')!.data!.failureRecovery = policy
    expect(validateLoopGraph(graph).valid).toBe(false)
  })

  it('seedChangeId prefers the follow-up, falls back to the spec, and rejects malformed names', () => {
    expect(seedChangeId({ followUp: { id: 'f', version: 1, hash: 'h', briefing: '', openspecChangeName: 'a-b' }, spec: { openspecChangeName: 'c' } })).toEqual({ id: 'a-b', source: 'followUp' })
    expect(seedChangeId({ spec: { openspecChangeName: ' c ' } })).toEqual({ id: 'c', source: 'spec' })
    expect(seedChangeId({ spec: { metadata: { openspecChangeName: 'meta' } } })).toEqual({ id: 'meta', source: 'spec' })
    expect(seedChangeId({ followUp: { id: 'f', version: 1, hash: 'h', briefing: '', openspecChangeName: '../etc' }, spec: {} })).toBeUndefined()
    expect(seedChangeId({})).toBeUndefined()
  })

  it('a change the AI step already archived makes validate + archive successful no-ops instead of failing the run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opsx-archived-'))
    try {
      fs.mkdirSync(path.join(dir, 'openspec', 'changes', 'archive', '2026-09-22-my-change'), { recursive: true })
      expect(openspecChangeState(dir, 'my-change')).toBe('archived')
      expect(openspecChangeState(dir, 'other')).toBe('missing')
      fs.mkdirSync(path.join(dir, 'openspec', 'changes', 'live'), { recursive: true })
      expect(openspecChangeState(dir, 'live')).toBe('active')
      expect(openspecChangeState(undefined, 'live')).toBe('missing')

      const ai = aiStepMock()
      const runShell = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 }))
      const res = await manager({ runAiStep: ai.fn, runShell, runDecider: vi.fn() }).run({ ...baseReq(), cwd: dir })
      expect(res.outcome).toBe('success')
      expect(runShell).not.toHaveBeenCalled()
      const logs = broadcasts.filter((m): m is Extract<WsMessage, { type: 'log' }> => m.type === 'log')
      expect(logs.filter((l) => l.line.includes('already archived')).length).toBe(3)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an ACTIVE change still runs the real validate + archive commands', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opsx-active-'))
    try {
      fs.mkdirSync(path.join(dir, 'openspec', 'changes', 'my-change'), { recursive: true })
      const ai = aiStepMock()
      const runShell = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 }))
      const res = await manager({ runAiStep: ai.fn, runShell, runDecider: vi.fn() }).run({ ...baseReq(), cwd: dir })
      expect(res.outcome).toBe('success')
      expect(runShell).toHaveBeenCalledTimes(3)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('archive guard: no change id captured → refuses to archive and fails', async () => {
    const ai = aiStepMock({ ffEmitsChangeId: false })
    const runShell = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    const runDecider = vi.fn(async () => ({ continue: false, reasoning: 'PASS', parsed: true }))
    const ex: LoopExecutors = { runAiStep: ai.fn, runShell, runDecider }

    const res = await manager(ex).run(baseReq())

    expect(res.outcome).toBe('failed')
    expect(runShell).not.toHaveBeenCalled()
    // A clear, honest reason was logged.
    const logs = broadcasts.filter((m): m is Extract<WsMessage, { type: 'log' }> => m.type === 'log')
    expect(logs.some((l) => l.line.includes('required run variable'))).toBe(true)
  })
})
