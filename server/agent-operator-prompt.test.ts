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
  it('states the Kimi capability boundary without advertising Claude-only transforms', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('Claude and Kimi\n  support profiles and Freestyle')
    expect(OPERATOR_INSTRUCTIONS).toContain('Contract Refine and SMASH require Claude')
    expect(OPERATOR_INSTRUCTIONS).toContain('structured actions\n  (currently Claude)')
    expect(OPERATOR_INSTRUCTIONS).toContain('structured-action provider (currently\n  Claude)')
    expect(OPERATOR_INSTRUCTIONS).not.toContain(
      'Claude and Kimi\n  support profiles, Contract Refine, SMASH and Freestyle',
    )
    expect(OPERATOR_INSTRUCTIONS).not.toContain('structured actions\n  (Claude or Kimi)')
    expect(OPERATOR_INSTRUCTIONS).not.toContain('structured-action provider (Claude or\n  Kimi)')
  })

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

  it('classifies small work with the SDD Quick OpenSpec guardrail', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('Freestyle, SDD Quick (OpenSpec), Implement, or Batch')
    expect(OPERATOR_INSTRUCTIONS).toContain('ticket-local implementation-only work when OpenSpec artifacts are relevant')
    expect(OPERATOR_INSTRUCTIONS).toContain("loopId:'factory:sdd-quick-openspec'")
    expect(OPERATOR_INSTRUCTIONS).toContain('openspecChangeName')
    expect(OPERATOR_INSTRUCTIONS).toContain('ticket, OpenSpec target')
    expect(OPERATOR_INSTRUCTIONS).toContain('before any ai-spawn action')
    expect(OPERATOR_INSTRUCTIONS).toContain('Never offer direct code edits as the implementation path')
    expect(OPERATOR_INSTRUCTIONS).toContain('Even if the\n  change is "just one or two lines"')
    expect(OPERATOR_INSTRUCTIONS).toContain('update or\n  create a local ticket')
    expect(OPERATOR_INSTRUCTIONS).toContain('through rails/worktrees for auditability')
  })

  it('treats an undecided delivery as revisable, not a relaunch blocker', () => {
    // Superseded by the revision door: a modification request on ANY
    // non-terminal card is a revision launch, never "publish/discard first".
    expect(OPERATOR_INSTRUCTIONS).toContain('any non-terminal card')
    expect(OPERATOR_INSTRUCTIONS).toContain('`pr_ready`')
    expect(OPERATOR_INSTRUCTIONS).toContain('revisionOfDeliveryId')
    expect(OPERATOR_INSTRUCTIONS).toContain('revisionNote')
    expect(OPERATOR_INSTRUCTIONS).toContain('Do NOT tell them to publish, discard or\n  merge first')
    expect(OPERATOR_INSTRUCTIONS).toContain('Architect-less loop')
    expect(OPERATOR_INSTRUCTIONS).toContain('invalid_revision_target')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('published pr_ready card')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('do not require publish/discard/merge first')
  })

  it('requires inspecting active PR contents before relaunch strategy classification', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('PR-aware relaunch classification')
    expect(OPERATOR_INSTRUCTIONS).toContain("inspect that PR's head\n  branch/diff/files, not only `main`")
    expect(OPERATOR_INSTRUCTIONS).toContain('`openspec/specs/**`, `openspec/changes/**`')
    expect(OPERATOR_INSTRUCTIONS).toContain('SDD Quick (OpenSpec) may be the right\n  relaunch strategy')
    expect(OPERATOR_INSTRUCTIONS).toContain('verify against active PR contents before\n  answering')
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
    expect(OPERATOR_INSTRUCTIONS).toContain('background_logs')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('not a raw shell runner')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('background_logs')
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

describe('OPERATOR_SYSTEM_PROMPT — SDD Quick policy', () => {
  it('carries SDD Quick OpenSpec strategy in the compact prompt', () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain('Freestyle, SDD Quick (OpenSpec), Implement, or Batch')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('Freestyle is only ticket-local implementation-only')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('factory:sdd-quick-openspec')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('openspecChangeName')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('never offer direct code edits')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('create or update a local ticket')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('inspect the PR head branch/diff/files')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('OpenSpec artifacts added in that PR')
  })
})

