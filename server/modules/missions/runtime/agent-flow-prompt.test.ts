import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { FLOW_SUBAGENTS_ADDENDUM, FLOW_SYSTEM_PROMPT, buildFlowSystemPrompt } from './agent-flow-prompt'

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

  it('verifies its own work with the shell and runs long-lived apps only through Specrails background processes', () => {
    expect(FLOW_SYSTEM_PROMPT).toContain('run the typecheck, the linter and the tests yourself')
    expect(FLOW_SYSTEM_PROMPT).toContain('## Running the app')
    expect(FLOW_SYSTEM_PROMPT).toContain('ALWAYS runs through the Specrails MCP tool `specrails_jobs` with action `background_start`')
    expect(FLOW_SYSTEM_PROMPT).toContain('never start it from your own shell')
    // Offered first through the option chips, then started with confirmed:true.
    expect(FLOW_SYSTEM_PROMPT).toContain('["Start the app", "Start and expose on the local network", "Not now"]')
    expect(FLOW_SYSTEM_PROMPT).toContain('`confirmed: true`')
    // LAN exposure follows the operator rule: host flag, honest warning.
    expect(FLOW_SYSTEM_PROMPT).toContain('anyone on that network can reach it')
    expect(FLOW_SYSTEM_PROMPT).toContain('`vite --host`')
    expect(FLOW_SYSTEM_PROMPT).toContain('give the user each address from `appUrls` as a clickable markdown link')
    expect(FLOW_SYSTEM_PROMPT).toContain('`background_kill`')
    // The worktree rule stays.
    expect(FLOW_SYSTEM_PROMPT).toContain('Never edit, create or delete files outside the worktree')
    expect(FLOW_SYSTEM_PROMPT.indexOf('## Running the app')).toBeLessThan(FLOW_SYSTEM_PROMPT.indexOf('## Choices'))
  })

  it('keeps the sub-agent guidance in a separate static addendum (only sent when sub-agents are allowed)', () => {
    expect(FLOW_SYSTEM_PROMPT).not.toContain('Sub-agents in Flow')
    expect(FLOW_SUBAGENTS_ADDENDUM.startsWith('## Sub-agents in Flow')).toBe(true)
    expect(FLOW_SUBAGENTS_ADDENDUM).toContain('same worktree')
    expect(FLOW_SUBAGENTS_ADDENDUM).toContain('integrate what they return')
    expect(FLOW_SUBAGENTS_ADDENDUM).not.toMatch(/\{\{|\$\{/)
  })
})
