## Context

Planning baseline: main `d8d8597a`, branch `codex/implementation-efficiency`, 2026-09-13. This change is prepared for a subsequent implementation with **GPT-6 Astra, reasoning medium**. It does not change customers' runtime role models.

Core remains the authority for the architect → developer → verify → reviewer → archive graph, OpenSpec, verification receipts and technical acceptance. Desktop owns configuration, admission, immutable runtime resolution, job projection and host delivery. The paired Core `openspec/changes/implementation-efficiency/contracts.md` is the authoritative target wire contract; do not introduce a parallel Desktop dialect.

Verified issues in the current implementation:
- `server/loop-executors.ts` always supplies provider/model defaults; `server/agent-runtime-bridge.ts` can overwrite all three configured role providers and the developer model. Incidental defaults are indistinguishable from a user override.
- Settings row conversion in `AgentRuntimeSettingsSection.tsx` can discard check cwd/env/timeout metadata.
- `agent-runtime-loader.ts` checks API1 but not the new feature capabilities. A mutable path/mtime cache cannot identify the executable that admitted a saved job.
- `agent-runtime-controls.ts` summary loading depends on available runtime scope/worktrees. Historical usage can disappear after cleanup despite existing durable job events.
- Shared runs/metrics components already serve mission and board. Extend them; do not create a second mission-only implementation panel or another run database.
- Source assembly and production release pins differ. The release workflow and assembly lock currently target Core 5.2.2 while a local bundle reports 5.3.0. A development run cannot validate the published package path.

## Goals / Non-Goals

Goals: honor explicit configuration; expose supported efficiency policies and effective routing; make evidence useful from either log mode; retain truthful history through continuation and cleanup; ship only a tested Core/Desktop package pair.

Non-goals: another verifier/QA role, a new orchestration layer, automated price/model selection, a second settings page for each provider, replacing existing connection/role-prompt ownership, computing check validity in the browser, or displaying speculative savings.

## Decisions

### D1. One negotiated packaged contract

Extend the API probe and its schema guards for Core's optional versioned capabilities and actually supported workflow versions. Missing capabilities mean old behavior is available, not permission to silently enable unsupported fields. Unknown/malformed capability versions do not pass feature admission. A requested unsupported feature produces a named, actionable preflight error before a provider call.

Probe caching is scoped to the resolved immutable executable/package identity, not only mtime/size. Continue consuming Core through its executable boundary; the CommonJS/pkg sidecar must not import arbitrary Core ESM source to access evidence or schemas. Use fixtures emitted/copied from the built package in tests so schema drift fails even when a sibling checkout is absent.

For a capable runtime, fetch per-role transport/effort support through the read-only runtime capabilities CLI in the shared contract. Cache by runtime plus installed transport identity and queried provider/model. The legacy provider catalog does not prove support for current programmatic transports. Unknown support remains visible; capability introspection itself neither calls AI nor mutates configuration.

### D2. Explicit configuration precedence and round trips

Resolution order for NEW jobs:
1. Project per-role assignment supplies that role's explicit provider/model/effort/maxTurns/escalation.
2. Existing global/provider defaults fill missing fields; they never overwrite explicit role selections. Resolve model defaults only within the selected provider, never carry another provider's default model across.
3. As clarified by the user on 2026-09-13, a selected launch provider applies to architect, developer and reviewer. Explicit launch model/effort also applies to all roles. With no provider selection, preserve project role assignments.
4. Validate capability/model/effort/limits; normalize the new Core efficiency defaults once; persist the complete effective configuration and provenance before launching.

Use a typed provider override with provenance for every affected role. Resolve the request/stored-rail/Mission provider at the shared launch boundary; a UI-only payload is insufficient. A generic engine default without a selection must not generate an override. Trace every producer, including implement/batch/mission launches. Resume reads only the frozen effective request and retained runtime. Current settings may be displayed as different but never silently mutate a continuation.

Use named mapping helpers shared by load/save/launch. Preserve each configured check's stable identity and all supported cwd/env/timeout/policy fields while editing its label or command. Do not reconstruct full objects from a lossy row subset, and do not write normalized v5 defaults into an old saved request. Strict client/server/Core schemas and optional-null transport fixtures must agree.

