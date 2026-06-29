## Context

The Specrails loop subsystem is a published directed graph of typed nodes (`start | ai-step | shell | decider | condition | end`) executed by the **app-driven** `LoopRunManager` (`server/loop-run-manager.ts`). The app owns the iteration loop; an **AI Loop Decider** node (`server/loop-decider.ts`) returns a `continue`/`stop` verdict and the engine routes the matching branch edge. Loop-back (cycles) is a first-class, designed feature bounded by `maxIterations` (counted at the decider), a wall-clock deadline, an optional cost cap, a step-cap backstop, and an AI fail-fast. Starter templates are either hand-authored `LoopTemplate` graphs in `LOOP_TEMPLATES` (`server/loop-templates.ts`) or `PortSpec` records compiled by `aiLoopGraph`/`fixLoopGraph`. Step prompts resolve three token families in fixed order: `{{cmd:*}}` (`server/loop-command-catalog.ts`) → `{{spec.*}}` (ticket data, `server/loop-graph.ts` `interpolateSpec`) → `{{const:*}}` (`server/loop-constants.ts`).

This change adds an end-to-end **OpenSpec lifecycle** template. The engine, decider, loop-back, bounds, and ticket interpolation already exist and are reused unchanged. The gap is declarative (a catalog command + a template graph) plus one small engine capability (a run-scoped captured variable).

The `opsx:*` commands themselves are OpenSpec-generated Markdown command/skill files (`.claude/commands/opsx/*.md` + `.claude/skills/openspec-*`), **not** part of the specrails framework (framework 4.10.0 ships only `opsx-diff` for each provider). `SpecLauncherManager` already proves `/opsx:ff` runs headlessly under `--dangerously-skip-permissions` and that the created change id is detectable by regex on `openspec/changes/<id>`.

## Goals / Non-Goals

**Goals:**
- One launchable loop template that takes a Specrails ticket and drives `ff → apply → verify → (loop-back | archive)` with a single agent, fully unattended.
- Reuse the existing decider/loop-back/bounds machinery; add no new node type and no new conditional engine.
- `opsx:verify` is the authority on "does the implementation match the ticket"; the decider only routes its verdict.
- Iterating on a FAIL verdict amends the **same** OpenSpec change (no duplicate change folders) and carries the "what is still missing" gaps into the re-pass.
- Unattended close via the `openspec` CLI's native `archive -y` (which syncs main specs by default).
- Provider-aware command expansion (claude/gemini `/opsx:`, codex `$opsx:`).

**Non-Goals:**
- No multi-agent pipeline (this is intentionally the lighter, single-agent, artifact-centric counterpart to `specrails:implement`).
- No `opsx:new` step (redundant with `opsx:ff`).
- No use of `opsx:bulk-archive` (interactive, no unattended flag).
- No new `condition` (AND/OR) node evaluation (it remains a deliberate no-op; the decider covers the single satisfied/not-satisfied decision).
- No client UI work; the template surfaces through the existing gallery and an existing category.
- No `specrails-core` changes.
- Full codex/gemini parity for the opsx lifecycle commands (claude-first; tracked as a risk).

## Decisions

### D1 — Start at `opsx:ff`, drop `opsx:new`
`opsx:new` only scaffolds the change directory then explicitly STOPS without generating artifacts; `opsx:ff` calls `openspec new change` internally and generates all apply-required artifacts. Chaining `new → ff` is redundant and risks ff's "change already exists" branch. **Alternative considered:** keep `new` for an explicit scaffold step — rejected because it adds an interactive stop point and a duplicate-creation hazard for zero benefit.

### D2 — `opsx:verify` produces the verdict; the decider routes it
The bare decider receives only `title`+`description` (capped ~2000 chars) + run history — it judges the prompt text, not reality. `opsx:verify` loads the actual artifacts/tasks/code and checks implementation against the specs. So the graph is `ff → apply → verify → decider`, where the decider's goal is "stop iff `verify` reported PASS" and it consumes verify's output (in history). **Alternative considered:** decider-only (cheaper, one fewer step) — rejected: it cannot honestly assess implementation completeness from spec text alone.

