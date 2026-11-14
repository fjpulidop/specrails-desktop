# Tasks

These checked tasks describe implementation already present in the diff. Evidence names inspected tests and their assertions; it does not claim tests were executed during derivation.

## 1. Process measurement and platform readers

- [x] 1.1 Add pure resource parsing, tree aggregation and sample eligibility; verify the domain assertions cover exclusion, deduplication, vanished roots and closing-zero eligibility.
  - Evidence: server/modules/terminals/domain/mission-resources.ts, server/modules/terminals/domain/mission-resources.test.ts (asserts POSIX RSS bytes, descendant totals, exclusion of other trees, shared descendants counted once, vanished roots and live/closing/idle recording decisions).
- [x] 1.2 Discover worktree command-line roots; verify path-boundary and Windows normalization cases.
  - Evidence: server/modules/terminals/domain/mission-resources.ts, server/modules/terminals/domain/mission-resources.test.ts (asserts top-most matching roots, rejection of ticket-10 for ticket-1, slash and case normalization on Windows).
- [x] 1.3 Add Windows CPU deltas and shared platform process readers; verify parser, caching and failure-recovery assertions.
  - Evidence: server/modules/terminals/runtime/resource-sampler.ts, server/modules/terminals/domain/mission-resources.ts, server/modules/terminals/runtime/resource-sampler.test.ts, server/modules/terminals/domain/mission-resources.test.ts (asserts cumulative CPU conversion, initial/reused PID and zero elapsed baselines, single-object/BOM parsing, 500 ms cache, in-flight sharing and recovery from unavailable PowerShell).
- [x] 1.4 Add on-demand disk scanning and portable traversal; verify asynchronous route completion and recursive file-size tests.
  - Evidence: server/modules/terminals/runtime/resource-sampler.ts, server/modules/terminals/runtime/resource-sampler.test.ts, server/project-router-mission-resources.test.ts (asserts recursive byte totals, missing-root rejection, 202 scan request followed by cached bytes and 404 without a worktree; also asserts immediate scanning state, pending sharing, failure and successful retry; real du/PowerShell execution has no dedicated test evidence).
- [x] 1.5 Document platform/resource behavior; verify the changed Windows guide and terminals measurement section describe the implemented readers.
  - Evidence: docs/platforms/windows.md, server/modules/terminals/README.md (no automated documentation test evidence).

## 2. Resource ownership and project routes

- [x] 2.1 Expose provider PID and active-conversation read seams; verify current-pin filtering for desktop/Core turns.
  - Evidence: server/modules/conversations/runtime/chat-manager.ts, server/modules/missions/runtime/agent-chat-manager.ts, server/modules/missions/runtime/agent-chat-manager.test.ts (asserts deduplication of desktop/Core active IDs, exclusion of other/unpinned missions and changed pin ownership; new local chat PID getters have no dedicated changed assertions).
- [x] 2.2 Resolve Core provider PIDs from mission capability markers; verify two-mission shared-host isolation.
  - Evidence: server/modules/missions/runtime/mission-core-sessions.ts, server/modules/missions/runtime/agent-chat-manager.ts, server/modules/missions/runtime/mission-core-sessions.test.ts (asserts distinct roots for two missions under one host, host-only exclusion and rejection of a marker filename suffix; server/modules/agent-sessions/runtime/session-host-registry.ts retains an added hostPid getter with no dedicated test evidence, but resource attribution no longer consumes it).
