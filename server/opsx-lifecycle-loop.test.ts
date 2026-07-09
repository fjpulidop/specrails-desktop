/**
 * Tests for the OpenSpec-lifecycle loop template (opsx-lifecycle) and the engine
 * support it relies on: the opsx:* provider-native magic commands, the
 * `{{run.changeId}}` run-scoped capture, and the shell `requireRunVars` archive
 * guard. See openspec/changes/opsx-lifecycle-loop-template.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDb, type DbInstance } from './db'
import { expandCommands, getLoopCommand } from './loop-command-catalog'
import {
  LoopRunManager,
  resolveRunVars,
  extractChangeId,
  type LoopExecutors,
} from './loop-run-manager'
import { getLoopTemplate, opsxLifecycleGraph } from './loop-templates'
import { interpolateSpec, validateLoopGraph } from './loop-graph'
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
  it('contains the lifecycle steps (ff → apply → verify → decider → archive shell → end)', () => {
    const g = opsxLifecycleGraph()
    const prompts = g.nodes.filter((n) => n.type === 'ai-step').map((n) => String(n.data?.prompt))
    expect(prompts.some((p) => p.includes('{{cmd:opsx:ff}}'))).toBe(true)
    expect(prompts.some((p) => p.includes('{{cmd:opsx:apply}}'))).toBe(true)
    expect(prompts.some((p) => p.includes('{{cmd:opsx:verify}}'))).toBe(true)
    expect(g.nodes.some((n) => n.type === 'decider')).toBe(true)
    const shell = g.nodes.find((n) => n.type === 'shell')
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
    expect(prompt).toContain('do NOT create a duplicate')

    const withoutTarget = interpolateSpec(String(ff.data?.prompt), {
      title: 'New quick change',
      description: 'Create artifacts if needed',
    })
    expect(withoutTarget).not.toContain('{{spec.openspecChangeName}}')
    expect(withoutTarget).toContain('If this value is non-blank')
  })

  it('keeps SDD Quick prompts artifact-authoritative before implementation', () => {
    const g = opsxLifecycleGraph()
    const ff = String(g.nodes.find((n) => n.id === 'ff')?.data?.prompt ?? '')
    const apply = String(g.nodes.find((n) => n.id === 'apply')?.data?.prompt ?? '')
    expect(ff).toContain('OpenSpec artifacts are authoritative')
    expect(ff).toContain('amend the relevant OpenSpec artifacts before any code changes')
    expect(apply).toContain('Before editing code')
    expect(apply).toContain('amend the OpenSpec artifacts first')
  })

  it('verify prompt fails OpenSpec contract drift', () => {
    const g = opsxLifecycleGraph()
    const verify = String(g.nodes.find((n) => n.id === 'verify')?.data?.prompt ?? '')
    const decider = String(g.nodes.find((n) => n.id === 'decide')?.data?.goal ?? '')
    expect(verify).toContain('Report FAIL if the implementation diverges from the active OpenSpec artifacts')
    expect(verify).toContain('{{const:VERIFICATION_FAIL}}')
    expect(decider).toContain('active OpenSpec artifacts')
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
      : 'did the work'
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
    expect(runShell).toHaveBeenCalledTimes(1)
    expect(runShell.mock.calls[0][0].command).toBe('openspec archive my-change -y')
  })

  it('FAIL then PASS → loops back to ff (same change id) and finally archives', async () => {
    const ai = aiStepMock()
    const runShell = vi.fn(async () => ({ stdout: 'archived', stderr: '', exitCode: 0, durationMs: 5 }))
    // First decider: FAIL (continue → loop back). Second: PASS (stop → archive).
    const runDecider = vi.fn()
      .mockResolvedValueOnce({ continue: true, reasoning: 'missing X', parsed: true })
      .mockResolvedValueOnce({ continue: false, reasoning: 'now complete', parsed: true })
    const ex: LoopExecutors = { runAiStep: ai.fn, runShell, runDecider }

    const res = await manager(ex).run(baseReq())

    expect(res.outcome).toBe('success')
    expect(runDecider).toHaveBeenCalledTimes(2)
    // ff ran twice (initial + loop-back).
    const ffPrompts = ai.prompts.filter((p) => p.includes('/opsx:ff'))
    expect(ffPrompts.length).toBe(2)
    // The second ff names the captured change id (continue the SAME change) and
    // carries the cross-iteration context (verify's gaps).
    expect(ffPrompts[1]).toContain('my-change')
    expect(ffPrompts[1]).toContain('Context from previous iterations')
    expect(runShell.mock.calls[0][0].command).toBe('openspec archive my-change -y')
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
