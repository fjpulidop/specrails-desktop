import { describe, expect, it } from 'vitest'
import { agentsTools } from './agents'
import { analyticsTools } from './analytics'
import { railsTools } from './rails'

describe('provider-aware MCP tool descriptions', () => {
  it('documents Kimi and capability-gated Freestyle without stale Claude-only claims', () => {
    const tool = railsTools()[0]
    expect(tool.description).toContain('Kimi')
    expect(tool.description).not.toContain('claude/codex/gemini')
    expect(tool.inputSchema.mode.description).toContain('Claude and Kimi')
    expect(tool.inputSchema.model.description).toContain('Kimi')
    expect(tool.inputSchema.model.description).not.toContain('Claude-only')
  })

  it('includes Kimi in provider-scoped analytics filters', () => {
    const tool = analyticsTools()[0]
    expect(tool.inputSchema.modelProvider.description).toContain('kimi')
    expect(tool.inputSchema.provider.description).toContain('kimi')
  })

  it('describes provider-native role artifacts and the Studio safety gate', () => {
    const tool = agentsTools()[0]
    expect(tool.description).toContain('provider-native')
    expect(tool.description).toContain('Kimi')
    expect(tool.description).toContain('safe none/read-only tool policy')
    expect(tool.description).not.toContain('spawns claude')
  })
})
