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
    expect(runShell).toHaveBeenCalledTimes(2)
    expect(ai.fn).toHaveBeenCalledTimes(2)
    expect(runDecider).not.toHaveBeenCalled()
    expect(runShell.mock.calls[0][0].command).toBe('openspec validate my-change --type change --strict --no-interactive')
    expect(runShell.mock.calls[1][0].command).toBe('openspec archive my-change -y')
  })

  it('failed CLI validation stops before archive without calling a decider', async () => {
    const ai = aiStepMock()
    const runShell = vi.fn(async () => ({ stdout: '', stderr: 'Invalid spec', exitCode: 1 }))
    const runDecider = vi.fn()
    const res = await manager({ runAiStep: ai.fn, runShell, runDecider }).run(baseReq())
    expect(res.outcome).toBe('failed')
    expect(runShell).toHaveBeenCalledTimes(1)
    expect(runShell.mock.calls[0][0].command).toContain('openspec validate my-change')
    expect(runDecider).not.toHaveBeenCalled()
  })

  it('failed Apply tests stop before validation and archive', async () => {
    const ai = aiStepMock()
    ai.fn.mockResolvedValueOnce({ text: 'Created openspec/changes/my-change/', sessionId: 's1', cost: 0, tokens: 1, provider: 'claude', model: 'sonnet' })
      .mockResolvedValueOnce({ text: 'VERIFICATION: FAIL — tests failed', sessionId: 's1', cost: 0, tokens: 1, provider: 'claude', model: 'sonnet' })
    const runShell = vi.fn()
    const runDecider = vi.fn()
    const res = await manager({ runAiStep: ai.fn, runShell, runDecider }).run(baseReq())
    expect(res.outcome).toBe('failed')
    expect(runShell).not.toHaveBeenCalled()
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
