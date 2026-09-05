import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, execSync: vi.fn() }
})

import { execSync } from 'child_process'
import { codexAdapter, _CODEX_MIN_VERSION, _compareSemver } from './codex-adapter'
import type { AdapterEvent } from './types'

const mockExec = vi.mocked(execSync)

const FIXTURES_BASE = join(__dirname, '__fixtures__', 'codex')
const FIXTURES_DIR = join(FIXTURES_BASE, _CODEX_MIN_VERSION)

function parseFixture(name: string): AdapterEvent[] {
  const raw = readFileSync(join(FIXTURES_DIR, name), 'utf8')
  return raw
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((l) => codexAdapter.parseStreamLine(l))
    .filter((e): e is AdapterEvent => e !== null)
}

describe('codexAdapter — identity', () => {
  it('exposes expected conventions', () => {
    expect(codexAdapter.id).toBe('codex')
    expect(codexAdapter.displayName).toBe('Codex CLI')
    expect(codexAdapter.binary).toBe('codex')
    expect(codexAdapter.projectDirName).toBe('.codex')
    expect(codexAdapter.instructionsFilename).toBe('AGENTS.md')
    expect(codexAdapter.mcpRegistration).toBe('cli-add')
    expect(codexAdapter.minCliVersion).toBe('0.128.0')
  })

  it('declares capabilities matching codex 0.128.0 behaviour', () => {
    const c = codexAdapter.capabilities
    expect(c.nativeResume).toBe(true)
    expect(c.nativeStreamJson).toBe(true)
    expect(c.nativeCostUsd).toBe(false)
    expect(c.nativeOtelEnv).toBe(false)
    expect(c.profileEnvSupport).toBe(true)
    expect(c.systemPromptArg).toBe(false)
  })

  it('reports the same baseline rail agents as claude', () => {
    expect([...codexAdapter.baselineAgents()].sort()).toEqual([
      'sr-architect',
      'sr-developer',
      'sr-reviewer',
    ])
  })

  it('reports a model catalog with gpt-5.5 default', () => {
    const cat = codexAdapter.modelCatalog()
    expect(cat.length).toBeGreaterThan(0)
    const defaults = cat.filter((m) => m.default === true)
    expect(defaults).toHaveLength(1)
    expect(defaults[0].value).toBe('gpt-5.5')
    expect(codexAdapter.defaultModel()).toBe('gpt-5.5')
  })

  it('catalogs gpt-6-astra first, then the GPT-5.6 family (sol/terra/luna), ahead of gpt-5.5', () => {
    const values = codexAdapter.modelCatalog().map((m) => m.value)
    expect(values.slice(0, 4)).toEqual(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    expect(values).toContain('gpt-5.5')
    // Adding a model never moves the default.
    expect(codexAdapter.defaultModel()).toBe('gpt-5.5')
    expect(codexAdapter.modelCatalog().find((m) => m.value === 'gpt-6-astra')).toEqual({ value: 'gpt-6-astra', label: 'GPT-6 Astra' })
  })

  it('advertises the GPT-5.6 reasoning tiers (xhigh/max/ultra)', () => {
    const efforts = codexAdapter.capabilities.reasoningEfforts ?? []
    for (const level of ['xhigh', 'max', 'ultra']) expect(efforts).toContain(level)
  })

  it('preserves the relocated-repo writable_roots contract', () => {
    expect(codexAdapter.buildRepoAccessArgs(['/repo', '/workspace'])).toEqual([
      '-c',
      'sandbox_workspace_write.writable_roots=["/repo", "/workspace"]',
    ])
  })
})

describe('codexAdapter._compareSemver', () => {
  it('compares versions correctly', () => {
    expect(_compareSemver('0.128.0', '0.128.0')).toBe(0)
    expect(_compareSemver('0.128.1', '0.128.0')).toBe(1)
    expect(_compareSemver('0.127.99', '0.128.0')).toBe(-1)
    expect(_compareSemver('1.0.0', '0.128.0')).toBe(1)
  })
})

describe('codexAdapter.buildArgs', () => {
  it('chat-turn passes user prompt as-is, ignoring systemPrompt (AGENTS.md carries the framing)', () => {
    const args = codexAdapter.buildArgs('chat-turn', {
      prompt: 'user msg',
      systemPrompt: 'sys',
      model: 'gpt-5.4-mini',
    })
    expect(args[0]).toBe('exec')
    expect(args).toContain('--json')
    expect(args).toContain('--sandbox')
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write')
    expect(args).toContain('--skip-git-repo-check')
    const modelIdx = args.indexOf('--model')
    expect(args[modelIdx + 1]).toBe('gpt-5.4-mini')
    // User prompt MUST appear verbatim — no fold, no system text leaking in
    expect(args).toContain('user msg')
    expect(args.some((a) => a.includes('sys\n\n---\n\n'))).toBe(false)
    expect(args.some((a) => a === 'sys')).toBe(false)
    expect(args).not.toContain('--system-prompt')
  })

  it('chat-turn passes prompt through unchanged when no systemPrompt', () => {
    const args = codexAdapter.buildArgs('chat-turn', {
      prompt: 'just user',
      model: 'gpt-5.4-mini',
    })
    expect(args.find((a) => a === 'just user')).toBe('just user')
  })

  it('toolPolicy=read-only selects the native read-only sandbox for a fresh chat', () => {
    const args = codexAdapter.buildArgs('chat-turn', {
      prompt: 'inspect only',
      model: 'gpt-5.5',
      toolPolicy: 'read-only',
    })
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2))
      .toEqual(['--sandbox', 'read-only'])
    expect(args).not.toContain('workspace-write')
    expect(args).not.toContain('danger-full-access')
  })

  it('chat-turn preserves short user prompts verbatim even with a long systemPrompt', () => {
    // Regression: a short Explore turn ("quiero hacer un tetris") was being
    // drowned out by a long system prompt that codex echoed back instead of
    // responding to. The argv must carry ONLY the user text.
    const longSys = 'You have explicit permission to read and write .specrails/local-tickets.json — '.repeat(20)
    const args = codexAdapter.buildArgs('chat-turn', {
      prompt: 'quiero hacer un tetris',
      systemPrompt: longSys,
      model: 'gpt-5.4-mini',
    })
    expect(args).toContain('quiero hacer un tetris')
    expect(args.some((a) => a.includes('local-tickets.json'))).toBe(false)
  })

  it('chat-resume produces exec resume <UUID> <prompt> --model <m> with no folded systemPrompt', () => {
    expect(() =>
      codexAdapter.buildArgs('chat-resume', { prompt: 'x', model: 'gpt-5.4-mini' }),
    ).toThrow(/sessionId/)

    const args = codexAdapter.buildArgs('chat-resume', {
      prompt: 'next msg',
      systemPrompt: 'sys',
      sessionId: '019e37c6-3bd4-7120-992f-6f96dc82eda1',
      model: 'gpt-5.4-mini',
    })
    expect(args.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(args).toContain('--json')
    // Session id appears as a positional arg
    expect(args).toContain('019e37c6-3bd4-7120-992f-6f96dc82eda1')
    expect(args.find((a) => a === 'next msg')).toBe('next msg')
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.4-mini')
    // systemPrompt is intentionally dropped for resume turns too (AGENTS.md
    // in explore-cwd is the system context).
    expect(args.some((a) => a.includes('sys\n\n---\n\n'))).toBe(false)
    expect(args.some((a) => a === 'sys')).toBe(false)
    // `codex exec resume` rejects `--sandbox`; the policy must travel as a
    // `-c` config override instead. Asserting both: no bare `--sandbox`,
    // sandbox_mode override present.
    expect(args).not.toContain('--sandbox')
    expect(args).toContain('-c')
    expect(args).toContain('sandbox_mode="workspace-write"')
  })

  it('toolPolicy=read-only carries the native read-only sandbox through resume config', () => {
    const args = codexAdapter.buildArgs('chat-resume', {
      prompt: 'continue inspecting',
      model: 'gpt-5.5',
      sessionId: '019e37c6-3bd4-7120-992f-6f96dc82eda1',
      toolPolicy: 'read-only',
    })
    expect(args).not.toContain('--sandbox')
    expect(args).toContain('sandbox_mode="read-only"')
    expect(args).not.toContain('sandbox_mode="workspace-write"')
    expect(args).not.toContain('danger-full-access')
  })

  it('rail-job uses full-access sandbox for headless implementation rails', () => {
    const args = codexAdapter.buildArgs('rail-job', {
      prompt: '/specrails:implement #1',
      systemPrompt: 'pipeline ctx',
      model: 'gpt-5.4-mini',
    })
    expect(args[0]).toBe('exec')
    expect(args).toContain('--sandbox')
    expect(args[args.indexOf('--sandbox') + 1]).toBe('danger-full-access')
    expect(args.find((a) => a.startsWith('pipeline ctx'))).toBe(
      'pipeline ctx\n\n---\n\n/specrails:implement #1',
    )
  })

  it('spec-gen, agent-refine, auto-title, setup-enrich all use the exec shape', () => {
    for (const action of ['spec-gen', 'agent-refine', 'auto-title', 'setup-enrich'] as const) {
      const args = codexAdapter.buildArgs(action, {
        prompt: 'p',
        model: 'gpt-5.4-mini',
      })
      expect(args[0]).toBe('exec')
      expect(args).toContain('--json')
      expect(args).toContain('--sandbox')
    }
  })

  it('setup-enrich-resume requires sessionId and uses exec resume', () => {
    expect(() =>
      codexAdapter.buildArgs('setup-enrich-resume', { prompt: 'x', model: 'gpt-5.4-mini' }),
    ).toThrow(/sessionId/)

    const args = codexAdapter.buildArgs('setup-enrich-resume', {
      prompt: 'cont',
      sessionId: 'UUID',
      model: 'gpt-5.4-mini',
    })
    expect(args.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(args).toContain('UUID')
    expect(args).not.toContain('--sandbox')
    expect(args).toContain('sandbox_mode="workspace-write"')
  })

  it('extraArgs append after the model flag', () => {
    const args = codexAdapter.buildArgs('chat-turn', {
      prompt: 'p',
      model: 'gpt-5.4-mini',
      extraArgs: ['--add-dir', '/extra'],
    })
    expect(args.slice(-2)).toEqual(['--add-dir', '/extra'])
  })
})

describe('codexAdapter.parseStreamLine — fixture-based', () => {
  it('returns null for empty input', () => {
    expect(codexAdapter.parseStreamLine('')).toBeNull()
  })

  it('returns null for non-JSON', () => {
    expect(codexAdapter.parseStreamLine('not json')).toBeNull()
  })

  it('parses thread.started as session-started', () => {
    const ev = codexAdapter.parseStreamLine(
      '{"type":"thread.started","thread_id":"019e37c6-3bd4-7120-992f-6f96dc82eda1"}',
    )
    expect(ev).toEqual({
      kind: 'session-started',
      sessionId: '019e37c6-3bd4-7120-992f-6f96dc82eda1',
    })
  })

  it('parses turn.started as other', () => {
    const ev = codexAdapter.parseStreamLine('{"type":"turn.started"}')
    expect(ev?.kind).toBe('other')
    if (ev?.kind === 'other') expect(ev.type).toBe('turn.started')
  })

  it('parses an mcp_tool_call with a NON-STRING arguments object without throwing', () => {
    // Regression: MCP tool calls carry a structured `arguments` object; the old
    // code called .slice on it and crashed the whole server process.
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'mcp_tool_call', name: 'specrails_jobs', arguments: { action: 'list', projectId: 'p1' } },
    })
    const ev = codexAdapter.parseStreamLine(line)
    expect(ev?.kind).toBe('tool-use')
    if (ev?.kind === 'tool-use') {
      expect(ev.name).toBe('specrails_jobs')
      expect(ev.inputPreview).toContain('action')
    }
  })

  it('parses item.completed agent_message as text-delta', () => {
    const ev = codexAdapter.parseStreamLine(
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hi"}}',
    )
    expect(ev).toEqual({ kind: 'text-delta', text: 'hi' })
  })

  it('parses item.completed function_call as tool-use', () => {
    const ev = codexAdapter.parseStreamLine(
      '{"type":"item.completed","item":{"id":"item_1","type":"function_call","name":"shell","arguments":"ls -la"}}',
    )
    expect(ev?.kind).toBe('tool-use')
    if (ev?.kind === 'tool-use') {
      expect(ev.name).toBe('shell')
      expect(ev.inputPreview).toContain('ls -la')
    }
  })

  it('parses item.completed local_shell_call as tool-use with name shell when name missing', () => {
    const ev = codexAdapter.parseStreamLine(
      '{"type":"item.completed","item":{"id":"item_1","type":"local_shell_call","arguments":"pwd"}}',
    )
    expect(ev?.kind).toBe('tool-use')
    if (ev?.kind === 'tool-use') {
      expect(ev.name).toBe('shell')
    }
  })

  it('parses item.completed command_execution (codex 0.139) as tool-use', () => {
    const ev = codexAdapter.parseStreamLine(
      '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"ls -la","exit_code":0}}',
    )
    expect(ev?.kind).toBe('tool-use')
    if (ev?.kind === 'tool-use') {
      expect(ev.name).toBe('ls -la')
      expect(ev.inputPreview).toContain('ls -la')
    }
  })

  it('parses item.completed mcp_tool_call (codex 0.139) as tool-use', () => {
    const ev = codexAdapter.parseStreamLine(
      '{"type":"item.completed","item":{"id":"item_3","type":"mcp_tool_call","name":"serena.find","arguments":"{}"}}',
    )
    expect(ev?.kind).toBe('tool-use')
    if (ev?.kind === 'tool-use') expect(ev.name).toBe('serena.find')
  })

  it('surfaces turn.failed (codex 0.139) as kind=error with the nested message', () => {
    const ev = codexAdapter.parseStreamLine(
      '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}',
    )
    expect(ev?.kind).toBe('error')
    if (ev?.kind === 'error') expect(ev.message).toBe("You've hit your usage limit.")
  })

  it('surfaces a standalone error frame as kind=error', () => {
    const ev = codexAdapter.parseStreamLine(
      '{"type":"error","message":"model gpt-5.5 is not available on your plan"}',
    )
    expect(ev?.kind).toBe('error')
    if (ev?.kind === 'error') expect(ev.message).toContain('not available')
  })

  it('falls back to a generic message when turn.failed carries no error.message', () => {
    const ev = codexAdapter.parseStreamLine('{"type":"turn.failed"}')
    expect(ev?.kind).toBe('error')
    if (ev?.kind === 'error') expect(ev.message).toBe('codex turn failed')
  })

  it('parses turn.completed as result', () => {
    const ev = codexAdapter.parseStreamLine(
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}',
    )
    expect(ev?.kind).toBe('result')
    if (ev?.kind === 'result') {
      expect(ev.payload.type).toBe('turn.completed')
    }
  })

  it('unknown event types resolve to kind=other', () => {
    const ev = codexAdapter.parseStreamLine('{"type":"some_new_event","x":1}')
    expect(ev?.kind).toBe('other')
    if (ev?.kind === 'other') expect(ev.type).toBe('some_new_event')
  })

  it('parses the full hello-3-words fixture into the expected sequence', () => {
    const events = parseFixture('hello-3-words.jsonl')
    expect(events.map((e) => e.kind)).toEqual([
      'session-started',
      'other', // turn.started
      'text-delta',
      'result',
    ])
  })
})

