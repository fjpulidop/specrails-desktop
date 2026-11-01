## Why

Code is no longer the bottleneck of AI-built software. The bottleneck has moved to two places: knowing what to build and checking that it was built right. A spec written by a person tends to prescribe the solution ("waterfall in disguise"). The *intent* practice popularised by Anthropic and the agile community reverses the order. The person writes the problem, the outcome they want, who and what it affects, the constraints and the open questions. The AI derives the spec and the plan, and the person reviews the spec instead of writing it. Specrails already has half of this: Flow lets a person discover a solution by building it. But Flow has no intent artifact. Its "idea" is free text that becomes a placeholder title, so the problem, the success signals and the open questions are never a source of truth. Specs created through the other doors (the mission agent, Add Spec) still start from the solution.

This change evolves Flow into **Intent mode** and makes the intent the default way into Specrails.

## What Changes

- **New artifact: the intent.** It is a plain-language document with five sections and no solution section:
  1. Problem
  2. Outcome sought, with "how we will know" success signals written as an optional hypothesis: *We believe X will produce Y; we will know when Z*
  3. Who and what it affects
  4. Constraints
  5. Open questions

  A spec stores its intent as a first-class field. The intent is shown and edited in the spec detail and carried to every agent that works on the spec (operator, Explore session, deriver, architect, reviewer).
- **The intent ends as `intent.md` in the OpenSpec change.** When a delivery commits the work, Desktop writes the spec's intent as `openspec/changes/<change>/intent.md`, or into the archived change directory when the run archived it. The intent then lives in Git next to the code and the derived spec.
- **The intent is the default door for new specs:**
  - *Mission agent:* the operator interviews the person like an analyst and emits an `intent-draft` card. This card replaces `problem-frame` as the mandatory artifact before a spec, and keeps the two-readings discipline. Answering the intent satisfies the `commit_draft` gate, and the committed spec carries that intent. A user waiver, "write the spec directly", still works as today.
  - *Add Spec modal:* a new **Intent** mode is selected by default. The person describes the problem, and one premium generation returns the intent plus a spec derived from it, for the person to review. Quick, Explore and Raw stay available.
- **Two paths with equal weight from any intent** ("explore to discover, delegate to build"). No path is labelled as recommended:
  - **Explore**, the former Flow: an interactive session in an isolated worktree, seeded with the intent. At settlement the derived spec traces back to the intent, and the intent's open questions record their answers. The intent itself is never rewritten.
  - **Delegate**, Implement: the spec derived from the intent goes to a rail. The intent rides in the run briefing, and the reviewer judges the work against the outcome and success signals as well as the acceptance criteria.
- **Rename Flow → Intent everywhere a person or a contributor reads it:**
  - UI copy in all 8 locales, board label "In Intent", command palette, shortcuts
  - User guides in 8 locales and internal docs
  - Module and feature paths (`server/modules/flow` → `server/modules/intent`, `client/src/features/flow` → `client/src/features/intent`)
  - Component and type names

  **Persisted and cross-repository identifiers are frozen:** the `flow_sessions` and `flow_effects` tables, `surface = 'flow'`, `factory:flow-spec`, `metadata.flow`, `source: 'flow'`, the Core capability `flowSessions`, Core session ids `flow:<id>`, the `flow-offer` and `flow-*` fence blocks and the `flow.state` WebSocket event. HTTP routes gain `/intent/*` aliases while `/flow/*` keeps working, and MCP tools gain intent names with the old names kept as aliases.
- **BREAKING (UX only):** the mission agent no longer emits `problem-frame` for new work. Stored `problem-frame` blocks still render and still satisfy the gate in conversations that already have one.

## Capabilities

### New Capabilities
- `intent-artifact`: the intent document (sections, validation, Markdown form), its storage on a spec, the detail view and editor, propagation to agents, and its materialization as `intent.md` in the delivered OpenSpec change.
- `intent-mode`: the interactive Explore path (formerly Flow) under its new name. It covers the rename and alias rules, the frozen contracts, starting from an intent, settlement that keeps the intent and records answered open questions, and the equal-weight Explore/Delegate choice.

### Modified Capabilities
- `agent-spec-framing`: the mandatory framing artifact becomes the `intent-draft` (problem, outcome, success signals, affects, constraints, open questions, two readings and their discriminator). The `commit_draft` gate accepts an answered intent (or a legacy answered `problem-frame`), and the committed spec carries the intent.
- `explore-spec`: the Add Spec modal gains a default **Intent** mode next to Quick, Explore and Raw.
- `premium-spec-generation`: when a spec is authored from an intent, its Problem Statement, Out of Scope and acceptance criteria SHALL derive from the intent's problem, constraints and success signals, and the spec SHALL NOT contradict the intent.

## Impact

- **Server:**
  - `server/modules/flow/**` → `server/modules/intent/**`
  - Ticket store schema: an `intent` field (additive)
  - Spec generation (`spec-generation.ts`, `spec-contract-prompt.ts`): intent-first generation
  - Mission operator prompt, framing gate and fence promotion (`agent-operator-prompt.ts`, `agent-spec-framing.ts`, `agent-fence-promotion.ts`)
  - Loop executors: the intent goes into the Flow → Spec summary and the Implement briefing
  - Delivery: `intent.md` materialization before the delivery commit
  - MCP tools: aliases plus the intent in `specrails_specs`
  - Route aliases and the boundary manifest
- **Client:**
  - `client/src/features/flow/**` → `client/src/features/intent/**`
  - New intent card, intent section in the spec detail, and Intent mode in `ProposeSpecModal`
  - i18n in 8 locales
- **Docs:** user guides (8 locales: `8-flow-mode.md` → `8-intent-mode.md`), `docs/internals/flow-mode.md` → `intent-mode.md`, module READMEs, AGENTS feature map, API reference, source map.
- **OpenSpec:** the `flow-mode` change is archived first (its spec becomes canonical), and this change then supersedes it.
- **No Core change.** Desktop keeps using `derive-change`, `summaryPath` and the existing capabilities. Companion and the website docs mention Flow; they are follow-ups outside this repository.
