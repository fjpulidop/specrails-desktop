import { describe, it, expect } from 'vitest'
import { claudeAdapter } from './claude-adapter'
import { codexAdapter } from './codex-adapter'
import { geminiAdapter } from './gemini-adapter'
import type { SpawnOptions } from './types'
import { isReasoningEffortValidForModel } from './runtime'

function opts(over: Partial<SpawnOptions> = {}): SpawnOptions {
  return { prompt: 'Do the task.', model: 'sonnet', ...over }
}

function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

describe('reasoning effort — capabilities', () => {
  it('claude + codex advertise effort support; gemini does NOT', () => {
    expect(claudeAdapter.capabilities.supportsReasoningEffort).toBe(true)
    expect(codexAdapter.capabilities.supportsReasoningEffort).toBe(true)
    expect(geminiAdapter.capabilities.supportsReasoningEffort ?? false).toBe(false)
  })
})

describe('reasoning effort — gemini (unsupported)', () => {
  it('never emits a reasoning-effort arg even when one is requested', () => {
    const args = geminiAdapter.buildArgs('rail-job', opts({ reasoning_effort: 'high', model: 'gemini-3.5-flash' }))
    expect(args.some((a) => a.includes('model_reasoning_effort') || a.includes('thinking'))).toBe(false)
  })
})

describe('reasoning effort — codex (native -c)', () => {
  it('rejects unavailable tiers for each current Codex model before launch', () => {
    expect(isReasoningEffortValidForModel(codexAdapter, 'gpt-6-astra', 'minimal')).toBe(false)
    expect(isReasoningEffortValidForModel(codexAdapter, 'gpt-6-astra', 'ultra')).toBe(true)
    expect(isReasoningEffortValidForModel(codexAdapter, 'gpt-5.6-luna', 'ultra')).toBe(false)
    expect(isReasoningEffortValidForModel(codexAdapter, 'gpt-5.6-luna', 'max')).toBe(true)
    expect(isReasoningEffortValidForModel(codexAdapter, 'gpt-5.5', 'max')).toBe(false)
    expect(isReasoningEffortValidForModel(codexAdapter, 'gpt-5.4-mini', 'high')).toBe(true)
  })

  it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const)(
    'passes Astra and %s effort unchanged to rail jobs and resumed conversations', (effort) => {
      for (const action of ['rail-job', 'chat-resume'] as const) {
        const args = codexAdapter.buildArgs(action, opts({
          model: 'gpt-6-astra', reasoning_effort: effort, sessionId: 'astra-session',
        }))
        expect(argAfter(args, '--model')).toBe('gpt-6-astra')
        expect(args).toContain(`model_reasoning_effort="${effort}"`)
      }
    },
  )

  it('emits -c model_reasoning_effort when set', () => {
    const args = codexAdapter.buildArgs('rail-job', opts({ reasoning_effort: 'high', model: 'gpt-5.5' }))
    const i = args.indexOf('-c')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('model_reasoning_effort="high"')
  })

  it('emits NO effort override when unset', () => {
    const args = codexAdapter.buildArgs('rail-job', opts({ model: 'gpt-5.5' }))
    expect(args.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false)
  })

  it('passes effort on chat-resume too', () => {
    const args = codexAdapter.buildArgs(
      'chat-resume',
      opts({ reasoning_effort: 'medium', sessionId: 'sess', model: 'gpt-5.5' })
    )
    expect(args).toContain('model_reasoning_effort="medium"')
  })
})

describe('reasoning effort — claude (native --effort flag)', () => {
  it('emits --effort <level> when requested, leaving the prompt unchanged', () => {
    const args = claudeAdapter.buildArgs('rail-job', opts({ reasoning_effort: 'high' }))
    expect(argAfter(args, '--effort')).toBe('high')
    expect(argAfter(args, '-p')).toBe('Do the task.') // prompt is NOT mutated
  })

  it('emits --effort low at low effort (a real native level, not a no-op)', () => {
    const args = claudeAdapter.buildArgs('rail-job', opts({ reasoning_effort: 'low' }))
    expect(argAfter(args, '--effort')).toBe('low')
  })

  it('omits --effort entirely when none is requested', () => {
    const args = claudeAdapter.buildArgs('rail-job', opts())
    expect(args).not.toContain('--effort')
  })

  it('uses the native --effort flag, NOT codex-style -c model_reasoning_effort', () => {
    const args = claudeAdapter.buildArgs('rail-job', opts({ reasoning_effort: 'high' }))
    expect(args.some((a) => a.includes('model_reasoning_effort'))).toBe(false)
  })
})