describe('codexAdapter.extractResult — from fixture', () => {
  it('captures usage tokens from say-bye fixture and folds reasoning into output', () => {
    // Fixture usage: input_tokens=11923, cached_input_tokens=2432,
    //                output_tokens=45, reasoning_output_tokens=42
    const events = parseFixture('say-bye.jsonl')
    const result = codexAdapter.extractResult(events)
    expect(result.tokens_in).toBe(11923)
    expect(result.tokens_cache_read).toBe(2432)
    expect(result.tokens_out).toBe(45 + 42) // reasoning folded into output for billing
    expect(result.tokens_cache_create).toBeUndefined()
    expect(result.total_cost_usd).toBeUndefined() // codex does not report cost
    expect(result.num_turns).toBe(1)
    expect(result.model).toBeUndefined() // adapter does not derive from events
    expect(result.session_id).toBe('019e37c6-3bd4-7120-992f-6f96dc82eda1')
  })

  it('captures tokens from hello-3-words fixture', () => {
    // Fixture usage: input_tokens=13669, cached_input_tokens=7552,
    //                output_tokens=5, reasoning_output_tokens=0
    const events = parseFixture('hello-3-words.jsonl')
    const result = codexAdapter.extractResult(events)
    expect(result.tokens_in).toBe(13669)
    expect(result.tokens_cache_read).toBe(7552)
    expect(result.tokens_out).toBe(5 + 0)
    expect(result.session_id).toBe('019e37be-c94e-7d72-ad5f-d99c8e6a8828')
  })

  it('returns only session_id when no turn.completed seen', () => {
    const events: AdapterEvent[] = [
      { kind: 'session-started', sessionId: 'T' },
      { kind: 'text-delta', text: 'partial' },
    ]
    const result = codexAdapter.extractResult(events)
    expect(result.session_id).toBe('T')
    expect(result.tokens_in).toBeUndefined()
  })

  it('handles turn.completed with no usage gracefully', () => {
    const events: AdapterEvent[] = [
      { kind: 'session-started', sessionId: 'T' },
      { kind: 'result', payload: { type: 'turn.completed' } },
    ]
    const result = codexAdapter.extractResult(events)
    expect(result.tokens_in).toBeUndefined()
    expect(result.tokens_out).toBeUndefined()
    expect(result.session_id).toBe('T')
  })
})

