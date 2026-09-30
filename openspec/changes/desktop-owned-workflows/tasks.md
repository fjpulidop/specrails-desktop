## 1. Core operations
- [x] 1.1 Add independently executable implementation operations with durable private state, capability and schema contracts.
- [x] 1.2 Verify phase success, failure, correction, interruption, recovery and compatibility behavior.

## 2. Desktop composition and admission
- [x] 2.1 Define expanded builtin graph and versioned loop-owned agent configuration.
- [x] 2.2 Bind and validate published loop agents at admission, preserving project verification and frozen resume inputs.
- [x] 2.3 Preserve historical configurations and edited recipes; support explicit import and duplication.

## 3. Editor and settings
- [x] 3.1 Add editable agent definitions and complete engine settings to the loop editor.
- [x] 3.2 Remove project agent editing while retaining repository verification settings and migration guidance.
- [x] 3.3 Update locales and frontend behavior tests.

## 4. Integration and delivery
- [x] 4.1 Run paired lifecycle and delivery tests, including candidate evidence and restart recovery.
- [x] 4.2 Update both repositories' documentation, source maps and reviewed boundaries.
- [x] 4.3 Complete typechecks, coverage, architecture, build and package checks; report any environmental limitations.

Validation completed: Core 105 suites / 1,323 passed; Desktop server 415 suites /
9,130 passed; client 398 suites / 4,700 passed. Coverage gates passed unchanged.
Paired factory and recovery/compatibility suites passed (39 tests). Both
repositories passed typechecks and installed-package checks; Desktop also passed
architecture/source audits, script tests and the paired Core 5.1 contract check.
Core coverage was rerun without competing heavy suites after timeout-only
failures under load; the final run passed with the original timeouts.


## 5. Workflow-defined agent steps (scope correction)
- [x] 5.1 Define generic agent steps and declarative artifact, verification, review and approval gates; retain legacy phase execution for old snapshots.
- [x] 5.2 Implement scoped artifact contracts, proposed verification commands and candidate-bound archive guards in Core primitives; verify failure and resume behavior.
- [x] 5.3 Replace new Implement/Ship recipes with custom loop roles and generic pieces; freeze and capability-gate admission.
- [x] 5.4 Make new agent steps independently configurable in the node inspector, including agent creation, permissions, instructions, schemas and routing; mark fixed phase pieces historical.
- [x] 5.5 Complete paired execution, recovery, delivery and UI checks and update both repositories' documentation and package contracts.

## 6. Incremental project construction
- [x] 6.1 Integrate a successful builder spec through the guarded local delivery decision before allocating the next worktree.
- [x] 6.2 Keep integration durable and idempotent; retry integration without replaying implementation and recover interrupted integrations.
- [x] 6.3 Verify sequential accumulation with real Git worktrees, failure/retry and checkpoint behavior; document and translate integration status.

## 7. Freestyle invocation repair
- [x] 7.1 Render launch placeholders inside command templates while preserving inserted task data as literal text.
- [x] 7.2 Give free-form workflows direct-work agent instructions without an unbound OpenSpec apply prerequisite.
- [x] 7.3 Verify rendered prompts through the actual paired runtime, factory refresh and focused compilation tests.

## 8. Live execution graph
- [x] 8.1 Highlight running nodes and mark completed, failed and interrupted attempts distinctly, preserving scope and retry semantics.
- [x] 8.2 Add full-window graph mode with live updates, component navigation, Escape/exit controls and restored keyboard focus.
- [x] 8.3 Update locales and documentation; verify graph behavior, log viewer tests, typecheck, client build and architecture audit.

Freestyle repair: 566 loop tests pass, plus two paired Freestyle execution/resume
tests with actual rendered-spec assertions and the builtin refresh/customization
regression. Typecheck, architecture audit and build pass. Retained executions
keep their admitted definitions; relaunch to use the corrected recipe.

Scope-correction validation: Desktop server coverage passes (416 suites, 9,144
tests; 9 suites skipped), and client coverage passes (401 suites, 4,724 tests).
The paired factory suite passes all 12 tests, with correction additionally
rechecked against the final Core build. Builder coverage includes 36 chain tests
and a real three-spec Git worktree accumulation test. Typechecks, architecture
and source audits, builds and installed-package checks pass. Core's focused
engine, contract, artifact, archive, approval and fork checks pass.
An additional full Core coverage run was interrupted after signaling a long
host-flow failure; that host case passes in isolation and all four preceding
host cases pass together (46 seconds). Full Core coverage is
not claimed for this scope correction.

## PR verification (2026-09-30)

Core's full serial coverage passes (106 suites, 1,333 tests, one skipped), as
does its installed-package check. The paired Core contract and all 46
factory/compatibility/recovery tests pass. Native verification passes: 47 unit
tests, all example builds, and the isolated mission window smoke.

Public provider choices are restricted to Claude, Codex and configured local
engines. Hidden CLI connections remain in persistence; a regression test checks
that saving a visible engine preserves them. The obsolete Roles choice and
provider-defaults settings section are removed. Public guides and website copy
no longer advertise the hidden providers.

The affected UI suites pass (206 provider/settings tests and 270 mission,
builder, onboarding and MCP tests). Typechecks, architecture/source audits,
95 script checks, production build and installed Desktop package checks pass.
Full client and server coverage are being rerun after updating stale UI and
recovery expectations; thresholds and timeouts remain unchanged. Final PR
validation records the completed runs.