describe('batch sizing recommendation (max 3 specs per rail)', () => {
  it('OPERATOR_INSTRUCTIONS caps batch-implement recommendations at 3 specs per rail', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('Batch sizing: at most 3 specs per rail.')
    expect(OPERATOR_INSTRUCTIONS).toContain('never propose more than 3 specs on one rail')
    // The escape hatch is explicit-user-insistence only.
    expect(OPERATOR_INSTRUCTIONS).toContain('when the user explicitly insists')
  })

  it('OPERATOR_SYSTEM_PROMPT carries the same cap', () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain('never recommend more than 3 specs per rail')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('exceeding 3 only on explicit user insistence')
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

describe('OPERATOR_INSTRUCTIONS — external user tools disclosure', () => {
  it('discloses that user-configured external MCP tools may exist', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('USER-CONFIGURED tools (external MCP servers)')
  })

  it('pins app operations to specrails_* even when external tools are present', () => {
    const idx = OPERATOR_INSTRUCTIONS.indexOf('USER-CONFIGURED tools (external MCP servers)')
    const bullet = OPERATOR_INSTRUCTIONS.slice(idx, idx + 400)
    expect(bullet).toContain('MUST still go')
    expect(bullet).toContain('`specrails_*` tools')
  })
})

// ─── Framing the request (critical-spec-framing) ──────────────────────────────
// The framing card is a forcing function, not advice: the client parser
// (client/src/components/agent-chat/agent-problem-frame.ts) and the server gate
// (server/agent-spec-framing.ts) both depend on the model being taught this
// exact protocol. A reword that drops the block, the discriminator, or the
// user-only waiver must fail here rather than degrade silently in production.

describe('OPERATOR_INSTRUCTIONS — framing precedes drafting', () => {
  it('carries the framing section and its fenced block protocol', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('## Framing the request')
    expect(OPERATOR_INSTRUCTIONS).toContain('```problem-frame')
    expect(OPERATOR_INSTRUCTIONS).toContain('"restated"')
    expect(OPERATOR_INSTRUCTIONS).toContain('"alternative"')
    expect(OPERATOR_INSTRUCTIONS).toContain('"discriminator"')
    expect(OPERATOR_INSTRUCTIONS).toContain('FULL SNAPSHOT')
  })

  it('requires the alternative to be a different reading and anchors both in real paths', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('GENUINELY')
    expect(OPERATOR_INSTRUCTIONS).toContain('not the same reading in other words')
    expect(OPERATOR_INSTRUCTIONS).toContain('ACTUALLY READ')
    expect(OPERATOR_INSTRUCTIONS).toContain('Never list a path you did not open')
  })

  it('teaches the discriminator as the check on a fabricated second reading', () => {
    const idx = OPERATOR_INSTRUCTIONS.indexOf('`discriminator` is the ONE thing')
    expect(idx).toBeGreaterThan(-1)
    const bullet = OPERATOR_INSTRUCTIONS.slice(idx, idx + 400)
    expect(bullet).toContain('your two readings are the same')
  })

  it('ends the turn on the framing question', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('The framing question is the LAST thing in the turn')
  })

  it('states a question FLOOR alongside the existing ceiling', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('ask at least ONE')
    expect(OPERATOR_INSTRUCTIONS).toContain('at most TWO per turn')
    expect(OPERATOR_INSTRUCTIONS).toContain('staying silent is not neutral')
  })

  it('makes the waiver user-only, token-driven and never agent-inferred', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('#noframe')
    expect(OPERATOR_INSTRUCTIONS).toContain('#frame')
    expect(OPERATOR_INSTRUCTIONS).toContain('The USER, never you')
    expect(OPERATOR_INSTRUCTIONS).toContain('may NOT ask the user to send')
    expect(OPERATOR_INSTRUCTIONS).toContain('Certainty is not evidence')
  })

  it('requires the waiver to be ANNOUNCED with the word that restores it', () => {
    const idx = OPERATOR_INSTRUCTIONS.indexOf('**Switching it off.**')
    expect(idx).toBeGreaterThan(-1)
    const section = OPERATOR_INSTRUCTIONS.slice(idx, idx + 600)
    expect(section).toContain('say plainly that framing is off')
    expect(section).toContain('`#frame` turns it back on')
  })

  it('teaches the commit_draft gate as a missing artifact, not an obstacle', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('one frame authorises ONE spec')
    expect(OPERATOR_INSTRUCTIONS).toContain('Never work\naround it')
  })

  it('extends framing to the AI creation paths the hard gate does not cover', () => {
    const idx = OPERATOR_INSTRUCTIONS.indexOf('Frame before the other creation paths')
    expect(idx).toBeGreaterThan(-1)
    expect(OPERATOR_INSTRUCTIONS.slice(idx, idx + 200)).toContain('`generate`')
  })

  it('drops the numbered dispatch pipeline that led with spec capture', () => {
    expect(OPERATOR_INSTRUCTIONS).not.toContain('## Think in specs (default stance)')
    expect(OPERATOR_INSTRUCTIONS).not.toContain('1. Check the backlog for duplicates first')
    expect(OPERATOR_INSTRUCTIONS).toContain('## Understand first (default stance)')
    expect(OPERATOR_INSTRUCTIONS).toContain('Your\nfirst move is never to draft')
  })

  it('no longer makes the agent judge whether a request is clear enough to one-shot', () => {
    expect(OPERATOR_INSTRUCTIONS).not.toContain('when the request is fuzzy, contested, or')
    expect(OPERATOR_INSTRUCTIONS).toContain('that judgement is exactly the one you are worst')
    // The Quick path must not reintroduce the same self-assessment trigger.
    expect(OPERATOR_INSTRUCTIONS).not.toContain('Use for clear, well-scoped requests')
    expect(OPERATOR_INSTRUCTIONS).toContain('not because YOU judged the request clear')
  })

  it('stops "action-oriented" from governing spec authoring', () => {
    expect(OPERATOR_INSTRUCTIONS).not.toContain('Be concise and action-oriented')
    expect(OPERATOR_INSTRUCTIONS).toContain('understanding the request comes before dispatch')
  })

  it('opens spec refinement with the frame, not with the draft', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('ALWAYS opens with the framing card')
    expect(OPERATOR_INSTRUCTIONS).toContain('never in the same breath as your first reading')
  })
})

