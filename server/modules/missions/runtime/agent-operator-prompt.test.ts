import { describe, it, expect, afterEach } from 'vitest'
import { FLOW_OFFER_SECTION, FLOW_OFFER_SYSTEM_CLAUSE, OPERATOR_INSTRUCTIONS, OPERATOR_SYSTEM_PROMPT, RAIL_LAUNCH_CARD_SECTION, buildOperatorInstructions, buildOperatorSystemPrompt } from './agent-operator-prompt'

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

  it('distinguishes implementation, local checkout, and accepted integration without destructive bypasses', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('implemented and awaiting acceptance → `on_review`')
    expect(OPERATOR_INSTRUCTIONS).not.toContain('success → `done`')
    expect(OPERATOR_INSTRUCTIONS).toContain('it preserves the review decision and does not\n  merge or accept the spec')
    expect(OPERATOR_INSTRUCTIONS).toContain('checkout/integration is not authorization to discard local edits')
    expect(OPERATOR_INSTRUCTIONS).toContain('response still contains cleanup warnings')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('never bypass a blocked checkout/integration with shell mutation')
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
  it('never asks the user about the Contract Layer: it is always added', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('The\nContract Layer is always added: never ask about it, never offer to skip it')
    expect(OPERATOR_INSTRUCTIONS).toContain('Never ask whether to add it.')
    // The confirmation no longer invites declining the enrichment.
    expect(OPERATOR_INSTRUCTIONS).not.toContain('If the user declines the enrichment')
  })

  it('keeps the confirmation-gate discipline (one question, no tool call before yes)', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('The confirmation gate (mandatory)')
    expect(OPERATOR_INSTRUCTIONS).toContain('Do not call any persisting tool')
  })
})

