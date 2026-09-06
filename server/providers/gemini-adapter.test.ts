import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, execSync: vi.fn() }
})

import { execSync } from 'child_process'
import { geminiAdapter, _GEMINI_MIN_VERSION, _compareSemver } from './gemini-adapter'
import type { AdapterEvent } from './types'

const mockExec = vi.mocked(execSync)

const FIXTURES_DIR = join(__dirname, '__fixtures__', 'gemini', _GEMINI_MIN_VERSION)

function parseFixture(name: string): AdapterEvent[] {
  const raw = readFileSync(join(FIXTURES_DIR, name), 'utf8')
  return raw
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((l) => geminiAdapter.parseStreamLine(l))
    .filter((e): e is AdapterEvent => e !== null)
}

describe('geminiAdapter — identity', () => {
  it('exposes expected conventions', () => {
    expect(geminiAdapter.id).toBe('gemini')
    expect(geminiAdapter.displayName).toBe('Gemini CLI')
    expect(geminiAdapter.binary).toBe('gemini')
    expect(geminiAdapter.projectDirName).toBe('.gemini')
    expect(geminiAdapter.instructionsFilename).toBe('GEMINI.md')
    expect(geminiAdapter.mcpRegistration).toBe('project-json')
    expect(geminiAdapter.minCliVersion).toBe('0.11.0')
  })

  it('declares capabilities matching gemini-cli 0.11 behaviour', () => {
    const c = geminiAdapter.capabilities
    expect(c.nativeResume).toBe(true)
    expect(c.nativeStreamJson).toBe(true)
    expect(c.nativeCostUsd).toBe(false)
    // Gemini emits OTLP natively (GEMINI_TELEMETRY_*) — unlike codex, no bridge.
    expect(c.nativeOtelEnv).toBe(true)
    expect(c.profileEnvSupport).toBe(true)
    // No --system-prompt flag (the CLI uses GEMINI_SYSTEM_MD env) → fold.
    expect(c.systemPromptArg).toBe(false)
  })

  it('reports the same baseline rail agents as claude/codex', () => {
    expect([...geminiAdapter.baselineAgents()].sort()).toEqual([
      'sr-architect',
      'sr-developer',
      'sr-reviewer',
    ])
  })

  it('reports a model catalog with gemini-3.5-flash default', () => {
    const cat = geminiAdapter.modelCatalog()
    expect(cat.length).toBeGreaterThan(0)
    const defaults = cat.filter((m) => m.default === true)
    expect(defaults).toHaveLength(1)
    expect(defaults[0].value).toBe('gemini-3.5-flash')
    expect(geminiAdapter.defaultModel()).toBe('gemini-3.5-flash')
  })
})

describe('geminiAdapter._compareSemver', () => {
  it('compares versions correctly', () => {
    expect(_compareSemver('0.11.0', '0.11.0')).toBe(0)
    expect(_compareSemver('0.12.0', '0.11.0')).toBe(1)
    expect(_compareSemver('0.10.99', '0.11.0')).toBe(-1)
    expect(_compareSemver('1.0.0', '0.11.0')).toBe(1)
  })
})

