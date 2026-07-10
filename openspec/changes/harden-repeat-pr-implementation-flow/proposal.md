## Why

A successful implementation can currently be presented as an implementation failure when commit verification, branch reconciliation, or follow-up delivery fails after the loop has already completed. This is especially confusing on a second iteration of an existing pull request: the log says success while the only card action is to discard, hiding the real recovery path and eroding trust in the workflow.

## What Changes

- Preserve the implementation outcome independently from the post-run delivery outcome for every isolated launch.
- Classify successful runs with no new commit, unsafe/unverified local results, and follow-up push failures truthfully instead of collapsing them into `implementation_failed`.
- Persist a stable outcome/reason contract so refreshes, restarts, dashboard strips, and agent-chat cards render the same explanation and actions.
- Make an existing-PR follow-up retryable whenever delivery can safely be retried, while keeping unsafe branch/ref mismatches fail-closed.
- Give both implementation-card surfaces concise, actionable states with access to the existing PR and run logs, including partial success and no-change outcomes.
- Give fresh no-change results separate Mark done and Refine outcomes, using a truthful terminal completion state rather than overloading merged/discarded.
- Reconcile stranded `building` rows from durable run outcomes without overwriting successful implementations with a false failure.
- Enforce one active delivery generation per rail and supersede the prior generation atomically when an existing PR is iterated again.
- Serialize decision-side Git/GitHub effects before they start, make draft-PR creation discover an already-created PR, and represent a PR closed without merge explicitly.
- Preserve dirty or unverifiable worktrees for explicit recovery, report cleanup warnings honestly, and never force-remove recoverable work as automatic failure cleanup.
- Return the authoritative post-action snapshot so a dropped WebSocket event cannot leave either card stale.
- Update the Safe PR lifecycle documentation and add backend/client regression coverage for repeated implementation and recovery corner cases.

## Capabilities

### New Capabilities

- `implementation-delivery-lifecycle`: Truthful, durable classification and premium recovery UX for implementation results and their subsequent PR delivery, including repeated work on an existing PR.

### Modified Capabilities

- `rail-parallel-isolation`: Isolated-run settlement must preserve the actual loop outcome separately from commit/ref/push delivery checks and recover it safely after interruption.

## Impact

- Server: isolated launch settlement, PR-delivery ledger and migration, restart reconciliation, WebSocket/card payloads, and PR retry behavior.
- Client: shared delivery types, dashboard PR strip, agent-chat implementation card, pinning/status presentation, and localized copy.
- Tests/docs: state-machine, persistence/recovery, repeated-PR, accessibility/action, localization, and internal Safe PR workflow documentation.
- No external API endpoint is removed; additive snapshot fields are backward-compatible for existing clients.