describe('OPERATOR_INSTRUCTIONS — launch, then release the turn', () => {
  it('teaches live project context, scoped identifiers, and bounded discovery without replaying historical actions', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('specrails_context')
    expect(OPERATOR_INSTRUCTIONS).toContain('Spec numbers are project-local')
    expect(OPERATOR_INSTRUCTIONS).toContain('specrails_code(search)')
    expect(OPERATOR_INSTRUCTIONS).toContain('nested JSON schema and tier')
    expect(OPERATOR_INSTRUCTIONS).toContain('not a fresh instruction to execute old launches')
    expect(OPERATOR_INSTRUCTIONS).toContain('override a conversation pin')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('refresh after operations')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('never replay completed launches')
  })
  it('states the Kimi capability boundary without advertising Claude-only transforms', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('Claude and Kimi\n  support profiles; Contract Refine supports Claude and Codex')
    expect(OPERATOR_INSTRUCTIONS).toContain('Contract Refine supports Claude and Codex')
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

  it('never offers Freestyle or SDD Quick on its own: Implement is the only built-in', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('`factory:implement` is the only one')
    expect(OPERATOR_INSTRUCTIONS).toContain('Freestyle and SDD Quick (OpenSpec) are NOT\n  built-ins')
    expect(OPERATOR_INSTRUCTIONS).toContain('Never offer,\n  recommend or launch them on your own')
    expect(OPERATOR_INSTRUCTIONS).toContain('`builtin_loop_retired`')
    expect(OPERATOR_INSTRUCTIONS).toContain('Do not recommend other\n  built-in workflows: there are none.')
    // No launch path or classification still routes work to the retired ids.
    expect(OPERATOR_INSTRUCTIONS).not.toContain("loopId:'factory:sdd-quick-openspec'")
    expect(OPERATOR_INSTRUCTIONS).not.toContain('SDD Quick (OpenSpec) launch path')
    expect(OPERATOR_INSTRUCTIONS).not.toContain('The canonical API / id / token values are `freestyle`')
    expect(OPERATOR_INSTRUCTIONS).not.toContain('Freestyle, SDD Quick (OpenSpec), Implement, or')
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
    expect(OPERATOR_INSTRUCTIONS).toContain('explicit loop selection')
    expect(OPERATOR_INSTRUCTIONS).toContain('invalid_revision_target')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('published pr_ready card')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('do not require publish/discard/merge first')
  })

  it('requires inspecting active PR contents before relaunch strategy classification', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('PR-aware relaunch classification')
    expect(OPERATOR_INSTRUCTIONS).toContain("inspect that PR's head\n  branch/diff/files, not only `main`")
    expect(OPERATOR_INSTRUCTIONS).toContain('`openspec/specs/**`, `openspec/changes/**`')
    expect(OPERATOR_INSTRUCTIONS).not.toContain('may be the right\n  relaunch strategy')
    expect(OPERATOR_INSTRUCTIONS).toContain('verify against active PR contents before answering')
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
    expect(OPERATOR_INSTRUCTIONS).toContain('Core 6 has no standalone\n  `update`')
    expect(OPERATOR_INSTRUCTIONS).not.toContain('npx specrails-core@latest update')
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

  it('asks before exposing a dev server on the local network and links its appUrls', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('Offer the app on the local network')
    expect(OPERATOR_INSTRUCTIONS).toContain('appUrls')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('whether to expose it on the local network')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('appUrls')
  })

  it('carries the grounding + spec-draft + contract-layer-default essentials', () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain('ground it in the real codebase FIRST')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('spec-draft JSON block')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('Contract Layer by default')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('contractRefine false')
  })

  it('no longer carries the Freestyle naming rule', () => {
    expect(OPERATOR_SYSTEM_PROMPT).not.toContain('call the free-form autonomous rail mode Freestyle in prose')
    expect(OPERATOR_SYSTEM_PROMPT).not.toContain('canonical API/id/token values')
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

describe('OPERATOR_SYSTEM_PROMPT — workflow policy', () => {
  it('uses Implement unless the user names a saved loop; never offers the gallery loops unprompted', () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain('use Implement unless the user names one of their own saved loops')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('Freestyle and SDD Quick (OpenSpec) are gallery loops, not built-ins')
    expect(OPERATOR_SYSTEM_PROMPT).not.toContain('Freestyle is only ticket-local implementation-only')
    expect(OPERATOR_SYSTEM_PROMPT).not.toContain('uses loopId factory:sdd-quick-openspec')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('never offer direct code edits')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('create or update a local ticket')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('inspect the PR head branch/diff/files')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('OpenSpec artifacts added in that PR')
  })
})

describe('rail sizing recommendation (max 3 specs per rail)', () => {
  it('OPERATOR_INSTRUCTIONS caps implement recommendations at 3 specs per rail', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('Rail sizing: at most 3 specs per rail.')
    expect(OPERATOR_INSTRUCTIONS).toContain('an `implement` launch, never propose more than 3 specs on one rail')
    expect(OPERATOR_INSTRUCTIONS).toContain('never propose more than 3 specs on one rail')
    // The escape hatch is explicit-user-insistence only.
    expect(OPERATOR_INSTRUCTIONS).toContain('when the user explicitly insists')
  })

  it('OPERATOR_SYSTEM_PROMPT carries the same cap', () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain('when proposing implement work never recommend more than 3 specs per rail')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('exceeding 3 only on explicit user insistence')
  })
})