describe('OPERATOR_SYSTEM_PROMPT — framing non-negotiable stays in sync', () => {
  it('carries the block, its fields and the discriminator', () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain('problem-frame')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('discriminator')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('DIFFERENT reading of the same request')
  })

  it('carries the gate and the user-only waiver tokens', () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain('commit_draft refuses until a frame has been answered')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('one frame authorises ONE spec')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('#noframe')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('never skip framing because you feel certain')
  })
})

describe('existing guardrails survive the framing rewrite', () => {
  it('keeps the cost, destruction and one-yes-one-action rules', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('without first proposing it in\n  plain words')
    expect(OPERATOR_INSTRUCTIONS).toContain('is irreversible, and receiving an explicit yes naming it')
    expect(OPERATOR_INSTRUCTIONS).toContain('One yes covers one action')
    expect(OPERATOR_INSTRUCTIONS).toContain('Ask a confirmation question EXACTLY ONCE')
  })

  it('keeps the permission ladder and the support-first routing', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('observe (read) ▸ edit (write) ▸')
    expect(OPERATOR_INSTRUCTIONS).toContain("specrails_support(action:'triage'")
    expect(OPERATOR_INSTRUCTIONS).toContain('this is SUPPORT — not backlog work')
  })

  it('keeps support questions out of the framing path', () => {
    const idx = OPERATOR_INSTRUCTIONS.indexOf('## Understand first (default stance)')
    const section = OPERATOR_INSTRUCTIONS.slice(idx, idx + 900)
    expect(section).toContain('does NOT apply to support/troubleshooting')
  })

  it('keeps both constants free of interpolation after the rewrite', () => {
    expect(OPERATOR_INSTRUCTIONS).not.toMatch(/\$\{/)
    expect(OPERATOR_SYSTEM_PROMPT).not.toMatch(/\$\{/)
  })
})
