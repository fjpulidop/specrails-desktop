import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { kimiAdapter } from './kimi-adapter'
import {
  buildProviderEnv,
  buildProviderRepoAccessArgs,
  defaultReasoningEffortForModel,
  formatProviderCommand,
  isModelAvailableForAdapter,
  isReasoningEffortValidForModel,
  isSafeCustomModelAlias,
  parseStreamEvents,
  pureOutputToolPolicy,
  requireToolPolicy,
  reasoningEffortsForModel,
  supportsToolPolicy,
} from './runtime'
import { claudeAdapter } from './claude-adapter'
import { codexAdapter } from './codex-adapter'

describe('provider runtime helpers', () => {
  it('merges Kimi effort without mutating the base environment', () => {
    const base = { PATH: '/bin', KEEP: 'yes' }
    const result = buildProviderEnv(
      kimiAdapter,
      { prompt: 'x', model: 'k3', reasoning_effort: 'max' },
      base,
    )
    expect(result).toEqual({
      PATH: '/bin',
      KEEP: 'yes',
      KIMI_MODEL_THINKING_EFFORT: 'max',
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
    })
    expect(base).toEqual({ PATH: '/bin', KEEP: 'yes' })
  })

  it('removes an inherited Kimi effort when this invocation does not select one', () => {
    const result = buildProviderEnv(
      kimiAdapter,
      { prompt: 'x', model: 'k3' },
      { PATH: '/bin', KIMI_MODEL_THINKING_EFFORT: 'max' },
    )
    expect(result.PATH).toBe('/bin')
    expect(result).not.toHaveProperty('KIMI_MODEL_THINKING_EFFORT')
    expect(result.KIMI_DISABLE_CRON).toBe('1')
    expect(result.KIMI_CODE_NO_AUTO_UPDATE).toBe('1')
  })

  it('scrubs inherited Kimi controls case-insensitively before applying overrides', () => {
    const result = buildProviderEnv(
      kimiAdapter,
      { prompt: 'x', model: 'k3', reasoning_effort: 'high' },
      {
        PATH: '/bin',
        kimi_model_thinking_effort: 'max',
        KiMi_CoDe_ExPeRiMeNtAl_FlAg: 'true',
      },
    )
    expect(result).toEqual({
      PATH: '/bin',
      KIMI_MODEL_THINKING_EFFORT: 'high',
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
    })
  })

  it('removes mixed-case inherited Kimi effort when the invocation omits effort', () => {
    const result = buildProviderEnv(
      kimiAdapter,
      { prompt: 'x', model: 'k3' },
      {
        PATH: '/bin',
        kimi_MODEL_thinking_EFFORT: 'max',
        kimi_code_experimental_flag: '1',
      },
    )
    expect(result).toEqual({
      PATH: '/bin',
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
    })
  })

  it('gates Kimi reasoning effort to K3 and its normalized alias', () => {
    expect(reasoningEffortsForModel(kimiAdapter, 'k3')).toEqual(['low', 'high', 'max'])
    expect(reasoningEffortsForModel(kimiAdapter, 'kimi-code/k3')).toEqual(['low', 'high', 'max'])
    expect(defaultReasoningEffortForModel(kimiAdapter, 'k3')).toBe('high')
    expect(isReasoningEffortValidForModel(kimiAdapter, 'k3', 'max')).toBe(true)

    for (const model of ['kimi-for-coding', 'kimi-for-coding-highspeed', 'custom-alias']) {
      expect(reasoningEffortsForModel(kimiAdapter, model)).toEqual([])
      expect(defaultReasoningEffortForModel(kimiAdapter, model)).toBeUndefined()
      expect(isReasoningEffortValidForModel(kimiAdapter, model, 'max')).toBe(false)
    }
  })

  it('accepts safe configured Kimi aliases exactly and keeps catalogs closed elsewhere', () => {
    for (const alias of [
      'kimi-code/k3',
      'moonshot-team/fast-coding',
      'registry.example/model:v2',
      'team_name/model-1.2',
    ]) {
      expect(isSafeCustomModelAlias(alias)).toBe(true)
      expect(isModelAvailableForAdapter(kimiAdapter, alias)).toBe(true)
    }
    expect(isModelAvailableForAdapter(claudeAdapter, 'moonshot-team/fast-coding')).toBe(false)
    expect(isModelAvailableForAdapter(claudeAdapter, 'sonnet')).toBe(true)
  })

  it('rejects aliases that could be interpreted as flags or contain unsafe bytes', () => {
    for (const alias of [
      '',
      ' ',
      ' team/model',
      'team/model ',
      '--yolo',
      '-m',
      'team model',
      'team/model\n--yolo',
      'team/model$HOME',
      'team/model"quoted',
      `a${'b'.repeat(128)}`,
    ]) {
      expect(isSafeCustomModelAlias(alias)).toBe(false)
      expect(isModelAvailableForAdapter(kimiAdapter, alias)).toBe(false)
    }
  })

  it('normalizes single, batch, and null parser outputs', () => {
    expect(parseStreamEvents(kimiAdapter, '')).toEqual([])
    expect(parseStreamEvents(kimiAdapter, '{"role":"assistant","content":"hi"}')).toEqual([
      { kind: 'text-delta', text: 'hi' },
    ])
    expect(parseStreamEvents(
      kimiAdapter,
      '{"role":"assistant","content":"checking","tool_calls":[{"type":"function","id":"1","function":{"name":"Shell","arguments":"{}"}}]}',
    )).toHaveLength(2)
  })

  it('dispatches command and repo-access hooks', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'specrails-provider-runtime-'))
    mkdirSync(path.join(root, '.kimi-code', 'skills', 'specrails-implement'), {
      recursive: true,
    })
    writeFileSync(
      path.join(root, '.kimi-code', 'skills', 'specrails-implement', 'SKILL.md'),
      '---\nname: specrails-implement\ndescription: test\ntype: prompt\n---\nImplement $ARGUMENTS\n',
    )
    const prompt = formatProviderCommand(kimiAdapter, '/specrails:implement #1', root)
    expect(prompt).toContain('Implement #1')
    expect(prompt).not.toContain('/skill:specrails-implement')
    rmSync(root, { recursive: true, force: true })
    expect(buildProviderRepoAccessArgs(kimiAdapter, ['/repo']))
      .toEqual(['--add-dir', '/repo'])
  })

  it('selects only verified pure-output policies and fails closed for Kimi', () => {
    expect(pureOutputToolPolicy(claudeAdapter)).toBe('none')
    expect(pureOutputToolPolicy(codexAdapter)).toBe('read-only')
    expect(pureOutputToolPolicy(kimiAdapter)).toBeNull()
    expect(supportsToolPolicy(kimiAdapter, 'read-only')).toBe(false)
    expect(() => requireToolPolicy(kimiAdapter, 'read-only'))
      .toThrow('provider_tool_policy_unsupported:kimi:read-only')
  })
})
