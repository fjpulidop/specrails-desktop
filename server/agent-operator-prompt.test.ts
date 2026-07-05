import { describe, it, expect } from 'vitest'
import { OPERATOR_INSTRUCTIONS, OPERATOR_SYSTEM_PROMPT } from './agent-operator-prompt'

// Content pins for the operator prompt's spec-authoring ("super specs") and
// launch-then-release behaviours. These are prompt-as-contract tests: the
// client-side spec-draft card parser, the MCP contractRefine default, and the
// non-blocking launch UX all rely on the model being taught these exact
// protocols, so a silent rewording that drops them must fail loudly here.

describe('OPERATOR_INSTRUCTIONS — super-spec refinement mode', () => {
  it('mandates grounding in the real code BEFORE proposing, via the MCP read tools', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('Ground in the real code BEFORE proposing (mandatory)')
    expect(OPERATOR_INSTRUCTIONS).toContain('specrails_code(tree)')
    expect(OPERATOR_INSTRUCTIONS).toContain('specrails_specs(list)')
    // The awareness is framed as the Explore Desktop-preset equivalent…
    expect(OPERATOR_INSTRUCTIONS).toContain('"Desktop" preset')
    // …but honestly scoped: grounding reads go through the code tools, not the shell.
    expect(OPERATOR_INSTRUCTIONS).toContain('read code through the `specrails_code` tools')
  })

  it('routes GitHub/git questions to the first-class specrails_git MCP tool (not raw shell / not a refusal)', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('## GitHub & git')
    expect(OPERATOR_INSTRUCTIONS).toContain('specrails_git')
    // Names the read-only actions it should reach for.
    expect(OPERATOR_INSTRUCTIONS).toContain('gh_auth')
    expect(OPERATOR_INSTRUCTIONS).toContain('gh_repo')
    // Explicitly forbids the "I only work through MCP tools, can't check git" refusal.
    expect(OPERATOR_INSTRUCTIONS).toContain('never refuse')
    // Mutations still go through the ask-first PR flow, not this tool.
    expect(OPERATOR_INSTRUCTIONS).toContain('ask-first PR flow')
  })

  it('carries a per-spec-type grounding checklist', () => {
    for (const anchor of ['UI feature →', 'API / backend →', 'Bug fix →', 'Integration / adapter →']) {
      expect(OPERATOR_INSTRUCTIONS).toContain(anchor)
    }
  })

  it('pins the five-section description contract', () => {
    for (const section of [
      '## Problem Statement',
      '## Proposed Solution',
      '## Out of Scope',
      '## Technical Considerations',
      '## Estimated Complexity',
    ]) {
      expect(OPERATOR_INSTRUCTIONS).toContain(section)
    }
    // The anti-fabrication anchor for Technical Considerations.
    expect(OPERATOR_INSTRUCTIONS).toContain('Never fabricate a')
  })

  it('teaches the fenced spec-draft live-card protocol (full snapshot, exact fence)', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('```spec-draft')
    expect(OPERATOR_INSTRUCTIONS).toContain('FULL SNAPSHOT')
    for (const key of ['"title"', '"description"', '"labels"', '"priority"', '"acceptanceCriteria"']) {
      expect(OPERATOR_INSTRUCTIONS).toContain(key)
    }
    // The options block still closes the turn, after the draft block.
    expect(OPERATOR_INSTRUCTIONS).toContain('```options')
  })

  it('declares the Contract Layer enrichment default and its opt-out', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('Contract Layer enrichment is ON by default')
    expect(OPERATOR_INSTRUCTIONS).toContain('contractRefine: false')
    // Persisting stays commit_draft with no conversationId.
    expect(OPERATOR_INSTRUCTIONS).toContain("commit_draft'")
    // The stale claim that agent-authored specs can't get Contract Refine is gone.
    expect(OPERATOR_INSTRUCTIONS).not.toContain('Contract Refine is not\n  available for agent-authored specs')
    expect(OPERATOR_INSTRUCTIONS).not.toContain('Contract Refine is not available for agent-authored specs')
  })

  it('keeps the confirmation-gate discipline (one question, no tool call before yes)', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('The confirmation gate (mandatory)')
    expect(OPERATOR_INSTRUCTIONS).toContain('Do not call any persisting tool')
  })
})

describe('OPERATOR_INSTRUCTIONS — launch, then release the turn', () => {
  it('forbids blocking the turn on a launched rail/job', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('Launch, then release the turn')
    expect(OPERATOR_INSTRUCTIONS).toContain('END YOUR REPLY\n  immediately — do NOT sit on the turn watching the run')
  })

  it('reserves specrails_watch on launches for an explicit user wait, bounded', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('RESERVED for when the user\n  explicitly asks you to wait for completion')
    expect(OPERATOR_INSTRUCTIONS).toContain('bounded \`untilMs\`')
    // The general watch guidance defers launched work to the release rule.
    expect(OPERATOR_INSTRUCTIONS).toContain('For a LAUNCHED rail or job you release\n  the turn instead of watching')
  })

  it('still requires verified completion, never 202-acceptance claims', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('Never claim completion\n  you have not verified from a terminal event or a job read')
  })
})

describe('OPERATOR_SYSTEM_PROMPT — compact distillation stays in sync', () => {
  it('carries the launch-then-release rule', () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain('after a rail/job LAUNCH is accepted end your reply immediately')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('only when the user explicitly asks you to wait')
  })

  it('carries the grounding + spec-draft + contract-layer-default essentials', () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain('ground it in the real codebase FIRST')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('spec-draft JSON block')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('Contract Layer by default')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('contractRefine false')
  })
})

describe('byte-stability contract', () => {
  it('both prompts are static strings (no per-call variance)', () => {
    // Trivially true for constants, but pins the module shape: re-importing
    // must yield the identical bytes (prompt caching relies on it).
    expect(typeof OPERATOR_INSTRUCTIONS).toBe('string')
    expect(typeof OPERATOR_SYSTEM_PROMPT).toBe('string')
    expect(OPERATOR_INSTRUCTIONS).not.toMatch(/\$\{/)
    expect(OPERATOR_SYSTEM_PROMPT).not.toMatch(/\$\{/)
  })
})