describe('codexAdapter.detectInstalled', () => {
  beforeEach(() => {
    mockExec.mockReset()
  })

  it('reports installed + meetsMinimum when version >= minCliVersion', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('which codex') || cmd.includes('where codex')) return '/usr/local/bin/codex' as never
      if (cmd === 'codex --version') return 'codex-cli 0.128.0' as never
      throw new Error('unexpected exec ' + cmd)
    })
    const result = await codexAdapter.detectInstalled()
    expect(result.installed).toBe(true)
    expect(result.executable).toBe(true)
    expect(result.version).toBe('0.128.0')
    expect(result.meetsMinimum).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('reports meetsMinimum=false with an upgrade hint for older versions', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('which codex') || cmd.includes('where codex')) return '/usr/local/bin/codex' as never
      if (cmd === 'codex --version') return 'codex-cli 0.120.0' as never
      throw new Error('unexpected exec ' + cmd)
    })
    const result = await codexAdapter.detectInstalled()
    expect(result.installed).toBe(true)
    expect(result.meetsMinimum).toBe(false)
    expect(result.error).toContain('0.128.0')
  })

  it('reports installed=false when which fails', async () => {
    mockExec.mockImplementation(() => { throw new Error('not found') })
    const result = await codexAdapter.detectInstalled()
    expect(result.installed).toBe(false)
    expect(result.executable).toBe(false)
  })

  it('reports executable=false when which succeeds but --version fails', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('which codex') || cmd.includes('where codex')) return '/usr/local/bin/codex' as never
      if (cmd === 'codex --version') throw new Error('binary broken')
      throw new Error('unexpected ' + cmd)
    })
    const result = await codexAdapter.detectInstalled()
    expect(result.installed).toBe(true)
    expect(result.executable).toBe(false)
  })
})

describe('codexAdapter — fixture directory invariants', () => {
  it('has at least one fixture set matching minCliVersion', () => {
    const dirs = readdirSync(FIXTURES_BASE)
    expect(dirs).toContain(_CODEX_MIN_VERSION)
  })
})
