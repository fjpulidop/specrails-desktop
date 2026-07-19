import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return {
    ...actual,
    execSync: vi.fn(),
  }
})

import { execSync } from 'child_process'
import {
  kimiAdapter,
  _KIMI_MIN_VERSION,
  _compareSemver,
  _normaliseKimiModel,
} from './kimi-adapter'
import { buildProviderEnv, parseStreamEvents } from './runtime'
import type { AdapterEvent, SpawnAction } from './types'

const mockExec = vi.mocked(execSync)
const FIXTURES_DIR = join(__dirname, '__fixtures__', 'kimi', _KIMI_MIN_VERSION)

function parseFixture(name: string): AdapterEvent[] {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => [...parseStreamEvents(kimiAdapter, line)])
}

describe('kimiAdapter identity and capabilities', () => {
  it('uses the official binary, framework paths, minimum, and truthful capabilities', () => {
    expect(kimiAdapter.id).toBe('kimi')
    expect(kimiAdapter.displayName).toBe('Kimi Code')
    expect(kimiAdapter.binary).toBe('kimi')
    expect(kimiAdapter.minCliVersion).toBe('0.27.0')
    expect(kimiAdapter.projectDirName).toBe('.kimi-code')
    expect(kimiAdapter.instructionsFilename).toBe(join('.kimi-code', 'AGENTS.md'))
    expect(kimiAdapter.projectMcpPath('/repo')).toBe(join('/repo', '.kimi-code', 'mcp.json'))
    expect(kimiAdapter.customRolePath('/repo', 'custom-auditor')).toBe(
      join('/repo', '.kimi-code', 'skills', 'custom-auditor', 'SKILL.md'),
    )

    expect(kimiAdapter.capabilities).toMatchObject({
      nativeResume: true,
      nativeStreamJson: true,
      nativeCostUsd: false,
      reportsUsage: false,
      nativeOtelEnv: false,
      profileEnvSupport: true,
      persistentStdin: false,
      systemPromptArg: false,
      supportsReasoningEffort: true,
      reasoningEfforts: ['low', 'high', 'max'],
      supportsImageInput: true,
      userMcp: false,
    })
  })

  it('publishes raw official model ids with K3 as the single default', () => {
    expect(kimiAdapter.modelCatalog().map((model) => model.value)).toEqual([
      'k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ])
    expect(kimiAdapter.modelCatalog().filter((model) => model.default)).toEqual([
      expect.objectContaining({ value: 'k3' }),
    ])
    expect(kimiAdapter.defaultModel()).toBe('k3')
  })

  it('normalizes only official raw ids to configured Kimi aliases', () => {
    expect(_normaliseKimiModel('k3')).toBe('kimi-code/k3')
    expect(_normaliseKimiModel('kimi-for-coding')).toBe('kimi-code/kimi-for-coding')
    expect(_normaliseKimiModel('kimi-code/k3')).toBe('kimi-code/k3')
    expect(_normaliseKimiModel('team-custom')).toBe('team-custom')
  })

  it('rejects unsafe or malformed model aliases at the final spawn boundary', () => {
    for (const model of ['', '--yolo', 'team model', 'x\n--plan', 'a'.repeat(129)]) {
      expect(() => kimiAdapter.buildArgs('rail-job', { prompt: 'x', model }))
        .toThrow('invalid_provider_model_alias:kimi')
    }
    expect(kimiAdapter.buildArgs('rail-job', {
      prompt: 'x',
      model: 'team/model:v2',
    }).slice(0, 2)).toEqual(['-m', 'team/model:v2'])
  })

  it('declares the framework rail baseline', () => {
    expect([...kimiAdapter.baselineAgents()].sort()).toEqual([
      'sr-architect',
      'sr-developer',
      'sr-reviewer',
    ])
  })
})

describe('kimiAdapter buildArgs/buildEnv', () => {
  const newActions: SpawnAction[] = [
    'chat-turn',
    'rail-job',
    'spec-gen',
    'agent-refine',
    'setup-enrich',
  ]

  it.each(newActions)('%s uses prompt mode and stream JSON without server or approval flags', (action) => {
    const args = kimiAdapter.buildArgs(action, {
      prompt: 'do it',
      model: 'k3',
    })
    expect(args).toContain('-p')
    expect(args[args.indexOf('-p') + 1]).toBe('do it')
    expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2))
      .toEqual(['--output-format', 'stream-json'])
    expect(args.slice(0, 2)).toEqual(['-m', 'kimi-code/k3'])
    expect(args).not.toContain('server')
    expect(args).not.toContain('--auto')
    expect(args).not.toContain('--yolo')
    expect(args).not.toContain('--plan')
    expect(args).not.toContain('-S')
  })

  it.each(['chat-resume', 'setup-enrich-resume'] as const)(
    '%s requires and emits a bound --session=<id> option',
    (action) => {
      expect(() => kimiAdapter.buildArgs(action, { prompt: 'x', model: 'k3' }))
        .toThrow(/sessionId/)
      const args = kimiAdapter.buildArgs(action, {
        prompt: 'continue',
        model: 'k3',
        sessionId: '01SESSION',
      })
      expect(args).toContain('--session=01SESSION')
      expect(args).not.toContain('-S')
      expect(args[args.indexOf('-p') + 1]).toBe('continue')
    },
  )

  it('keeps Explore user prompts as-is and folds system prompts for structured actions', () => {
    const chat = kimiAdapter.buildArgs('chat-turn', {
      prompt: 'short user turn',
      systemPrompt: 'explore system',
      model: 'k3',
    })
    expect(chat[chat.indexOf('-p') + 1]).toBe('short user turn')

    const spec = kimiAdapter.buildArgs('spec-gen', {
      prompt: 'make JSON',
      systemPrompt: 'schema rules',
      model: 'k3',
    })
    expect(spec[spec.indexOf('-p') + 1]).toBe('schema rules\n\n---\n\nmake JSON')
  })

  it('guides Kimi to inspect attached media through absolute ReadMediaFile paths', () => {
    const args = kimiAdapter.buildArgs('chat-turn', {
      prompt: 'What is shown?',
      model: 'k3',
      imagePaths: ['fixtures/screenshot.png', '/tmp/diagram.jpg'],
    })
    const prompt = args[args.indexOf('-p') + 1]
    expect(prompt).toContain(`- ${join(process.cwd(), 'fixtures', 'screenshot.png')}`)
    expect(prompt).toContain('- /tmp/diagram.jpg')
    expect(prompt).toContain('Use ReadMediaFile')
  })

  it('resumes agent-refine only when a known session is supplied', () => {
    const fresh = kimiAdapter.buildArgs('agent-refine', { prompt: 'x', model: 'k3' })
    expect(fresh.some((arg) => arg.startsWith('--session='))).toBe(false)
    const resumed = kimiAdapter.buildArgs('agent-refine', {
      prompt: 'x',
      model: 'k3',
      sessionId: 'role-session',
    })
    expect(resumed).toContain('--session=role-session')
  })

  it.each(['chat-resume', 'agent-refine'] as const)(
    '%s binds an option-shaped safe session id instead of exposing a new flag',
    (action) => {
      const args = kimiAdapter.buildArgs(action, {
        prompt: 'x',
        model: 'k3',
        sessionId: '--continue',
      })
      expect(args).toContain('--session=--continue')
      expect(args).not.toContain('--continue')
    },
  )

  it('rejects unsafe session ids at the argv boundary', () => {
    for (const sessionId of [
      '.',
      '..',
      'nested/id',
      '<session>',
      'line\nbreak',
      'nul\u0000byte',
      'x'.repeat(129),
    ]) {
      expect(() => kimiAdapter.buildArgs('chat-resume', {
        prompt: 'x',
        model: 'k3',
        sessionId,
      })).toThrow('invalid_kimi_session_id')
    }
  })

  it('rejects the unsupported persistent-stdin action', () => {
    expect(() => kimiAdapter.buildArgs('chat-stream', { prompt: 'x', model: 'k3' }))
      .toThrow(/persistent stdin/)
  })

  it('rejects a literal interactive slash skill at the final headless argv boundary', () => {
    for (const prompt of [
      '/skill:specrails-implement #1',
      '/specrails:implement #1',
      '/sr:retry #1',
      '/opsx:ff change',
    ]) {
      expect(() => kimiAdapter.buildArgs('rail-job', { prompt, model: 'k3' }))
        .toThrow('kimi_headless_skill_not_materialized')
    }
  })

  it('advertises no safe tool policy and fails closed before building restricted argv', () => {
    for (const toolPolicy of ['none', 'read-only'] as const) {
      expect(() => kimiAdapter.buildArgs('spec-gen', {
          prompt: 'x',
          model: 'k3',
          toolPolicy,
        }))
        .toThrow(`provider_tool_policy_unsupported:kimi:${toolPolicy}`)
    }
    expect(() => kimiAdapter.buildArgs('auto-title', {
      prompt: 'title this',
      model: 'k3',
    })).toThrow('provider_tool_policy_unsupported:kimi:none')
    expect(kimiAdapter.capabilities.structuredActions).toBe(false)
    expect(kimiAdapter.capabilities.toolPolicies).toEqual([])
  })

  it('appends extra args and grants relocated roots with --add-dir', () => {
    const args = kimiAdapter.buildArgs('rail-job', {
      prompt: 'x',
      model: 'k3',
      extraArgs: ['--add-dir', '/repo'],
    })
    expect(args.slice(-2)).toEqual(['--add-dir', '/repo'])
    expect(kimiAdapter.buildRepoAccessArgs(['/a', '/b'])).toEqual([
      '--add-dir', '/a', '--add-dir', '/b',
    ])
  })

  it('fails closed instead of forwarding a Core slash command without its artifact root', () => {
    expect(() => kimiAdapter.formatCoreCommand('/specrails:implement #3 --yes'))
      .toThrow(/without a project working directory/)
    expect(kimiAdapter.formatCoreCommand('/opsx:future my-change'))
      .toBe('/opsx:future my-change')
    expect(kimiAdapter.formatCoreCommand('plain prompt')).toBe('plain prompt')
  })

  it('scopes low/high/max effort to raw or prefixed K3 and scrubs it elsewhere', () => {
    expect(kimiAdapter.buildEnv({ prompt: 'x', model: 'k3', reasoning_effort: 'max' }))
      .toEqual({
        KIMI_MODEL_THINKING_EFFORT: 'max',
        KIMI_CODE_EXPERIMENTAL_FLAG: undefined,
        KIMI_DISABLE_CRON: '1',
        KIMI_CODE_NO_AUTO_UPDATE: '1',
      })
    expect(kimiAdapter.buildEnv({
      prompt: 'x',
      model: 'kimi-code/k3',
      reasoning_effort: 'high',
    })).toEqual({
      KIMI_MODEL_THINKING_EFFORT: 'high',
      KIMI_CODE_EXPERIMENTAL_FLAG: undefined,
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
    })
    expect(kimiAdapter.buildEnv({
      prompt: 'x',
      model: 'kimi-for-coding',
      reasoning_effort: 'high',
    })).toEqual({
      KIMI_MODEL_THINKING_EFFORT: undefined,
      KIMI_CODE_EXPERIMENTAL_FLAG: undefined,
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
    })
    expect(kimiAdapter.buildEnv({
      prompt: 'x',
      model: 'k3',
      reasoning_effort: 'medium',
    })).toEqual({
      KIMI_MODEL_THINKING_EFFORT: undefined,
      KIMI_CODE_EXPERIMENTAL_FLAG: undefined,
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
    })
  })

  it('forces the qualified stable engine instead of inheriting Kimi v2 opt-in', () => {
    const env = buildProviderEnv(
      kimiAdapter,
      { prompt: 'x', model: 'k3' },
      { PATH: '/bin', KIMI_CODE_EXPERIMENTAL_FLAG: 'true' },
    )
    expect(env).toEqual({
      PATH: '/bin',
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
    })
  })

  it('forces managed lifecycle controls across inherited environment casing', () => {
    const env = buildProviderEnv(
      kimiAdapter,
      { prompt: 'x', model: 'k3' },
      {
        PATH: '/bin',
        kimi_disable_cron: '0',
        KiMi_CoDe_No_AuTo_UpDaTe: '0',
      },
    )
    expect(env).toEqual({
      PATH: '/bin',
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
    })
  })
})