Core configuration gains optional host check key/label fields. Assign stable form row keys before edits/reordering and persist them only when the selected runtime accepts them. Legacy frozen requests use their original parser. New keyless v5 admissions normalize deterministic run-local slot/digest/occurrence IDs. Test reordering identical checks separately from semantic execution deduplication; UI identity must not depend on array index after editing.

### D3. Small capability-aware controls

Extend existing role rows, without provider-specific duplication:
- Base provider/model remains primary. Effort appears only for supported values on the selected actual transport; unset reads “Provider default”.
- Optional escalation is collapsed initially and unset by default. It selects one explicitly configured model under the same provider, with optional supported effort and a short explanation of the fixed trigger for that role.
- Reviewer rejection is never presented as a reason to choose a more expensive reviewer. Its optional escalation applies to the existing single protocol repair.
- Changing a provider clears incompatible dependent selections visibly; unsupported saved values remain visible with validation errors instead of being silently rewritten.
- Global custom prompts remain in their existing editor; safeguards, OpenSpec requirements and protocol contracts cannot be removed by a prompt override.

Expose context/review full versus incremental and full versus proportional planning as advanced implementation controls, with a brief description that complete acceptance remains required. Accepting developer checks defaults on for v5. Concurrency defaults one and offers values 1–4 with an explanation that only declared independent repositories overlap. Do not invent independence/reuse declarations from folder names or a UI checkbox. Host-authored per-check policy is retained by the normal config pipeline; advanced raw policy editing need not be added to the form in this iteration.

Show a concise unsupported-capability reason and upgrade route when a selected Core cannot use a control. Legacy jobs remain readable. The settings form must never imply an optimization is effective merely because it was requested.

### D4. One evidence panel in both log modes

Extend `AgentRuntimeRuns.tsx` / `AgentRuntimeMetrics.tsx` and the existing shared log surface used by JobDetailModal/Jobs/RailRow. Add an execution summary and expandable evidence list to that shared boundary, not new parallel board/mission implementations.

Visible essentials:
- Recorded technical acceptance and original candidate, with host delivery status separate.
- Phase + repository name/role where available + requested and observed model/effort. Repositories with identical front/back labels remain distinguishable by their unique display name; basename alone is not identity.
- Actual role invocations/corrections and model escalation reason; unknown measurements stay unavailable.
- Check label, repository, required status, origin, executed/reused/not-run disposition, actual result and measured duration.
- For reused results, show that prior evidence was reused and allow following its provenance; do not show fake “0 ms passed” executions or inferred dollars saved.
- Concise rerun/invalidation reason; detailed raw identities stay in a diagnostic expansion.
- Expandable source and stdout/stderr pages fetched on demand, with explicit truncation and loading/error/empty states. Escape content and render as text. Do not execute or interpret saved harnesses in the UI.

Keep architect/developer/verify/reviewer/archive phase enums unchanged. New efficiency activity events enhance narration with repository/check attribution; they do not create a new agent phase. Preserve corrected terminal state after continuation rather than reviving an old failed step from replay.

Use an explicit flex/min-height/overflow chain in the shared modal panel. Both parent logs and expanded evidence must remain reachable with wheel, trackpad and keyboard when the viewport is short. Add component interaction coverage plus one browser-level mission/board regression with long evidence and a small viewport. No duplicate scroll-lock implementation.

### D5. Durable honest history with existing events

Validate and project optional `runtime-efficiency-event` / `efficiencySummary` data using allowlist helpers like existing metrics projection. Bound strings/arrays and reject malformed payloads without corrupting the ordinary log. Deduplicate by stable event identity across reconnect, replay and continuation; never use UI array position as identity.

Persist validated terminal summaries with the existing job events/ledger. Assign a durable Desktop invocation ID/ordinal before each initial/continuation launch, independent of optional Core metrics. Any newer invocation supersedes current presentation even when its terminal payload omits or malforms efficiencySummary: the old summary remains historical and new missing metrics stay unavailable. `core-completion.ts` and existing settlement logic remain the only delivery/acceptance path; an efficiency-summary event does not independently promote a card to delivered.

When worktrees are missing, serve the recorded summary from the host store and label it as the result for the original candidate. When retained Core state remains, historical evidence can still load. When that state is gone, show the recorded summary and evidence unavailable. Do not keep stale “currently valid” badges or enable continuation based on a historical success snapshot.

