import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { FLOW_SYSTEM_PROMPT, buildFlowSystemPrompt } from './agent-flow-prompt'

describe('Flow persona prompt', () => {
  it('is static and byte-stable (no per-turn facts, same bytes on every build)', () => {
    const digest = (text: string) => createHash('sha256').update(text).digest('hex')
    expect(buildFlowSystemPrompt()).toBe(FLOW_SYSTEM_PROMPT)
    expect(digest(buildFlowSystemPrompt())).toBe(digest(buildFlowSystemPrompt()))
    expect(FLOW_SYSTEM_PROMPT).not.toMatch(/\{\{|\$\{|\d{4}-\d{2}-\d{2}/)
  })

  it('asks for a fenced options block whenever it offers the user a choice, and only then', () => {
    expect(FLOW_SYSTEM_PROMPT).toContain('## Choices')
    expect(FLOW_SYSTEM_PROMPT).toContain('end the reply with a fenced code block with language `options` containing only a JSON array of 2-6 choice labels')
    expect(FLOW_SYSTEM_PROMPT).toContain('["Particle trail", "Solid trail", "No trail"]')
    expect(FLOW_SYSTEM_PROMPT).toContain('Avoid a bare "Yes" / "No"')
    expect(FLOW_SYSTEM_PROMPT).toContain('Never emit the block when you are not asking the user to choose.')
    // The rule sits before the decisions log so the closing sections stay last.
    expect(FLOW_SYSTEM_PROMPT.indexOf('## Choices')).toBeLessThan(FLOW_SYSTEM_PROMPT.indexOf('## Decisions log'))
  })
})