- [x] 2.3 Compose scoped resource snapshots and register routes; verify route assertions exclude unrelated processes and return scoped history/disk state.
  - Evidence: server/project-router-mission-resources.ts, server/project-router-jobs.ts, server/project-router-mission-resources.test.ts (asserts agent/background totals, unrelated process exclusion, another mission's empty result, live exclusion through a foreign project, changed-pin ownership, not-scanned worktree and oldest-first mission history).

## 3. Durable collection and deletion lifecycle

- [x] 3.1 Append resource-history migrations and bounded SQLite storage; verify migration/reopen, retention and deletion-trigger assertions.
  - Evidence: server/db/migrations.ts, server/modules/terminals/runtime/mission-resource-history.ts, server/modules/terminals/runtime/mission-resource-history.test.ts (asserts v89-to-v90 data preservation, desktop IDs surviving reopening, local-chat deletion, timestamp replacement, per-conversation retention and chronological reads).
- [x] 3.2 Add activity-driven recording with safe lifecycle behavior; verify closing-zero, overlap, errors, stop and deletion-race assertions.
  - Evidence: server/modules/terminals/runtime/mission-resource-history.ts, server/modules/terminals/domain/mission-resources.ts, server/modules/terminals/runtime/mission-resource-history.test.ts (asserts continued draining after a turn, one closing zero, idle suppression, unavailable metering, non-overlapping ticks, idempotent timers, no store access after stop and no resurrection after deletion).
- [x] 3.3 Bind the recorder to project lifecycle and both conversation stores; verify desktop/local project recording and stop assertions.
  - Evidence: server/project-registry.ts, server/project-router-mission-resources.ts, server/project-router-mission-resources.test.ts (asserts recording a desktop mission without a local chat row alongside a local chat, isolation from a second project and no samples after recorder stop; registry teardown wiring has no dedicated changed test).
- [x] 3.4 Connect permanent-deletion cleanup across open projects; verify trash, restore, permanent-delete and expired-trash failure behavior.
  - Evidence: server/index.ts, server/modules/missions/runtime/agent-chat-router.ts, server/modules/missions/runtime/agent-chat-trash.test.ts (asserts preservation through trash/restore, cleanup callback removing only the deleted mission across two stores, expired-trash callback and logged cleanup failure without reversing deletion; composition iteration itself has no dedicated changed test).
- [x] 3.5 Sweep orphan history at project open; verify preservation of moved missions, trash and samples on existence-query failure.
  - Evidence: server/project-router-mission-resources.ts, server/modules/terminals/runtime/mission-resource-history.ts, server/project-router-mission-resources.test.ts, server/modules/terminals/runtime/mission-resource-history.test.ts (asserts orphan removal, retained local/moved/trashed conversation IDs, idempotent deletion and no prune writes when an existence lookup throws).
- [x] 3.6 Document collection, retention and cleanup; verify module guides match the observed lifecycle.
  - Evidence: server/modules/terminals/README.md, server/modules/missions/README.md (no automated documentation test evidence).

## 4. Mission resource and process presentation

- [x] 4.1 Add the shared non-modal popover; verify hover, delayed closing, pointer transfer and click behavior.
  - Evidence: client/src/components/ui/hover-popover.tsx, client/src/components/ui/__tests__/hover-popover.test.tsx (asserts hover/click/focus opening, closing after pointer departure, remaining open on pointer transfer, forward-Tab access to a panel control and closing after focus leaves both surfaces).
- [x] 4.2 Add the compact Processes panel and composer popover entry; verify ordering, selection and full-history draft preservation.
  - Evidence: client/src/features/background/components/BackgroundProcessesPanel.tsx, client/src/features/missions/components/AgentComposer.tsx, client/src/features/background/components/__tests__/BackgroundProcessesPanel.test.tsx, client/src/features/missions/components/__tests__/agent-chat.test.tsx (asserts mount refresh, unfinished-first rows, selected process, View all navigation, empty state and unsent draft preserved without sending a message).
- [x] 4.3 Add explicit project/chat resource API requests and open-view polling; verify the delivered API/hook code has abort and current-key guards.
  - Evidence: client/src/features/background/lib/mission-resources-api.ts, client/src/features/background/hooks/useMissionResourceHistory.ts, client/src/features/missions/components/AgentComposer.tsx, client/src/features/background/hooks/__tests__/useMissionResourceHistory.test.ts (asserts immediate fetch, three-second cadence, close/reopen, unmount abort, ignored delayed closed/project/chat responses and request failure/recovery; API response validation has no dedicated test evidence).
- [x] 4.4 Render live totals, memory-ordered roots and read-only disk controls; verify panel assertions.
  - Evidence: client/src/features/background/components/MissionResourcesPanel.tsx, client/src/features/background/components/__tests__/MissionResourcesPanel.test.tsx (asserts totals, heaviest-first rows, not-scanned state, absence of destructive/Refresh buttons, scan scope/callback and unsupported-metering state).
- [x] 4.5 Add retained-history summaries and separate CPU/memory charts; verify last-active, peak, range and empty-state assertions.
  - Evidence: client/src/features/background/lib/mission-resource-history.ts, client/src/features/background/lib/__tests__/mission-resource-history.test.ts, client/src/features/background/components/MissionResourcesPanel.tsx, client/src/features/background/components/__tests__/MissionResourcesPanel.test.tsx (asserts last active sample, CPU/memory peaks, completed totals, range and empty history; Recharts is mocked, so tooltip content and chart rendering have no direct test evidence).
- [x] 4.6 Add resource and View all labels in every locale; verify all eight changed locale artifacts contain the keys.
  - Evidence: client/src/locales/de/agent.json, client/src/locales/en/agent.json, client/src/locales/es/agent.json, client/src/locales/fr/agent.json, client/src/locales/it/agent.json, client/src/locales/ja/agent.json, client/src/locales/pt/agent.json, client/src/locales/zh/agent.json (no dedicated translation completeness or language-quality test evidence; panel tests exercise English labels).
- [x] 4.7 Document frontend history ownership and expose focused feature entry points; verify README/manifest entries.
  - Evidence: client/src/features/background/README.md, client/src/features/boundaries.json (no dedicated changed test evidence; existing npm run audit:architecture checks the reviewed client boundaries).

## 5. Architecture integration

- [x] 5.1 Declare terminals public subpaths and protect the pure resource model; verify the architecture guard includes the new domain allowlist.
  - Evidence: server/modules/boundaries.json, server/modules/architecture.test.ts (asserts reviewed dependency manifests and the resource domain's empty dependency allowlist).
- [x] 5.2 Update the generated source map for added source files and nearest tests; verify the delivered index entries.
  - Evidence: docs/internals/source-map.md (no dedicated test evidence; source-map entries link the new files and adjacent suites).

## 6. Composed-router regression compatibility

- [x] 6.1 Extend the ticket-cost suite's child_process mock with execFile; verify the existing ticket accounting cases can import the composed router and exercise their assertions.
  - Evidence: server/project-router-tickets-cost.test.ts, server/modules/terminals/runtime/resource-sampler.ts (existing suite asserts native-cost success, estimated-cost failure, successful max-turns salvage and empty-output failure; this correction adds the missing mock export, with no new assertion or test case and no successful rerun claimed).
- [x] 6.2 Extend the Codex suite's child_process mock with execFile; verify the existing model propagation and tool-policy cases can import the composed router.
  - Evidence: server/project-router.codex.test.ts, server/modules/terminals/runtime/resource-sampler.ts (existing suite asserts the configured Codex model for generation/edit and Kimi policy refusal before spawning; this correction adds the missing mock export, with no new assertion or test case and no successful rerun claimed).
- [x] 6.3 Extend the Gemini suite's child_process mock with execFile; verify the existing assistant-stream regression can import the composed router.
  - Evidence: server/project-router.gemini.test.ts, server/modules/terminals/runtime/resource-sampler.ts (existing test asserts streamed assistant text and Gemini executable/model selection; this correction adds the missing mock export, with no new assertion or test case and no successful rerun claimed).

## 7. Mission isolation and behavioral regression coverage

- [x] 7.1 Replace shared-host attribution with mission-marker provider matching; verify the tagged two-mission regression.
  - Evidence: server/modules/missions/runtime/mission-core-sessions.ts, server/modules/missions/runtime/agent-chat-manager.ts, server/modules/missions/runtime/mission-core-sessions.test.ts (asserts root 101 for the first mission, root 201 for the second, exclusion of host 100 and a capability filename suffix, and no match for a host-only table).
- [x] 7.2 Guard live reads and recording with current desktop project ownership; verify cross-project and in-flight repinning regressions.
  - Evidence: server/project-router-mission-resources.ts, server/project-router-mission-resources.test.ts (asserts p1's mission has zero live entries through p2, attribution changes after repinning, and a pending old-project measurement neither appends a sample nor continues draining; previously saved history remains).
- [x] 7.3 Add tagged resource hook behavior tests; verify open, cadence, cancellation, scope switching and recovery assertions.
  - Evidence: client/src/features/background/hooks/__tests__/useMissionResourceHistory.test.ts, client/src/features/background/hooks/useMissionResourceHistory.ts (asserts no request while closed, immediate fetch, 2999/3000 ms boundary, refresh on reopen, aborted signals on close/unmount, delayed-response suppression for close/project/chat switches, and recovery on the next poll).
- [x] 7.4 Add keyboard traversal into the popover and tagged access regression; verify focus stays in the panel until moved outside.
  - Evidence: client/src/components/ui/hover-popover.tsx, client/src/components/ui/__tests__/hover-popover.test.tsx (asserts focus opens the panel, forward Tab focuses Scan disk, the panel remains visible with focus inside, and external focus closes it).
- [x] 7.5 Add tagged deferred disk-scan lifecycle regression; verify pending sharing, failure and rescanning.
  - Evidence: server/modules/terminals/runtime/resource-sampler.test.ts, server/modules/terminals/runtime/resource-sampler.ts (asserts initial not-scanned state without I/O, immediate shared scanning state and one invocation, rejection with error/time, successful retry, completed-result rescan and a separate project's untouched cache).
- [x] 7.6 Correct the terminals guide's attribution description; verify it documents both descendant and worktree-command paths and excludes the shared Core host.
  - Evidence: server/modules/terminals/README.md (no automated documentation test evidence; text agrees with server/project-router-mission-resources.ts and server/modules/missions/runtime/mission-core-sessions.ts).
- [x] 7.7 Tag existing behavioral tests with their exact resource/history requirement identities; verify the changed test titles.
  - Evidence: client/src/features/background/components/__tests__/MissionResourcesPanel.test.tsx, client/src/features/background/lib/__tests__/mission-resource-history.test.ts, client/src/features/background/components/__tests__/BackgroundProcessesPanel.test.tsx, client/src/features/missions/components/__tests__/agent-chat.test.tsx, server/modules/terminals/domain/mission-resources.test.ts, server/modules/terminals/runtime/resource-sampler.test.ts, server/modules/terminals/runtime/mission-resource-history.test.ts, server/modules/missions/runtime/agent-chat-manager.test.ts, server/modules/missions/runtime/agent-chat-trash.test.ts, server/project-router-mission-resources.test.ts (existing assertions now identify read-only inspection, completed-history readability, process discovery, platform sampling, bounded recording, deletion cleanup, recorder safety and process-history discoverability; tags do not add assertions).
