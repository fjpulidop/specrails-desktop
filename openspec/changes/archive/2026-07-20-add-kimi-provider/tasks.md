## 1. Adapter foundation

- [x] 1.1 Implement and register a Kimi adapter with official binary, paths, model catalog, defaults, capabilities, and minimum version
- [x] 1.2 Build new/resume headless argv for every SpawnAction using prompt mode and stream JSON
- [x] 1.3 Parse Kimi assistant, tool, retry, error, and session-resume-hint JSONL fixtures tolerantly
- [x] 1.4 Extract truthful normalized results without fabricating tokens or USD cost
- [x] 1.5 Add executable/version/auth detection and cross-platform spawn tests for native and npm shims

## 2. Provider and setup surfaces

- [x] 2.1 Add Kimi to server discovery, setup prerequisites, project validation, provider selection, registry, and defaults
- [x] 2.2 Add Kimi labels, icon/metadata, Add Project, Project Builder target-provider selection, compatible selectors, status UI, and translations
- [x] 2.3 Add official Kimi model and K3-only effort catalogs; clear effort on incompatible model/provider changes and never fall back to Claude
- [x] 2.4 Gate Kimi activation on a compatible Core framework and provide update/install remediation
- [x] 2.5 Add Kimi terminal launch descriptors without starting `kimi server`

## 3. Chat, specs, and attachments

- [x] 3.1 Enable Kimi in Project Chat, Agent Chat, and Explore with streaming, resume hints, errors, cancellation, and cwd isolation
- [x] 3.2 Preserve provider/model/effort/session/profile through conversation updates, provider switches, and reruns
- [x] 3.3 Enable Kimi Explore/proposals and agentic Quick Launcher commands (including `/opsx:ff`) through adapter actions
- [x] 3.4 Capability-gate Quick Spec, AI Edit, Contract Refine, SMASH, and Re-SMASH so Kimi is rejected before spawn or destructive mutation when no safe tool policy exists
- [x] 3.5 Pass text attachments and safe image file references to Kimi with media-tool guidance and path validation
- [x] 3.6 Use deterministic auto-title for Kimi and capability-gate file summaries/construction-story AI before spawn

## 4. Rails, loops, and profiles

- [x] 4.1 Enable Kimi implement rails, batch, retry, rerun, pause/cancel, worktree overlays, and PR delivery
- [x] 4.2 Add Kimi command/skill translation and relocated source-repo orientation to queue and loop executors
- [x] 4.3 Enable Freestyle and Kimi custom/factory loops without a Loop Decider; reject Kimi + Decider before the first step
- [x] 4.4 Make profile storage, validation, defaults, model overrides, and analytics Kimi-aware
- [x] 4.5 Make Kimi custom role discovery, manual creation/editing, validation, routing, and execution work through Kimi role skills; fail closed for AI generation/test/refine
- [x] 4.6 Allow Kimi as a Project Builder target and committed-milestone Batch launcher; reject day-0 blueprint and M2+ milestone generation before spawn or mutation

## 5. MCP and integrations

- [x] 5.1 Add additive `.kimi-code/mcp.json` generation/merge for the Desktop MCP bridge and user/project scope
- [x] 5.2 Enable Serena install, verification, repair, rollback, and uninstall for Kimi
- [x] 5.3 Make plugin/integration capability UI, health, repair, removal, and backend state provider-scoped for Kimi
- [x] 5.4 Preserve provider isolation and secrets when multiple conversations use different MCP configurations

## 6. Analytics and lifecycle

- [x] 6.1 Record Kimi invocation lifecycle, provider, model, duration, session ID, success/failure/abort exactly once
- [x] 6.2 Represent Kimi cost as null/unavailable and update spending/budget/UI aggregation semantics
- [x] 6.3 Add Kimi to framework materialization, update, relocated overlay, cleanup, project removal, and shutdown
- [x] 6.4 Add capability/inventory tests that require Kimi on compatible selectors and require its omission plus server-side rejection on unsafe structured surfaces
- [x] 6.5 Remove inherited `KIMI_CODE_EXPERIMENTAL_FLAG` from managed spawns and qualify the stable Kimi 0.27 v1 contract

## 7. Cross-platform verification

- [x] 7.1 Run adapter, chat, structured-action safety, Project Builder, loops/Decider, Code Explorer, rails, profiles, MCP, plugins, analytics, setup, framework, and client tests
- [x] 7.2 Run typecheck, production build, server tests, client tests, and packaged-path tests
- [x] 7.3 Add Windows multiline/Unicode/path/process-tree coverage for Kimi prompt invocations
- [x] 7.4 Verify the OpenSpec change against implementation, validate all fail-closed paths, and document the external live-Kimi canary

## Verification evidence

- `npx vitest run`: 251 server test files and 6,551 tests passed.
- `npm run test:client`: 333 client test files and 4,016 tests passed.
- `npm run typecheck` and `npm run build` passed.
- `openspec validate add-kimi-provider --strict`, `git diff --check`, locale
  key parity, and parsing of all changed JSON passed.
- Adapter fixtures and spawn tests cover Kimi 0.27 JSONL, trusted terminal
  resume hints, custom/model aliases, K3 effort, environment isolation,
  cancellation, npm Windows shims, native command-line limits, multiline and
  Unicode prompt transport, attachments, and fail-closed tool policies.
- Structured-action tests prove that unsupported Kimi requests fail before a
  provider process, file-summary watcher, manager call, database mutation, or
  destructive state change.
- The official `@moonshot-ai/kimi-code@0.27.0` package was installed in an
  isolated temporary prefix and its `--version`, `--help`, `doctor`, and
  unauthenticated prompt behavior were inspected. A billable authenticated
  live-model canary was intentionally not run.
- This source change requires `specrails-core` 4.12.0. The Desktop release
  bundle remains pinned to the last published Core (4.11.0) until the Core
  feature and release PRs merge; the exact bundle lock must then be regenerated
  to 4.12.0 before this Desktop PR is marked ready.