describe('geminiAdapter.buildArgs', () => {
  it('chat-turn passes user prompt as-is, ignoring systemPrompt (GEMINI.md carries the framing)', () => {
    const args = geminiAdapter.buildArgs('chat-turn', {
      prompt: 'user msg',
      systemPrompt: 'sys',
      model: 'gemini-3.1-flash-lite',
    })
    expect(args.slice(0, 2)).toEqual(['-p', 'user msg'])
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.1-flash-lite')
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json')
    expect(args).toContain('--yolo')
    // No fold, no system text, no --system-prompt flag.
    expect(args.some((a) => a.includes('sys\n\n---\n\n'))).toBe(false)
    expect(args.some((a) => a === 'sys')).toBe(false)
    expect(args).not.toContain('--system-prompt')
    expect(args).not.toContain('--resume')
  })

  it('chat-turn preserves short user prompts verbatim even with a long systemPrompt', () => {
    const longSys = 'You have explicit permission to read and write spec files — '.repeat(20)
    const args = geminiAdapter.buildArgs('chat-turn', {
      prompt: 'quiero hacer un tetris',
      systemPrompt: longSys,
      model: 'gemini-3.5-flash',
    })
    expect(args).toContain('quiero hacer un tetris')
    expect(args.some((a) => a.includes('explicit permission'))).toBe(false)
  })

  it('toolPolicy=read-only selects plan mode without yolo for a fresh chat', () => {
    const args = geminiAdapter.buildArgs('chat-turn', {
      prompt: 'inspect only',
      model: 'gemini-3.5-flash',
      toolPolicy: 'read-only',
    })
    expect(args.slice(args.indexOf('--approval-mode'), args.indexOf('--approval-mode') + 2))
      .toEqual(['--approval-mode', 'plan'])
    expect(args).not.toContain('--yolo')
    expect(args).not.toContain('-y')
  })

  it('chat-resume requires sessionId and passes --resume <id> with user-only prompt', () => {
    expect(() =>
      geminiAdapter.buildArgs('chat-resume', { prompt: 'x', model: 'gemini-3.5-flash' }),
    ).toThrow(/sessionId/)

    const args = geminiAdapter.buildArgs('chat-resume', {
      prompt: 'next msg',
      systemPrompt: 'sys',
      sessionId: '11111111-2222-3333-4444-555555555555',
      model: 'gemini-3.5-flash',
    })
    expect(args.slice(0, 2)).toEqual(['-p', 'next msg'])
    expect(args[args.indexOf('--resume') + 1]).toBe('11111111-2222-3333-4444-555555555555')
    expect(args.some((a) => a === 'sys')).toBe(false)
    expect(args.some((a) => a.includes('sys\n\n---\n\n'))).toBe(false)
  })

  it('toolPolicy=read-only preserves plan mode without yolo on resume', () => {
    const args = geminiAdapter.buildArgs('chat-resume', {
      prompt: 'continue inspecting',
      model: 'gemini-3.5-flash',
      sessionId: '11111111-2222-3333-4444-555555555555',
      toolPolicy: 'read-only',
    })
    expect(args).toContain('--resume')
    expect(args.slice(args.indexOf('--approval-mode'), args.indexOf('--approval-mode') + 2))
      .toEqual(['--approval-mode', 'plan'])
    expect(args).not.toContain('--yolo')
    expect(args).not.toContain('-y')
  })

  it('chat-stream throws (no persistent stdin transport)', () => {
    expect(() =>
      geminiAdapter.buildArgs('chat-stream', { prompt: 'x', model: 'gemini-3.5-flash' }),
    ).toThrow(/persistent stdin/)
  })

  it('rail-job folds the system prompt into the user prompt', () => {
    const args = geminiAdapter.buildArgs('rail-job', {
      prompt: '/specrails:implement #1',
      systemPrompt: 'pipeline ctx',
      model: 'gemini-3.5-flash',
    })
    expect(args[0]).toBe('-p')
    expect(args[1]).toBe('pipeline ctx\n\n---\n\n/specrails:implement #1')
    expect(args).toContain('--yolo')
  })

  it('spec-gen, agent-refine, auto-title, setup-enrich all fold + use stream-json', () => {
    for (const action of ['spec-gen', 'agent-refine', 'auto-title', 'setup-enrich'] as const) {
      const args = geminiAdapter.buildArgs(action, {
        prompt: 'p',
        systemPrompt: 'S',
        model: 'gemini-3.5-flash',
      })
      expect(args[0]).toBe('-p')
      expect(args[1]).toBe('S\n\n---\n\np')
      expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json')
    }
  })

  it('setup-enrich-resume requires sessionId and passes --resume', () => {
    expect(() =>
      geminiAdapter.buildArgs('setup-enrich-resume', { prompt: 'x', model: 'gemini-3.5-flash' }),
    ).toThrow(/sessionId/)

    const args = geminiAdapter.buildArgs('setup-enrich-resume', {
      prompt: 'cont',
      sessionId: 'UUID',
      model: 'gemini-3.5-flash',
    })
    expect(args[args.indexOf('--resume') + 1]).toBe('UUID')
  })

  it('extraArgs append at the end', () => {
    const args = geminiAdapter.buildArgs('chat-turn', {
      prompt: 'p',
      model: 'gemini-3.5-flash',
      extraArgs: ['--include-directories', '/extra'],
    })
    expect(args.slice(-2)).toEqual(['--include-directories', '/extra'])
  })
})

describe('geminiAdapter.parseStreamLine', () => {
  it('returns null for empty input', () => {
    expect(geminiAdapter.parseStreamLine('')).toBeNull()
  })

  it('returns null for non-JSON', () => {
    expect(geminiAdapter.parseStreamLine('not json')).toBeNull()
  })

  it('parses init as session-started', () => {
    const ev = geminiAdapter.parseStreamLine(
      '{"type":"init","session_id":"11111111-2222-3333-4444-555555555555","model":"gemini-2.5-pro"}',
    )
    expect(ev).toEqual({ kind: 'session-started', sessionId: '11111111-2222-3333-4444-555555555555' })
  })

  it('parses init without session_id as other', () => {
    const ev = geminiAdapter.parseStreamLine('{"type":"init","model":"gemini-2.5-pro"}')
    expect(ev?.kind).toBe('other')
  })

  it('parses assistant message as text-delta', () => {
    const ev = geminiAdapter.parseStreamLine(
      '{"type":"message","role":"assistant","content":"hi","delta":true}',
    )
    expect(ev).toEqual({ kind: 'text-delta', text: 'hi' })
  })

  it('ignores the user echo message (kind other)', () => {
    const ev = geminiAdapter.parseStreamLine('{"type":"message","role":"user","content":"prompt"}')
    expect(ev?.kind).toBe('other')
  })

  it('parses tool_use as tool-use with a truncated preview', () => {
    const ev = geminiAdapter.parseStreamLine(
      '{"type":"tool_use","tool_name":"read_file","tool_id":"t0","parameters":{"path":"a.ts"}}',
    )
    expect(ev?.kind).toBe('tool-use')
    if (ev?.kind === 'tool-use') {
      expect(ev.name).toBe('read_file')
      expect(ev.inputPreview).toContain('a.ts')
    }
  })

  it('parses tool_result as other', () => {
    const ev = geminiAdapter.parseStreamLine('{"type":"tool_result","tool_id":"t0","status":"ok"}')
    expect(ev?.kind).toBe('other')
  })

  it('parses result as result', () => {
    const ev = geminiAdapter.parseStreamLine(
      '{"type":"result","status":"success","stats":{"input_tokens":1,"output_tokens":2}}',
    )
    expect(ev?.kind).toBe('result')
    if (ev?.kind === 'result') expect(ev.payload.type).toBe('result')
  })

  it('parses an unknown event type as other', () => {
    const ev = geminiAdapter.parseStreamLine('{"type":"thought","content":"hmm"}')
    expect(ev?.kind).toBe('other')
    if (ev?.kind === 'other') expect(ev.type).toBe('thought')
  })

  it('parses a typeless object as other <missing>', () => {
    const ev = geminiAdapter.parseStreamLine('{"foo":"bar"}')
    expect(ev?.kind).toBe('other')
    if (ev?.kind === 'other') expect(ev.type).toBe('<missing>')
  })
})