### D3 — Capture the change id into a run-scoped `{{run.changeId}}` token
On `loopBack:'first'` the engine resets the AI session, so the re-pass cannot rely on session memory to find the change. The runner captures the change id from the first `opsx:ff` step's stdout via regex on `openspec/changes/<id>` (same pattern as `SpecLauncherManager`) and stores it on run state. A new token `{{run.changeId}}` resolves it in: (a) the loop-back `opsx:ff` prompt ("continue change `<id>`, address the gaps below"), and (b) the terminal `openspec archive <id> -y` shell node. Token resolution is added to the existing prompt/shell substitution pipeline (after `{{spec.*}}`, before/with `{{const:*}}`); unresolved `{{run.*}}` before capture resolves to empty string. **Alternatives considered:** (1) derive a stable kebab name from the ticket title — rejected (breaks if the title changes or collides); (2) rely on the agent to auto-select the single active change — rejected (fragile if ff creates a second change). This is the only non-declarative piece.

### D4 — Unattended archive via a `shell` node running `openspec archive <id> -y`
The `openspec` CLI's `archive -y` is non-interactive and syncs main specs by default — exactly the "yes-to-all + sync" close. A `shell` node is deterministic (no AI, no prompt) and the engine already supports shell nodes. `opsx:bulk-archive` is hard-wired interactive ("never auto-select", final confirm) with no unattended flag, and is framework-generated (edits would not survive regeneration). One ticket → one change → a single archive, so bulk is unnecessary. **Alternative considered:** a forked unattended `opsx:bulk-archive` ai-step — rejected (non-deterministic, touches generated framework files, only needed for multi-change batches this loop never produces).

### D5 — `providerNative` magic commands, not `coreCommand`
`coreCommand` entries expand to `/specrails:<name>` (claude) / `$<name>` (codex); opsx commands are `/opsx:<name>`. So the three new `LoopCommand`s use `providerNative` maps `{claude:'/opsx:ff', gemini:'/opsx:ff', codex:'$opsx:ff'}` plus a `template` fallback prompt for providers without the native command. `archive` is invoked via the `openspec` CLI in a shell node and is provider-independent, so it needs no magic command. **Alternative considered:** raw free-text `/opsx:ff` in the prompt — rejected (loses the per-provider `$`/`/` swap and ticket-id auto-injection that the catalog gives).

### D6 — Momentum override in step prompts
`opsx:ff`/`opsx:apply` have pause-and-ask escape hatches (unclear task / design issue / error). A headless loop has no human to answer, so the template's step prompts instruct "make reasonable decisions and keep momentum; never block or ask". `opsx:ff` is already momentum-biased; `apply` is reinforced by the prompt. (Durable framework-level overrides are out of scope; v1 lives in the template text.)

### D7 — Positioning vs `specrails:implement`
`specrails:implement` is the existing multi-agent (architect→developer→reviewer→archive) pipeline that goes ticket→code. This template is the single-agent, **OpenSpec-artifact-centric** lane whose deliverable is `openspec/changes/*`. The proposal/spec call this out so the two are understood as complementary, not duplicative.

## Risks / Trade-offs

- **[opsx commands are claude-only today]** → Ship claude-first; the `template` fallback gives codex/gemini a best-effort autonomous prompt. Document the limitation; real parity rides OpenSpec's multi-provider command generation (out of scope).
- **[Change-id regex could miss / multiple matches]** → Capture the FIRST `openspec/changes/<id>` match; if no id is captured, `{{run.changeId}}` is empty → the loop-back prompt falls back to "find the single active change" wording and the archive shell node is guarded (skip + fail the run with a clear message rather than archiving the wrong change).
- **[Infinite re-implementation]** → Already bounded by `maxIterations` (counted at the decider) + timeout + cost cap + fail-fast; the template sets a conservative `maxIterations` (e.g. 3) so it never spins.
- **[`archive -y` spec-merge fidelity]** → CLI archive syncs main specs programmatically; if a future change needs the agent-driven intelligent merge, that is a follow-up. For a single change per ticket the CLI merge is sufficient.
- **[Momentum override lets the agent guess on genuinely ambiguous tickets]** → Acceptable for an unattended loop; the verify→decider gate catches a wrong guess and loops back, and the user reviews the final change before merge.

## Migration Plan

Purely additive. New catalog command entries, a new template, and a new run-token capture; no schema migration, no data changes, no client changes. Rollback = remove the template + command entries + the capture block (the `{{run.changeId}}` resolution is inert when no template uses it).

## Open Questions

- Should `{{run.changeId}}` generalize to a small family of run-captured variables (a regex→token registry) for future templates, or stay a single special-cased capture for v1? (Leaning single-purpose for v1, with the capture written so it can generalize.)
- Should the template be hard-gated to claude (hidden for codex/gemini projects) until opsx parity exists, or shown everywhere relying on the fallback prompt? (Leaning: shown, claude-first, with a description note.)
