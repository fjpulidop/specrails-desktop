# Verification report: multi-repo-projects

Branch: `codex/multi-repo-projects`, based on `origin/main` at `447f75d1`.

## Summary

| Dimension | Result |
|---|---|
| Completeness | 26/26 tasks complete; all 11 requirements mapped below |
| Correctness | Requirement scenarios covered by regression tests and the interface smoke test |
| Coherence | Stable primary identity, shared backlog, immutable manifests and grouped delivery follow the design |

No critical implementation issues remain from this audit. Validation boundaries are recorded below.

## Requirement evidence

| Requirements | Implementation | Verification |
|---|---|---|
| Stable membership; safe management; availability and resolution | `server/desktop-db.ts`, `project-repositories.ts`, `project-registry.ts`, `desktop-router.ts` | Migration, canonical paths, duplicate/overlap rejection, shared membership, atomic registration, live context refresh and reference guards in the corresponding server tests |
| Shared spec scope; preservation through authoring and integrations | `server/ticket-store.ts`, `project-router-tickets.ts`, `spec-draft-parser.ts`, Jira materializer, Blueprint parser, Smash runner | `ticket-repository-scope.test.ts`, parser/authoring/Jira/Smash/Blueprint tests; client draft round trips and missing-member repair |
| Repository code identity; mission discovery | Scoped Code/Git routes, repository provenance migration, MCP code/context/projects/jobs tools, agent context resolver | `project-repository-code.test.ts`, MCP tests, `agent-context-resolver.test.ts`; CodePage, FileViewer, AgentGitBar and reference tests, including identical relative paths and late responses |
| Frozen coordinated execution; compatible isolation | `multi-repo-execution.ts`, `rail-isolated-launch.ts`, `loop-run-manager.ts`, provider adapters, canonical repo locks | `multi-repo-execution.test.ts` uses independent temporary Git repositories and exercises allocation failure, one coordinator, secondary-only progress, shell routing, standalone runs, revisions, partial integration and restart |
| Grouped delivery and shared completion | `multi-repo-delivery.ts`, `multi-repo-checkout.ts`, execution store, delivery ledger/decision/recovery | Real Git integration tests cover retry after partial success, frozen paths, SHA guards, outbox atomicity and checkout ownership; route tests prove parent snapshot/child evidence authority |
| Explicit shell repository | `assertLoopShellRepositoryScope`, manifest validation and shell executor routing | Manager, isolated-launch and routing tests reject foreign or ambiguous targets before provider execution; legacy primary launches also reject a secondary-bound shell |

## Integration checks

The full suites use two workers and retain every configured test, threshold and coverage exclusion.

| Suite | Files | Tests | Lines | Branches | Functions | Result |
|---|---:|---:|---:|---:|---:|---|
| Server, CLI and MCP bridge | 298 | 7,723 | 88.67% | 78.70% | 90.26% | All tests and configured coverage gates passed |
| Client | 367 | 4,576 | 89.44% | 83.52% | 75.34% | All tests and configured coverage gates passed |

Total: 12,299 tests passed. Commands: `npx vitest run --coverage --maxWorkers=2 --reporter=dot` from the repository root and from `client/`.

- `npm run typecheck`: server, CLI, MCP bridge and client checked.
- `node --import tsx scripts/check-core-compat.ts`: compatibility check passed. Direct Node loading avoids the sandbox's restriction on the `tsx` launcher's temporary IPC socket.
- `npm run build`: server, client and CLI build passed. Vite reports its existing large-chunk advisory.
- `openspec validate multi-repo-projects --strict`: passed.
- `git diff --check`: passed.

## Interface smoke test

Real React components were mounted with temporary project/API fixtures in a localhost Vite harness. Chromium ran with an ephemeral profile at 1440×960 and 900×700, device scale factor 2. The temporary harness was removed afterwards.

Verified in Spanish:

- Existing-project repository list distinguishes the primary, secondary Git repo and context-only folder.
- Multi-folder project dialog fits a smaller window and exposes additional path inputs.
- Spec selector allows the backend alone and disables a context-only folder as an implementation target.
- Code selector loads the backend's `src/index.ts` through its repository-scoped route and switches repository identity correctly.
- Grouped delivery keeps an accepted frontend read-only and confirms the backend's actual `main` integration destination.
- No browser page errors occurred.

UI regressions also cover A→B→A repository switching, ignoring late action responses, dropping stale confirmations, and clearing an unsaved editor draft when a membership moves to a different folder with the same ID.

## Practical limits

Tests use temporary repositories and databases. No live user database, Jira transition, paid provider invocation or external PR was used. The visual smoke test covers the web implementation; the native folder picker uses the existing Tauri dialog integration.

Git has no atomic transaction across independent repositories. Accepted child outcomes are durable and retries skip those outcomes. Codex uses `workspace-write` with the selected writable roots. Claude, Gemini and Kimi retain their native autonomous modes with additional working directories; worktree isolation and a frozen execution manifest do not constitute an operating-system sandbox for those providers.

The change remains unarchived for review and continued work on this branch.
