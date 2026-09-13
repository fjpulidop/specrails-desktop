# Implementation checklist

Status: local implementation complete; unchecked items retain their native-distribution/publication gates. See the paired Desktop verification record for exact test evidence and limitations. Subsequent coding assistant: GPT-6 Astra, reasoning medium. Read proposal/design/specs and the paired Core contracts.md before applying. Core groups C0–C7 are defined in its tasks.md. D0–D5 below are delivery groups, not new agent phases.

## 1. D0 — Capability negotiation and saved-runtime compatibility

- [x] 1.1 Extend `server/agent-runtime-loader.ts` API validation and read-only per-role transport capability queries, with runtime/transport/model-scoped caching. Test old API1, unknown/malformed metadata, global flags with unsupported installed effort and no inference or legacy-catalog fallback.
- [x] 1.2 Persist immutable runtimeIdentity for new admissions and retain original runtimes before active-package replacement; verify integrity on reopen/resume. Coordinate Core C0 fixtures; test global changes cannot redirect saved jobs and referenced runtimes survive cleanup.
- [x] 1.3 Support real v4 saved-job continuation through proven original-runtime resolution; preserve original checksums/config. Test unavailable/unproven legacy identity produces actionable recovery and readable history without paid attempts.
- [x] 1.4 Add package-derived schema/API fixtures that run without a sibling Core checkout. Verify actual packaged CLI boundary rather than importing Core ESM into the CommonJS sidecar.

## 2. D1 — Lossless configuration and explicit launch intent

- [x] 2.1 Mirror the agreed optional Core fields in server/client types, `agent-runtime-settings.ts` and `server/schemas/agent-runtime.schema.json`; add strict valid/invalid/absent-field parity fixtures against the built Core schema.
- [x] 2.2 Replace lossy settings row conversions with stable optional key/label mappings preserving cwd/env/timeout/policy and role fields; test identical-check reordering, semantic edits, legacy keyless entries and load-edit-save-launch in server/client.
- [x] 2.3 Implement one pure effective-config resolver with project-role > applicable defaults precedence and explicit developer-only user override provenance. Test mixed providers/models, provider-specific model defaults and no cross-role overwrite.
- [x] 2.4 Trace and update `loop-executors.ts`, `agent-runtime-bridge.ts` and every implement/batch/mission producer to distinguish defaults from explicit launch overrides. Test each path and ensure only deliberate developer overrides reach Core.
- [x] 2.5 Freeze resolved config/provenance before launch; test resume with changed project/global defaults, effort and escalation preserves original request and persisted tier. Reject incompatible requested controls before paid execution.

## 3. D2 — Focused settings controls

- [x] 3.1 Extend existing role rows with capability-aware effort and collapsed single same-provider escalation selectors. Query both base/escalation model support; label provider-default effort and fixed per-role triggers; test provider changes and invalid saved dependent selections.
- [x] 3.2 Add advanced context/review/planning/acceptDeveloperChecks/concurrency controls using Core defaults only for new capable jobs. Keep reuse policy host-authored and prevent the form from fabricating independence/cache guarantees.
- [x] 3.3 Show effective requested role configuration and provenance, explicit developer launch-override scope, and named unsupported-capability errors. Preserve existing global provider connections/custom role-prompt ownership and mandatory protocol/OpenSpec safeguards.
- [x] 3.4 Add accessible labels/focus/keyboard interactions and all eight locale catalog entries (en/es/fr/de/pt/it/zh/ja); test locale key parity and no duplicated verifier/provider sections.

## 4. D3 — Durable evidence and one shared log panel