Extend project/run-scoped read routes for evidence listing and detail with the opaque ID/cursor contract. Enforce project membership, known run identity and bounded arguments; never accept a client filesystem path or arbitrary CLI fragments. Resolve the saved runtime/state internally. A cross-run or unknown evidence/source/cursor yields not found/invalid input without probing unrelated paths. Request cancellation terminates any outstanding helper read appropriately; evidence reads must never call providers or regenerate artifacts.

Separate historical read-context resolution from the current AgentRuntimeControls.context() resume path, which requires available worktrees. Source descriptors from Core detail summary populate multi-file harness choices; displayPath is a label only. No new path-based read endpoint is needed.

### D6. Runtime pinning before new defaults

Persist Core package version/integrity, workflow/instructions versions and API identity at admission, alongside the existing frozen request reference. Retain the package/executable needed by active jobs under the existing runtime cache/bundle management boundary. Updating the global active Core only affects new admissions. Cleanup must not remove a runtime still referenced by a resumable job; after terminal cleanup, history remains readable as above.

Legacy v4 requests do not record exact package identity. An old request's change/config file is not enough to infer the original Core from the now-active global version. Require trustworthy package provenance/integrity and exact compatibility; otherwise expose an actionable original-runtime recovery state, preserving logs/evidence and making no paid attempt. Retain packages before active-runtime replacement and verify integrity on reopen. Optional compatibility probing reconstructs input/workflow fingerprints read-only; never call runCoreWorkflow/initializePipeline/prepareOpenSpec as a probe. Matching fingerprints alone do not establish package provenance. Store a proven legacy resolution beside the host job without changing its original request/checksums.

Release gate fixtures must include a real saved v4 request/checkpoint + original Core continuation, unavailable-original-runtime behavior, and v5 resume with changed global settings. Implement and test runtime resolution before new v5 defaults are admitted in Desktop.

### D7. Ordered release and measurable claims

Deliver Core contracts/tests first; Desktop configuration/projection can be developed in parallel against fixed fixtures. Publish the verified Core package before final Desktop production pin changes. Update the exact version in the assembly lock and desktop-release workflow together, and refresh packaging docs. Verify schema/capability/evidence behavior from the packed/published package, then the actual assembled sidecar/bundle.

Run `scripts/smoke-agent-runtime-pair.mjs` against compiled Core and Desktop using a local deterministic executor fixture. Extend it to cover correction, developer checks/harness, evidence, supported route escalation, conservative reuse/invalidation and continuation. Keep a package-based test that runs without a sibling repo; source-only skipIf coverage is insufficient. Existing macOS/Windows packaging and test gates remain required.

No paid experiment runs as part of settings integration. Core's offline evaluation proves mechanics; a separately authorized paired experiment measures actual AI cost and independently accepted output. Do not rename invocation-count reductions or cached-token totals into monetary savings. No automatic cheaper model assignment is part of this rollout.

## Risks / Trade-offs

- Metadata loss through forms → lossless mapper and load-edit-save-launch fixtures for every supported field.
- Two sources of truth → Core owns validity; Desktop stores typed projections and provenance only.
- Saved jobs stranded by upgrade → immutable runtime admission/resolution first, real v4 continuation release fixture, explicit recovery if identity is unproven.
- More controls overwhelm users → extend existing rows, progressive disclosure, no duplicate provider sections and no mandatory raw cache policy form.
- Long evidence traps scroll/focus → shared modal sizing and browser regression for both modes.
- Local source passes but packaged product fails → exact published Core pin and production bundle smoke are separate gates.

## Migration Plan

1. Add optional capability/status/event parsing and runtime identity retention with old behavior still available.
2. Add configuration roundtrip/precedence fixes and shared evidence projection under capability checks.
3. Validate legacy and new saved-job continuation, malformed/absent capabilities and cleanup history.
4. Integrate the new Core package, enable v5 policy defaults only for new jobs on a capable runtime, and ship the production pin atomically.
5. Rollback changes new admission selection; retain runtimes and evidence for existing jobs. No destructive migration of requests or events.

## Open Questions

No unresolved product choice blocks implementation. Installed transport effort support and legacy runtime provenance must be measured in the first implementation stage and represented as unsupported/unknown when not proven. The optional real-provider benchmark needs separately supplied models and aggregate spend policy; it is not required to prepare or validate these planning artifacts.
