## Context

The supplied log follows one Implement run over a shared veterinary specialty-filter spec with Front and Back worktrees. Claude first reported that the architect's required `opsx:ff` skill was unavailable. It copied skills into the artifact repository and resumed the architect. Its next parent reply said the architect was still working; `InteractiveJobSession` nevertheless auto-finalized the step, warned that one background task would be terminated, and advanced to verification. Verification found no requested implementation in either repository even though the baseline suites passed. The repair prompt's FAIL branch only authorized fixing failing checks, while its missing-feature branch required PASS.

This change concerns the host execution contract, packaged skill availability, and shared loop instructions. The log is diagnostic evidence, not authority to run commands in the reported application repositories. No paid provider run or modification of those repositories is needed for the regression suite.

## Goals / Non-Goals

**Goals:**

- Preserve delegated work and its eventual result within the same managed Claude session until a substantive step result is available.
- Make OpenSpec skill registration deterministic for managed Claude processes in development and packaged builds.
- Make verification and refinement consistent for missing implementation, failed checks, and cross-repository acceptance criteria.
- Retain usage accounting, cancellation, provider error handling, existing delivery gates, and repository isolation.

**Non-Goals:**

- Reimplement Claude's task scheduler or allow unbounded autonomous continuation.
- Install or enable plugins globally, copy skills into user repositories, or change unrelated providers' command syntax.
- Automatically replay the user's failed run, adopt its background workers, or promise success for arbitrary code and external dependencies.

## Decisions

### 1. Continue managed sessions at the existing turn boundary

`InteractiveJobSession` already tracks Claude's background-task roster and accepts stream-json user turns. On an otherwise successful auto-settlement boundary with pending tasks, send a bounded host continuation that requires waiting for their results in the foreground and completing the requested step. Keep the current child and session alive so it retains task ownership and results. A successful reply without pending tasks may settle normally.

Notification-only task frames must not become the current requested turn's result. Track task terminal updates, apply same-chunk state changes before deciding to continue, and preserve duplicate-result guards. User-queued work retains its existing precedence. Each continuation participates in existing turn usage accounting and produces an inspectable diagnostic log.

Alternative considered: immediately kill the child and warn. That is the reproduced data-loss path. Merely delaying settlement without requesting a foreground wait can strand an idle parent; bounded continuation gives the model an explicit next action. The host allows at most three collection continuations for an unfinished cohort and twelve across the step; an explicit empty activity roster resets only the cohort counter. Claude ambient watchers do not block completion. Exhaustion fails visibly rather than reporting success or repeatedly waiting forever. Stop closes turn admission synchronously before SIGTERM, so delayed process shutdown cannot dispatch another turn. The one-shot fallback cannot continue a resident process and reports unfinished non-ambient workers as a failed step.

### 2. Load an app-owned OpenSpec plugin for each Claude process

Provide the exact namespaced OpenSpec commands required by the managed pipeline using official assets packaged with Specrails. Resolve a local session plugin directory and pass it through Claude's plugin-loading arguments, preserving any existing configured plugin directories and model, effort, environment, and MCP options. Nested agents inherit the parent process's registered skill environment.

Embed the official `.claude/commands/opsx` content as an application module so both TypeScript and the packaged sidecar bundle carry the same resources without depending on an unpublished external source checkout. The runtime directory is addressed by its content hash. Before spawn, verify the exact expected file tree and bytes, excluding symlinks, hooks, and unexpected files. Modes that do not need implementation skills may retain their existing restricted preparation behavior.

Missing required assets must cause an actionable local preparation failure before the paid invocation; never claim readiness while omitting a required skill. Avoid global plugin enablement and repository-local skill copies: both make correctness depend on user configuration and contaminate the delivery with setup changes.

### 3. Verify feature completion and route repair by the actual gap

The engine copies the spec scope at run admission. Shared verify/fix commands receive all frozen ticket descriptions and repository IDs as a JSON data block through `{{spec.scope}}`, including after session replacement; template and block delimiters are escaped within values. Verification first compares the current implementation and available tests against the requested spec and active artifacts across the frozen repository manifest. It then detects and runs each applicable project's existing checks. A clean baseline, scaffolding alone, or a missing acceptance criterion cannot yield PASS. Conversely, a feature already implemented before this run may pass when supported by concrete evidence; an arbitrary requirement for a nonempty diff would reject valid work.

Refinement reads the verification result and distinguishes missing/partial implementation from failing tests or gates. Missing implementation authorizes continuing the same spec and its required architect/developer/reviewer or OpenSpec phases. Existing changes must be preserved and duplicate artifacts avoided. Missing decisions that require the user remain explicit `LOOP_BLOCKED` results. The next verification step rechecks the actual candidate before a goal is satisfied; decider goals express conditions to prove rather than assert that PASS already happened.

These prompts are shared by factory and custom loops using the command catalog. Existing custom graphs remain user-authored; this change does not rewrite arbitrary saved prompt text.

## Risks / Trade-offs

- [Claude event ordering or task roster variants] → Cover notification-only results, pending/empty rosters, terminal task events, same-chunk updates, and repeated result frames with deterministic protocol fixtures.
- [More continuation turns consume budget] → Bound retries, retain timeout/idle/cost/provider-limit controls, and expose continuation and exhausted-recovery reasons in job logs.
- [Packaged assets differ from development assets] → Validate asset resolution and exact skill namespace in both layouts, including path quoting and existing plugin arguments.
- [Prompt compliance is probabilistic] → Keep existing server-side verdict and delivery validation; test prompt contracts and simulated orchestration, and state honestly that a real paid provider run was not performed.
- [User repositories are already partly implemented] → Repair the identified missing scope and preserve prior work instead of restarting the whole feature blindly.

## Migration Plan

No data migration is needed. New invocations use the corrected session preparation and shared prompts. Existing completed runs retain their history. Deploy the packaged assets together with the resolver; reverting requires reverting both code and resource configuration. Do not replay prior failures automatically.

## Open Questions

None requiring a user decision. Exact continuation limits and asset directory layout are implementation details whose final values will be recorded with validation evidence.