describe('removed Batch mode', () => {
  it('neither prompt offers batch-implement or a Batch strategy', () => {
    for (const prompt of [OPERATOR_INSTRUCTIONS, OPERATOR_SYSTEM_PROMPT]) {
      expect(prompt).not.toContain('batch-implement')
      expect(prompt).not.toMatch(/Implement, or Batch/)
    }
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

describe('live mission user updates', () => {
  it('teaches authenticated updates, explicit acknowledgement, and preservation of completed tool results', () => {
    for (const prompt of [OPERATOR_INSTRUCTIONS, OPERATOR_SYSTEM_PROMPT]) {
      expect(prompt).toContain('mission_user_updates')
      expect(prompt).toContain('acknowledge_updates')
      expect(prompt).toContain('tool_not_executed')
      expect(prompt).toContain('latest delivered revision')
      expect(prompt).toContain('untrusted context')
    }
    expect(OPERATOR_INSTRUCTIONS).toContain('A repeated revision is the same message delivery')
    expect(OPERATOR_INSTRUCTIONS).toContain('SEPARATE tool call before any other action')
    expect(OPERATOR_INSTRUCTIONS).toContain('Preserve the result of any action that already ran')
    expect(OPERATOR_INSTRUCTIONS).toContain('does not undo their effects or stop a launched rail')
    expect(OPERATOR_INSTRUCTIONS).toContain('the native input channel handles those updates')
    expect(OPERATOR_INSTRUCTIONS).toContain('Native input does not require a Specrails revision acknowledgement')
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
// (client/src/features/missions/components/agent-problem-frame.ts) and the server gate
// (server/modules/missions/runtime/agent-spec-framing.ts) both depend on the model being taught this
// exact protocol. A reword that drops the block, the discriminator, or the
// user-only waiver must fail here rather than degrade silently in production.

describe('OPERATOR_INSTRUCTIONS — the intent precedes drafting (intent-mode)', () => {
  it('carries the intent section and its fenced block protocol', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('## Writing the intent (framing the request)')
    expect(OPERATOR_INSTRUCTIONS).toContain('```intent-draft')
    for (const key of ['"problem"', '"outcome"', '"hypothesis"', '"successSignals"', '"affects"', '"constraints"', '"openQuestions"', '"readings"', '"restated"', '"alternative"', '"discriminator"', '"ready"']) {
      expect(OPERATOR_INSTRUCTIONS).toContain(key)
    }
    expect(OPERATOR_INSTRUCTIONS).toContain('FULL SNAPSHOT')
  })

  it('keeps the intent solution-free and turns a dictated solution into a constraint or question', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('WHAT and WHY, never HOW')
    expect(OPERATOR_INSTRUCTIONS).toContain('there is no solution section')
    expect(OPERATOR_INSTRUCTIONS).toContain('keep the dictated solution as a')
    expect(OPERATOR_INSTRUCTIONS).toContain('Never invent an answer')
  })

  it('requires the alternative to be a different reading and grounds what it names', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('GENUINELY different reading')
    expect(OPERATOR_INSTRUCTIONS).toContain('not the same\n  reading in other words')
    expect(OPERATOR_INSTRUCTIONS).toContain('Never name a\n  path you did not open')
  })

  it('teaches the discriminator as the check on a fabricated second reading', () => {
    const idx = OPERATOR_INSTRUCTIONS.indexOf('`discriminator` is the ONE thing')
    expect(idx).toBeGreaterThan(-1)
    expect(OPERATOR_INSTRUCTIONS.slice(idx, idx + 300)).toContain('find a real second')
  })

  it('ends the turn on the question and states a question floor and ceiling', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('The question is the LAST thing in the turn')
    expect(OPERATOR_INSTRUCTIONS).toContain('ask at least\nONE question')
    expect(OPERATOR_INSTRUCTIONS).toContain('staying silent is not neutral')
    expect(OPERATOR_INSTRUCTIONS).toContain('at most TWO per turn')
  })

  it('offers Explore and Delegate with equal weight on the settled intent', () => {
    const idx = OPERATOR_INSTRUCTIONS.indexOf('**Settled intent.**')
    expect(idx).toBeGreaterThan(-1)
    const section = OPERATOR_INSTRUCTIONS.slice(idx, idx + 700)
    expect(section).toContain('`"ready": true`')
    expect(section).toContain('never recommend, rank or favour one')
    expect(section).toContain('**Explore**')
    expect(section).toContain('**Delegate**')
    expect(section).toContain('you never start it yourself')
  })

  it('makes the waiver user-only, token-driven, announced and never agent-inferred', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('#noframe')
    expect(OPERATOR_INSTRUCTIONS).toContain('The USER, never you')
    expect(OPERATOR_INSTRUCTIONS).toContain('may NOT ask the user to send')
    expect(OPERATOR_INSTRUCTIONS).toContain('Certainty is')
    const idx = OPERATOR_INSTRUCTIONS.indexOf('**Switching it off.**')
    const section = OPERATOR_INSTRUCTIONS.slice(idx, idx + 600)
    expect(section).toContain('say plainly that the intent step is off')
    expect(section).toContain('`#frame` turns it back on')
  })

  it('teaches the commit_draft gate as a missing artifact that carries the intent', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('one intent authorises ONE spec')
    expect(OPERATOR_INSTRUCTIONS).toContain('the\ncommitted spec carries that intent automatically')
    expect(OPERATOR_INSTRUCTIONS).toContain('Never work around it')
    const idx = OPERATOR_INSTRUCTIONS.indexOf('Write the\nintent before the other creation paths')
    expect(idx).toBeGreaterThan(-1)
    expect(OPERATOR_INSTRUCTIONS.slice(idx, idx + 200)).toContain('`generate`')
  })

  it('keeps the understand-first stance and the spec refinement opening', () => {
    expect(OPERATOR_INSTRUCTIONS).not.toContain('## Think in specs (default stance)')
    expect(OPERATOR_INSTRUCTIONS).toContain('## Understand first (default stance)')
    expect(OPERATOR_INSTRUCTIONS).toContain('Your\nfirst move is never to draft')
    expect(OPERATOR_INSTRUCTIONS).toContain('that judgement is exactly the one you are worst')
    expect(OPERATOR_INSTRUCTIONS).toContain('not because YOU judged the request clear')
    expect(OPERATOR_INSTRUCTIONS).not.toContain('Be concise and action-oriented')
    expect(OPERATOR_INSTRUCTIONS).toContain('understanding the request comes before dispatch')
    expect(OPERATOR_INSTRUCTIONS).toContain('ALWAYS opens with the intent card')
    expect(OPERATOR_INSTRUCTIONS).toContain('never in the same breath as your first reading')
  })

  it('derives the spec from the intent', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('Derive\nthe spec FROM the intent')
    expect(OPERATOR_INSTRUCTIONS).toContain('at\nleast one acceptance criterion checks each success signal')
  })

  it('no longer teaches the problem-frame block', () => {
    expect(OPERATOR_INSTRUCTIONS).not.toContain('```problem-frame')
    expect(OPERATOR_SYSTEM_PROMPT).not.toContain('problem-frame')
  })

  it('the intent-draft example is a valid draft for the shared parser and the fence promotion', async () => {
    const { parseIntentDraft } = await import('../../specs/domain/intent')
    const { detectProtocolShape } = await import('./agent-fence-promotion')
    const example = JSON.parse(OPERATOR_INSTRUCTIONS.split('```intent-draft\n')[1].split('\n```')[0])
    expect(parseIntentDraft(example)).not.toBeNull()
    expect(detectProtocolShape(example)).toBe('intent-draft')
  })
})

describe('OPERATOR_SYSTEM_PROMPT — the intent step stays in sync', () => {
  it('carries the block, its fields, the readings and the paths', () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain('intent-draft')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('readings{restated, alternative, discriminator}')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('DIFFERENT reading of the same problem or outcome')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('Explore (an Intent session the app starts from the card) or Delegate')
  })

  it('carries the gate and the user-only waiver tokens', () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain('commit_draft refuses until an intent has been answered')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('one intent authorises ONE spec')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('#noframe')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('never skip it because you feel certain')
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

  it('requires evidence and a changed precondition instead of escalating retries to relaunch', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('runtime_diagnose, jobId')
    expect(OPERATOR_INSTRUCTIONS).toContain('Do not use Relaunch as escalation from a failed Resume')
    expect(OPERATOR_INSTRUCTIONS).toContain('specrails_recovery inspect')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('canResume is availability, not proof a retry will work')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('six-line limit does not apply to subsequent user troubleshooting')
  })

  it('keeps both constants free of interpolation after the rewrite', () => {
    expect(OPERATOR_INSTRUCTIONS).not.toMatch(/\$\{/)
    expect(OPERATOR_SYSTEM_PROMPT).not.toMatch(/\$\{/)
  })
})

// ── mission-rail-cards: propose = card, launch only on explicit "now" ─────────
describe('rail launch cards (mission-rail-cards)', () => {
  afterEach(() => { delete process.env.SPECRAILS_MISSION_RAIL_CARDS })

  it('teaches the exact rail-launch fence contract and the propose-vs-launch verb split', () => {
    expect(RAIL_LAUNCH_CARD_SECTION).toContain('## Rail launch cards')
    expect(RAIL_LAUNCH_CARD_SECTION).toContain('```rail-launch')
    for (const key of ['"ticketIds"', '"railIndex"', '"newRail"', '"mode"', '"loopId"', '"aiEngine"', '"model"', '"reasoningEffort"', '"profileName"', '"targetPrNumber"', '"baseBranch"', '"railName"', '"rationale"']) {
      expect(RAIL_LAUNCH_CARD_SECTION).toContain(key)
    }
    expect(RAIL_LAUNCH_CARD_SECTION).toContain('do NOT call `specrails_rails(launch)`')
    expect(RAIL_LAUNCH_CARD_SECTION).toContain('Never propose a busy rail')
    expect(RAIL_LAUNCH_CARD_SECTION).toContain('0-BASED')
    // Failure-turn conduct: explain, recommend ONE action, never act in that turn.
    expect(RAIL_LAUNCH_CARD_SECTION).toContain('[Specrails run-failure briefing')
    expect(RAIL_LAUNCH_CARD_SECTION).toContain('at most 6 short lines')
    expect(RAIL_LAUNCH_CARD_SECTION).toContain('NEVER call runtime_resume / runtime_recover / launch / discard yourself')
  })

  it('is appended to the manual and the system prompt only while the feature is on', () => {
    expect(buildOperatorInstructions()).toContain(RAIL_LAUNCH_CARD_SECTION)
    expect(buildOperatorInstructions().startsWith(OPERATOR_INSTRUCTIONS)).toBe(true)
    expect(buildOperatorSystemPrompt()).toContain('rail-launch JSON block')
    expect(buildOperatorSystemPrompt().startsWith(OPERATOR_SYSTEM_PROMPT)).toBe(true)
    process.env.SPECRAILS_MISSION_RAIL_CARDS = 'false'
    expect(buildOperatorInstructions()).not.toContain(RAIL_LAUNCH_CARD_SECTION)
    expect(buildOperatorSystemPrompt()).toBe(`${OPERATOR_SYSTEM_PROMPT}${FLOW_OFFER_SYSTEM_CLAUSE}`)
  })
})

// ── intent-mode: Explore or Delegate, offered by the intent card ───────────────
describe('Intent or Implement offer (flow-mode)', () => {
  afterEach(() => { delete process.env.SPECRAILS_MISSION_RAIL_CARDS })

  it('keeps Intent in the existing classification', () => {
    expect(OPERATOR_INSTRUCTIONS).toContain('Implement is the built-in strategy')
    expect(OPERATOR_INSTRUCTIONS).toContain('`Intent: offerable`')
  })

  it('routes new requests through the intent card and keeps flow-offer for existing specs', () => {
    expect(FLOW_OFFER_SECTION).toContain('## Explore or Delegate')
    expect(FLOW_OFFER_SECTION).toContain('**A new request** always goes through the intent card first')
    expect(FLOW_OFFER_SECTION).toContain('never\nalso emit an `options` block for Explore/Delegate')
    expect(FLOW_OFFER_SECTION).toContain('Never emit a `flow-offer` block for a new idea')
    expect(FLOW_OFFER_SYSTEM_CLAUSE).toContain('never emit a flow-offer block for a new idea')
    expect(FLOW_OFFER_SECTION).toContain('```flow-offer')
    for (const key of ['"idea"', '"reason"', '"ticketId"']) expect(FLOW_OFFER_SECTION).toContain(key)
  })

  it('never ranks the paths and never insists', () => {
    expect(FLOW_OFFER_SECTION).not.toContain('"recommended"')
    expect(FLOW_OFFER_SECTION).toContain('never recommend, rank or favour one of them')
    expect(FLOW_OFFER_SYSTEM_CLAUSE).toContain('never recommend, rank or favour either')
    expect(FLOW_OFFER_SYSTEM_CLAUSE).not.toContain('recommended')
    expect(FLOW_OFFER_SECTION).toContain('one suggestion per spec')
    expect(FLOW_OFFER_SECTION).toContain('never insist after')
    expect(FLOW_OFFER_SECTION).toContain('Never start an Intent session yourself')
  })

  it('offers both paths neutrally for an EXISTING spec with its ticketId (prompt text changed consciously)', async () => {
    expect(FLOW_OFFER_SECTION).toContain('**An existing spec.**')
    expect(FLOW_OFFER_SECTION).toContain('Explore then works on THAT spec (no new spec is created')
    expect(FLOW_OFFER_SYSTEM_CLAUSE).toContain('ticketId = that spec id')
  })

  it('the offer block parses with the fence-promotion shape (example is valid JSON)', async () => {
    const { detectProtocolShape } = await import('./agent-fence-promotion')
    const example = FLOW_OFFER_SECTION.split('```flow-offer\n')[1].split('\n```')[0]
    expect(detectProtocolShape(JSON.parse(example))).toBe('flow-offer')
  })

  it('appends static, byte-stable text to both prompts regardless of rail cards', () => {
    expect(FLOW_OFFER_SECTION).not.toMatch(/\$\{/)
    expect(FLOW_OFFER_SYSTEM_CLAUSE).not.toMatch(/\$\{/)
    expect(buildOperatorInstructions().endsWith(FLOW_OFFER_SECTION)).toBe(true)
    expect(buildOperatorSystemPrompt().endsWith(FLOW_OFFER_SYSTEM_CLAUSE)).toBe(true)
    expect(buildOperatorSystemPrompt()).toBe(buildOperatorSystemPrompt())
    process.env.SPECRAILS_MISSION_RAIL_CARDS = 'false'
    expect(buildOperatorInstructions()).toBe(`${OPERATOR_INSTRUCTIONS}\n${FLOW_OFFER_SECTION}`)
  })
})

describe('spec addenda rule (spec-addenda)', () => {
  it('teaches the agent to iterate through add_addendum instead of editing the description, and that preparation failures self-close', async () => {
    const { OPERATOR_INSTRUCTIONS: text } = await import('./agent-operator-prompt')
    expect(text).toContain('"Iterate on / extend / adjust an existing spec" = a SPEC ADDENDUM')
    expect(text).toContain('specrails_specs(add_addendum)')
    expect(text).toContain('list_addenda')
    expect(text).toContain('closed\n  automatically by the next launch')
  })
})

describe('review WIP limit (review-wip-limit)', () => {
  it('explains the refusal once: what it means, how to free a slot, and no retry loop', () => {
    const at = OPERATOR_INSTRUCTIONS.indexOf('review_wip_limit_reached')
    expect(at).toBeGreaterThan(-1)
    expect(OPERATOR_INSTRUCTIONS.indexOf('review_wip_limit_reached', at + 1)).toBe(-1)
    const rule = OPERATOR_INSTRUCTIONS.slice(at, at + 420)
    expect(rule).toContain('nothing was launched')
    expect(rule).toContain('raising the limit in Project settings')
    expect(rule).toContain('Never retry in a loop')
  })
})
