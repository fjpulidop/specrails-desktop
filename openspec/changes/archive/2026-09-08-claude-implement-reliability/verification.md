# Claude implementation reliability: evidence and verification

## Supplied failure

Evidence source: the user's pasted Implement log attached as `9e61ccca-9e81-42cb-91c5-946ce4f70f1a/pasted-text.txt`. It describes one shared specialty-filter spec with Front and Back worktrees. The reported application repositories were not inspected or modified for this evidence record.

SHA-256 of the source: `e4255e19bb70b56cc9ae37151aea5b5e27274b9ffdd82381417b47e80d36554f`. Key source lines: 35–39 (skill failure and task teardown), 61–96 (missing implementation and baseline verification), 103–120 (continue decision and contradictory refinement branches), 140–143 (repair begins; no final outcome is present).

| Observation in the log | Consequence | Corrective contract |
| --- | --- | --- |
| The architect reports `opsx:ff` unavailable because the containing plugin is not installed or enabled. The outer agent copies skills into the artifact repository and changes the invoked identifier. | Pipeline setup depends on user plugin state and injects unrelated setup files into the worktree. | Register the required official OpenSpec skills in the managed Claude session before invocation. |
| After the parent says the architect is still working, Step 1 completes and Specrails warns that one background task will be terminated with its output unavailable. | Step 2 starts before the design and implementation pipeline has finished. | Preserve the child/session and request bounded foreground continuation while delegated work remains pending. |
| Step 2 reports unchanged Front and Back worktrees, missing OpenSpec change and feature implementation, but passing baseline suites. | Passing existing checks does not prove the requested feature is delivered. | Verify implementation and acceptance criteria across all selected repositories as well as project checks. |
| The decider correctly continues after FAIL, but the repair prompt's FAIL branch allows only fixing failing tests/type-check/lint/build; missing feature work is described only under PASS. | The prompt contradicts the actual missing-implementation failure and leaves recovery dependent on the model ignoring that branch. | Route repair by the observed gap, including absent implementation under FAIL. |

The supplied log ends while Step 4 begins backend implementation. It does **not** establish whether that later repair finished, passed verification, or produced an accepted delivery.

## Source diagnosis before correction

- `server/interactive-job-session.ts`: `_trackBackgroundTasks` tracks the Claude roster, but the auto-settle branch calls `_noteOrphanedBackgroundTasks()` followed by `_finalizeQuiescent()`. The warning acknowledges task loss instead of preventing premature completion.
- `server/loop-command-catalog.ts`: the generic verify prompt requests tooling checks without explicitly requiring evidence of implementation; the generic fix prompt associates missing feature work with a PASS verdict and restricts FAIL to failing checks.
- `server/loop-factory.ts` and `server/loop-templates.ts`: factory/lifecycle goals need to state conditions to prove, including implementation scope, instead of presupposing a verification outcome.
- Managed Claude skill availability is being traced and corrected separately against official application-owned assets. The log's statement about the user's global plugin configuration is reported evidence, not an independent inspection of that configuration.

## Final validation — 2026-09-06

All twelve implementation and verification tasks are complete. No paid Claude invocation, replay of the supplied run, or mutation of the reported application repositories was performed.

| Area | Evidence | Result |
| --- | --- | --- |
| Session lifecycle | Pending architect retains the same child; the next loop node waits; task roster completion, same-chunk updates, duplicate and notification results, usage accounting, provider failures, idle timeout, delayed SIGTERM/Stop race, and bounded recovery | PASS |
| Ambient tasks and fallback | Only non-ambient activity blocks completion; a one-shot child exiting with unfinished activity is failed; explicit ambient watchers do not cause continuation | PASS |
| Managed skill registration | CLI 2.1.261 control initialization registers all ten exact `opsx:*` commands, including `opsx:ff`, with `project,local` settings and a second plugin; no user prompt sent | PASS; zero model requests |
| Packaging and preparation | Embedded official command assets plus MIT notice; independent esbuild runtime works without project command directories or the Core plugin checkout; tsc copies the JSON asset; corrupt/missing/unexpected/symlinked cache fails before spawn | PASS |
| Verification and refinement | Implement, Batch and Freestyle fixture runs reject green baseline/missing implementation even when the mocked decider incorrectly stops, execute repair, and require fresh PASS | PASS |
| Frozen scope | All batch descriptions and per-ticket repository IDs reach verification/repair; mutation of the caller's spec after launch does not change the run; spec-free authored check loops remain supported | PASS |
| Selected regression suite | Thirty suites covering sessions, queue, loop engine/catalog/graphs, spawn/runtime plugin, Claude adapters/live transport, mission steering/MCP configuration, Explore/chat and result accounting | **1,031 tests passed** |
| Type checks | `npm run typecheck` (server, CLI, MCP bridge and client) | PASS |
| Build | `npm run build` (server, client and CLI) | PASS; existing non-blocking Vite chunk-size advisory |
| Core compatibility | `node --import tsx scripts/check-core-compat.ts` | PASS: Core 4.11.1 / Desktop 2.40.0 |
| Spec consistency | `OPENSPEC_TELEMETRY=0 openspec validate claude-implement-reliability --strict`; `git diff --check` | PASS |

The selected regression command was:

```sh
npx vitest run server/interactive-job-session.test.ts server/loop-run-manager.test.ts server/queue-manager.test.ts server/loop-executors.test.ts server/loop-executors.interactive.test.ts server/loop-command-catalog.test.ts server/loop-factory.test.ts server/loop-graph.test.ts server/loop-implementation-recovery.test.ts server/loop-templates.test.ts server/loop-constants.test.ts server/opsx-lifecycle-loop.test.ts server/loop-decider.test.ts server/loop-runs-store.test.ts server/loop-step-idle.test.ts server/loop-executors-state.test.ts server/openspec-runtime-plugin.test.ts server/providers/claude-adapter.test.ts server/util/cli-prompt.test.ts server/providers/runtime.test.ts server/spawn-lifecycle.test.ts server/agent-chat-manager.test.ts server/agent-live-steering.test.ts server/agent-native-transports.test.ts server/agent-native-steering.test.ts server/agent-mcp-config.test.ts server/providers/claude-live-session.test.ts server/explore-stdin-session.test.ts server/chat-manager.test.ts server/result-event.test.ts
```

Local evidence: `/tmp/specrails-claude-implement-final-tests.log`, `/tmp/specrails-implement-typecheck.log`, `/tmp/specrails-claude-implement-build.log`, `/tmp/specrails-claude-implement-core-compat.log`, and `/tmp/specrails-opsx-plugin-smoke-report.json`. The smoke used an isolated local endpoint, made one non-model HTTP request, sent zero user messages, and left its temporary project empty. Temporary provider sessions were closed. The normal `tsx` compatibility command initially hit the sandbox IPC-socket restriction; the equivalent `node --import tsx` command completed successfully.

Implementation details: maximum three collection turns per unfinished cohort and twelve total per step; normal timeout/idle/Stop controls remain active. The packaged runtime normalizes only command frontmatter names because Claude plugin command names otherwise become `opsx:OPSX: Fast Forward`, which does not satisfy `opsx:ff`. Existing plugin directories and model/effort/MCP arguments are preserved.

## Limits of the evidence

Deterministic protocol and prompt tests can prove the host's lifecycle and instruction contracts. They do not prove that every future provider response, external test service, or requested feature will succeed. The historical run remains unchanged and is not automatically replayed.
