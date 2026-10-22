import { describe, expect, it } from 'vitest'
import { agentsTools } from './agents'
import { analyticsTools } from './analytics'
import { railsTools } from './rails'

describe('provider-aware MCP tool descriptions', () => {
  it('documents Kimi and capability-gated Freestyle without stale Claude-only claims', () => {
    const tool = railsTools()[0]
    expect(tool.description).toContain('Kimi')
    expect(tool.description).not.toContain('claude/codex/gemini')
    expect(tool.inputSchema.mode.description).toContain('Claude, Codex, Gemini, Kimi and local engines; only Claude is interactive')
    expect(tool.inputSchema.model.description).toContain('Kimi')
    expect(tool.inputSchema.model.description).not.toContain('Claude-only')
  })

  it('includes Kimi in provider-scoped analytics filters', () => {
    const tool = analyticsTools()[0]
    expect(tool.inputSchema.modelProvider.description).toContain('kimi')
    expect(tool.inputSchema.provider.description).toContain('kimi')
  })

  it('exposes decision_times with honest unknown semantics', () => {
    const tool = analyticsTools()[0]
    expect(tool.description).toContain('decision_times')
    expect(tool.description).toContain('unknown is never zero')
    expect(tool.inputSchema.action.safeParse('decision_times').success).toBe(true)
  })

  it('exposes loop_economics with no-data semantics', () => {
    const tool = analyticsTools()[0]
    expect(tool.description).toContain('loop_economics')
    expect(tool.description).toContain('regressionOf')
    expect(tool.inputSchema.action.safeParse('loop_economics').success).toBe(true)
  })

  it('describes provider-native role artifacts and the Studio safety gate', () => {
    const tool = agentsTools()[0]
    expect(tool.description).toContain('provider-native')
    expect(tool.description).toContain('Kimi')
    expect(tool.description).toContain('safe none/read-only tool policy')
    expect(tool.description).not.toContain('spawns claude')
  })
})