- [x] 4.1 Add bounded allowlist validation for efficiencySummary/runtime-efficiency-event using Core C5 fixtures. Extend existing metrics/accounting projection with deterministic event-ID deduplication; test malformed/absent fields, null versus zero and replayed continuation usage.
- [x] 4.2 Persist invocation IDs/ordinals before launch and terminal snapshots in existing job events; separate historical read-context resolution from the worktree-required resume context. Test newer failure/cancel without valid optional summary supersedes current state after cleanup while retaining history/cumulative usage.
- [x] 4.3 Add project/run-scoped evidence list/detail routes using discoverable source descriptors, opaque IDs/bound cursors, bounded CLI args and saved runtime/state. Test cross-project/run access, traversal, multi-file harness pagination, helper cancellation and no paid call on reads.
- [x] 4.4 Extend shared `AgentRuntimeRuns.tsx` / `AgentRuntimeMetrics.tsx` presentation with route/reason, repository-attributed checks, origins, actual result, executed/reused/not-run disposition and provenance. Keep selected/observed model/effort and technical acceptance/delivery distinct.
- [x] 4.5 Add lazy source/stdout/stderr expansion with text rendering, truncation/loading/error/unavailable states and bound pagination. Test original-worktree removal, missing Core evidence state and reused evidence without fake durations or savings.
- [x] 4.6 Integrate activity events into the existing narration model without new workflow phase enums; test multiple front/back repositories and failure-then-success continuation do not revive stale current failure badges.
- [x] 4.7 Verify mission and board use the same panel and repair the shared modal overflow/focus chain. Add component tests plus a browser regression with long evidence and short viewport covering mouse/trackpad-equivalent wheel and keyboard reachability.
- [x] 4.8 Localize new summary/evidence/narration copy across all eight catalogs and ensure unknown metrics are not rendered as zero/accepted. Keep `core-completion.ts` and settlement acceptance floors as the only host delivery gate.

## 5. D4 — Paired compatibility and regression gates

- [x] 5.1 Extend `scripts/smoke-agent-runtime-pair.mjs` with deterministic local provider fixtures for correction, persistent harness, evidence, configured escalation, eligible reuse/invalidation and resume using actual compiled Desktop/Core and OpenSpec.
- [x] 5.2 Execute the compatibility matrix: new Desktop/old Core unsupported feature, new/new success, real saved v4/original Core continuation, missing original runtime, and v5 resume after global config/Core change. Verify no duplicate cost or host delivery on replay.
- [x] 5.3 Run focused server regression suites for loader/settings/bridge/controls/metrics/accounting/settlement/core-completion and relevant loop-executors paths, then client settings/runs/metrics/narration/JobDetailModal tests as affected.
- [ ] 5.4 Run `npm run ci` once on the final implementation; fix failures and complete existing Windows parity/macOS package checks. Exercise the shared evidence UI in both modes with a browser and record actual outcomes.
- [x] 5.5 Run package-based compatibility without a sibling checkout and production assembly checks. Ensure optional new capability fixture tests are not skipped merely because a local Core tree is missing.

## 6. D5 — Production pin and reviewable handoff

- [ ] 6.1 After Core C7 provides a verified published package, update exact Core version/integrity in `scripts/assemble-bundled-core.lock.json` and `.github/workflows/desktop-release.yml` together; update stale packaging/runtime-version docs. Do not guess a future release number.
- [ ] 6.2 Assemble and smoke the pinned production bundle/sidecar, verify API/schema/evidence/continuation support from that bundle and retain referenced older runtimes. Treat local source assembly as a separate development check.
- [x] 6.3 Document new controls, recorded-versus-live evidence, original-runtime recovery and rollback. State measured results and benchmark limitations; do not claim AI savings from the offline fixture.
- [x] 6.4 Review implementation against both OpenSpec changes, record passing checks and package identities, remove newly unreachable duplicate paths and prepare coordinated release notes. Keep economic routing unset unless explicitly configured and validated.

Dependency order: Core C0 + D0 → D1 → D2; Core C5 + D0 → D3; all → D4 with Core C7; published Core + D4 → D5. D2 and D3 can proceed in parallel once their contracts are stable. D5 publication/pinning is a release step, distinct from finishing local implementation and review.

Validation note: local CI suites and follow-up regressions passed; the unchecked CI task retains only its native OS/Node distribution-matrix requirement. Publishing and exact production pinning remain separate release steps.