describe('kimiAdapter stream parsing and result extraction', () => {
  it('flattens mixed assistant text plus every tool call from one official record', () => {
    const events = parseFixture('mixed-tool-success.jsonl')
    expect(events).toContainEqual({ kind: 'text-delta', text: 'I will inspect both files.' })
    expect(events.filter((event) => event.kind === 'tool-use')).toEqual([
      expect.objectContaining({ kind: 'tool-use', name: 'Shell' }),
      expect.objectContaining({ kind: 'tool-use', name: 'ReadFile' }),
    ])
  })

  it('preserves system.version, tool results, retry metadata, and unknown records', () => {
    const events = parseFixture('mixed-tool-success.jsonl')
    expect(events).toContainEqual(expect.objectContaining({ kind: 'other', type: 'system.version' }))
    expect(events.filter((event) => event.kind === 'other' && event.type === 'tool')).toHaveLength(2)
    const retry = events.find((event) => event.kind === 'other' && event.type === 'turn.step.retrying')
    expect(retry).toEqual(expect.objectContaining({
      raw: expect.objectContaining({
        failed_attempt: 1,
        next_attempt: 2,
        max_attempts: 3,
        delay_ms: 250,
        error_name: 'APIError',
        error_message: 'transient upstream error',
        status_code: 503,
      }),
    }))
    expect(parseStreamEvents(kimiAdapter, '{"role":"meta","type":"future.event","value":1}'))
      .toEqual([expect.objectContaining({ kind: 'other', type: 'future.event' })])
  })

  it('parses the terminal resume hint as the real session id', () => {
    const events = parseFixture('mixed-tool-success.jsonl')
    expect(events.at(-1)).toEqual({
      kind: 'session-started',
      sessionId: '01KIMI00000000000000000001',
    })
  })

  it('rejects unsafe session ids at the provider-event boundary', () => {
    for (const sessionId of ['.', '..', 'nested/id', '<prompt-envelope>', 'x'.repeat(129)]) {
      const event = kimiAdapter.parseStreamLine(JSON.stringify({
        role: 'meta',
        type: 'session.resume_hint',
        session_id: sessionId,
      }))
      expect(event).toEqual({
        kind: 'error',
        message: 'Kimi emitted an invalid session id',
      })
    }
  })

  it('normalizes explicit Kimi errors and tolerates invalid lines', () => {
    const events = parseFixture('error.jsonl')
    expect(events.at(-1)).toEqual({
      kind: 'error',
      message: 'Authentication required. Run kimi login.',
    })
    expect(kimiAdapter.parseStreamLine('')).toBeNull()
    expect(kimiAdapter.parseStreamLine('not json')).toBeNull()
    expect(kimiAdapter.parseStreamLine('[]')).toBeNull()
  })

  it('extracts only the truthful session id and never invents turns, usage, or cost', () => {
    const result = kimiAdapter.extractResult(parseFixture('mixed-tool-success.jsonl'))
    expect(result).toEqual({
      session_id: '01KIMI00000000000000000001',
    })
    expect(result.num_turns).toBeUndefined()
    expect(result.tokens_in).toBeUndefined()
    expect(result.tokens_out).toBeUndefined()
    expect(result.total_cost_usd).toBeUndefined()
    expect(kimiAdapter.extractResult([])).toEqual({ session_id: undefined })
  })
})