describe('geminiAdapter.extractResult — fixture-based', () => {
  it('extracts tokens, cache, session, and turns from the hello stream', () => {
    const events = parseFixture('hello-3-words.jsonl')
    const result = geminiAdapter.extractResult(events)
    expect(result.session_id).toBe('11111111-2222-3333-4444-555555555555')
    expect(result.tokens_in).toBe(120)
    expect(result.tokens_out).toBe(3)
    expect(result.tokens_cache_read).toBe(40)
    expect(result.tokens_cache_create).toBeUndefined()
    expect(result.num_turns).toBe(1)
    expect(result.duration_ms).toBe(850)
    // Cost is never native — estimated downstream via pricing.ts.
    expect(result.total_cost_usd).toBeUndefined()
  })

  it('handles a tool-use stream and captures its session', () => {
    const events = parseFixture('tool-use.jsonl')
    const result = geminiAdapter.extractResult(events)
    expect(result.session_id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(result.tokens_in).toBe(500)
    expect(result.tokens_cache_read).toBe(0)
    expect(events.some((e) => e.kind === 'tool-use')).toBe(true)
  })

  it('returns only the session id when no result event arrived', () => {
    const events: AdapterEvent[] = [{ kind: 'session-started', sessionId: 'sid' }]
    expect(geminiAdapter.extractResult(events)).toEqual({ session_id: 'sid' })
  })

  it('returns an empty result for an empty stream', () => {
    expect(geminiAdapter.extractResult([])).toEqual({ session_id: undefined })
  })
})

describe('geminiAdapter.detectInstalled', () => {
  beforeEach(() => {
    mockExec.mockReset()
  })

  it('reports not installed when `which gemini` throws', async () => {
    mockExec.mockImplementationOnce(() => {
      throw new Error('not found')
    })
    expect(await geminiAdapter.detectInstalled()).toEqual({ installed: false, executable: false })
  })

  it('reports executable + meetsMinimum for a recent version', async () => {
    mockExec
      .mockImplementationOnce(() => Buffer.from('')) // which
      .mockImplementationOnce(() => '0.12.3\n') // --version
    const res = await geminiAdapter.detectInstalled()
    expect(res.installed).toBe(true)
    expect(res.executable).toBe(true)
    expect(res.version).toBe('0.12.3')
    expect(res.meetsMinimum).toBe(true)
    expect(res.error).toBeUndefined()
  })

  it('flags an older version with an upgrade hint', async () => {
    mockExec
      .mockImplementationOnce(() => Buffer.from(''))
      .mockImplementationOnce(() => '0.10.0\n')
    const res = await geminiAdapter.detectInstalled()
    expect(res.meetsMinimum).toBe(false)
    expect(res.error).toMatch(/older than required/)
  })

  it('reports installed but not executable when --version throws', async () => {
    mockExec
      .mockImplementationOnce(() => Buffer.from(''))
      .mockImplementationOnce(() => {
        throw new Error('boom')
      })
    expect(await geminiAdapter.detectInstalled()).toEqual({ installed: true, executable: false })
  })
})


describe('coordinated workspace scope', () => {
  it('includes each selected repository in first and resumed provider workspaces', () => {
    const extraArgs = geminiAdapter.buildRepoAccessArgs(['/work/backend', '/work/front end'])
    expect(extraArgs).toEqual(['--include-directories', '/work/backend', '--include-directories', '/work/front end'])
    for (const action of ['rail-job', 'chat-resume'] as const) {
      const args = geminiAdapter.buildArgs(action, { prompt: 'implement', model: 'gemini-3.5-flash', sessionId: 's', extraArgs })
      expect(args.slice(-extraArgs.length)).toEqual(extraArgs)
    }
  })
})
