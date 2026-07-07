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

  it('keeps Freestyle as the user-facing name for the canonical freestyle API values', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('always call the free-form autonomous rail mode\n  `Freestyle`')
    expect(OPERATOR_INSTRUCTIONS).toContain('The canonical API / id / token values are `freestyle`,\n  `factory:freestyle`, and `{{cmd:freestyle}}`')
    expect(OPERATOR_INSTRUCTIONS).toContain('Do not invent or use another name for\n  this capability')
  })

  it('treats published PR cards as continuable, not relaunch blockers', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain("`decision:'pr_ready'`")
    expect(OPERATOR_INSTRUCTIONS).toContain('STILL an open PR continuation\n  target')
    expect(OPERATOR_INSTRUCTIONS).toContain('do NOT tell them they must publish,\n  discard, or merge first')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('published pr_ready card')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('do not require publish/discard/merge first')
  })
})

describe('OPERATOR_INSTRUCTIONS — support and framework repair', () => {
  it('routes install/usage/job-failure help through specrails_support instead of specs', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('## Support & troubleshooting')
    expect(OPERATOR_INSTRUCTIONS).toContain("specrails_support(action:'triage'")
    expect(OPERATOR_INSTRUCTIONS).toContain('this is SUPPORT — not backlog work')
    expect(OPERATOR_INSTRUCTIONS).toContain('Do NOT create or propose a spec')
  })

  it('teaches missing agents/skills/commands as specrails-core framework repair', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('missing agents')
    expect(OPERATOR_INSTRUCTIONS).toContain('missing skills')
    expect(OPERATOR_INSTRUCTIONS).toContain('app-global specrails-core framework')
    expect(OPERATOR_INSTRUCTIONS).toContain('NOT\ninside the selected project')
    expect(OPERATOR_INSTRUCTIONS).toContain("specrails_support(action:'core_update_check')")
    expect(OPERATOR_INSTRUCTIONS).toContain('Do NOT infer a MyProject problem from\n  `setup/checkpoints`')
    expect(OPERATOR_INSTRUCTIONS).toContain('is NOT a\n  reason to run `specrails_setup(install)`')
    expect(OPERATOR_INSTRUCTIONS).toContain('do not claim MyProject')
    expect(OPERATOR_INSTRUCTIONS).toContain('npx specrails-core@latest update')
  })
})

describe('OPERATOR_SYSTEM_PROMPT — compact distillation stays in sync', () => {
  it('carries the launch-then-release rule', () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain('after a rail/job LAUNCH is accepted end your reply immediately')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('only when the user explicitly asks you to wait')
  })

  it('carries the background shell confirmation rule', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('jobs background_start')
    expect(OPERATOR_INSTRUCTIONS).toContain('without first proposing it')
    expect(OPERATOR_INSTRUCTIONS).toContain('receiving an explicit yes')
    expect(OPERATOR_INSTRUCTIONS).toContain('Long-running shell commands get chips')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('not a raw shell runner')
  })

  it('carries the grounding + spec-draft + contract-layer-default essentials', () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain('ground it in the real codebase FIRST')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('spec-draft JSON block')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('Contract Layer by default')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('contractRefine false')
  })

  it('carries the Freestyle naming rule', () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain('call the free-form autonomous rail mode Freestyle in prose')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('freestyle/factory:freestyle/{{cmd:freestyle}} are canonical API/id/token values')
  })

  it('carries the support-not-spec and framework-repair rule', () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain('specrails_support first')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('never become specs')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('missing agents/skills/slash commands')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('app-global specrails-core framework')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('project setup checkpoints are not a core health signal')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('must not trigger specrails_setup(install)')
    expect(OPERATOR_SYSTEM_PROMPT).not.toContain('reassemble_project_workspace')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('core_update_check/core_update_apply')
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