describe('kimiAdapter version detection', () => {
  beforeEach(() => {
    mockExec.mockReset()
  })

  it('compares the minimum version semantically', () => {
    expect(_compareSemver('0.27.0', '0.27.0')).toBe(0)
    expect(_compareSemver('0.28.0', '0.27.0')).toBe(1)
    expect(_compareSemver('0.26.9', '0.27.0')).toBe(-1)
  })

  it('reports missing when PATH lookup fails', async () => {
    mockExec.mockImplementationOnce(() => { throw new Error('not found') })
    await expect(kimiAdapter.detectInstalled()).resolves.toEqual({
      installed: false,
      executable: false,
    })
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('reports a compatible native or npm-shim executable from --version', async () => {
    mockExec
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce('Kimi Code 0.27.4\n')
    await expect(kimiAdapter.detectInstalled()).resolves.toEqual({
      installed: true,
      executable: true,
      version: '0.27.4',
      meetsMinimum: true,
    })
    expect(mockExec).toHaveBeenCalledWith(
      'kimi --version',
      expect.objectContaining({ timeout: expect.any(Number) }),
    )
  })

  it('flags an old version with login/update remediation', async () => {
    mockExec
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce('kimi 0.26.0\n')
    const result = await kimiAdapter.detectInstalled()
    expect(result.meetsMinimum).toBe(false)
    expect(result.error).toContain('0.27.0')
    expect(result.error).toContain('kimi login')
  })

  it('reports installed but unexecutable when the bounded probe fails', async () => {
    mockExec
      .mockReturnValueOnce(Buffer.from(''))
      .mockImplementationOnce(() => { throw new Error('broken shim') })
    await expect(kimiAdapter.detectInstalled()).resolves.toEqual({
      installed: true,
      executable: false,
    })
  })

  it('resolves and probes a Windows npm .cmd shim through the recovered shell env', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mockExec
      .mockReturnValueOnce(Buffer.from('C:\\Users\\me\\AppData\\Roaming\\npm\\kimi.cmd\r\n'))
      .mockReturnValueOnce('Kimi Code 0.27.0\r\n')
    try {
      await expect(kimiAdapter.detectInstalled()).resolves.toMatchObject({
        installed: true,
        executable: true,
        version: '0.27.0',
        meetsMinimum: true,
      })
      expect(mockExec).toHaveBeenNthCalledWith(
        1,
        'where kimi',
        expect.objectContaining({
          env: expect.objectContaining({
            SystemRoot: expect.any(String),
            ComSpec: expect.stringMatching(/cmd\.exe$/i),
          }),
        }),
      )
      expect(mockExec).toHaveBeenNthCalledWith(
        2,
        'kimi --version',
        expect.objectContaining({ timeout: 3_000 }),
      )
    } finally {
      platformSpy.mockRestore()
    }
  })
})
